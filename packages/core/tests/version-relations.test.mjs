import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryRiverEngine } from '../dist/engine.js';
import { annotateVersionRelations } from '../dist/retrieval/version-relations.js';

function result(id, {
  parentId = null,
  slotKey,
  metadata = {},
  createdAt = 100,
  text = id,
} = {}) {
  return {
    entry: {
      id,
      text,
      vector: [],
      importance: 0.5,
      category: 'fact',
      parentId,
      ...(slotKey === undefined ? {} : { slotKey }),
      metadata: JSON.stringify(metadata),
      createdAt,
      updatedAt: createdAt,
    },
    vectorScore: 0,
    rankScore: 0,
    rawDistance: 0,
    bm25Score: 0,
    fusedScore: 0,
  };
}

test('same-group results annotate only the older version and preserve order and count', () => {
  const input = [
    result('old', { slotKey: 'person:team', metadata: { subject: 'James', lastTimestamp: 100 } }),
    result('new', { slotKey: 'person:team', metadata: { subject: 'James', lastTimestamp: 200 } }),
  ];

  const output = annotateVersionRelations(input);

  assert.deepEqual(output.map(item => item.entry.id), ['old', 'new']);
  assert.equal(output.length, input.length);
  assert.deepEqual(output[0].versionRelation, { isOlder: true, newerId: 'new' });
  assert.equal(output[1].versionRelation, undefined);
});

test('a result without a same-group peer gets no version relation', () => {
  const output = annotateVersionRelations([
    result('only', { slotKey: 'person:team', metadata: { subject: 'James', lastTimestamp: 100 } }),
  ]);

  assert.equal(output[0].versionRelation, undefined);
});

test('lineage wins when the child was imported earlier than its parent', () => {
  const output = annotateVersionRelations([
    result('parent', { createdAt: 200 }),
    result('child', { parentId: 'parent', createdAt: 100 }),
  ]);

  assert.deepEqual(output[0].versionRelation, { isOlder: true, newerId: 'child' });
  assert.equal(output[1].versionRelation, undefined);
});

test('same slot with different effective subjects is not one version group', () => {
  const output = annotateVersionRelations([
    result('james', { slotKey: 'person:team', metadata: { subject: 'James', lastTimestamp: 100 } }),
    result('john', { slotKey: 'person:team', metadata: { subject: 'John', lastTimestamp: 200 } }),
  ]);

  assert.equal(output[0].versionRelation, undefined);
  assert.equal(output[1].versionRelation, undefined);
});

test('same slot with a null effective subject is not one version group', () => {
  const output = annotateVersionRelations([
    result('known', { slotKey: 'person:team', metadata: { subject: 'James', lastTimestamp: 100 } }),
    result('unknown', { slotKey: 'person:team', metadata: { lastTimestamp: 200 } }),
  ]);

  assert.equal(output[0].versionRelation, undefined);
  assert.equal(output[1].versionRelation, undefined);
});

test('lineage wins over conflicting lastTimestamp values', () => {
  const output = annotateVersionRelations([
    result('parent', { createdAt: 100, metadata: { lastTimestamp: 200 } }),
    result('child', { parentId: 'parent', createdAt: 200, metadata: { lastTimestamp: 100 } }),
  ]);

  assert.deepEqual(output[0].versionRelation, { isOlder: true, newerId: 'child' });
  assert.equal(output[1].versionRelation, undefined);
});

test('metadata supersededBy and supersedes references establish lineage direction', () => {
  const output = annotateVersionRelations([
    result('old-by-reverse-ref', { metadata: { supersededBy: ['new-by-reverse-ref'] } }),
    result('new-by-reverse-ref'),
    result('old-by-forward-ref'),
    result('new-by-forward-ref', { metadata: { supersedes: ['old-by-forward-ref'] } }),
  ]);

  assert.deepEqual(output[0].versionRelation, { isOlder: true, newerId: 'new-by-reverse-ref' });
  assert.equal(output[1].versionRelation, undefined);
  assert.deepEqual(output[2].versionRelation, { isOlder: true, newerId: 'new-by-forward-ref' });
  assert.equal(output[3].versionRelation, undefined);
});

function makeEngine(results) {
  const store = {
    async hybridSkillCapsuleSearch() {
      return [];
    },
    async hybridVectorSearch() {
      return results;
    },
  };
  const retriever = {
    getStore: () => store,
    async hybridSearch() {
      return { results, hookOriginIds: [], hookOriginKeywords: {}, queryHash: 'version-query' };
    },
    async hybridSearchWithoutBoost() {
      throw new Error('unexpected fallback');
    },
  };
  const engine = new MemoryRiverEngine({}, {
    paths: {},
    transcriptArchive: {},
    deriveSessionFile: () => null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  });
  engine.pluginInitPromise = Promise.resolve();
  engine.isAutoRecallEnabled = true;
  engine.retrieverRef = retriever;
  engine.memoryStoreRef = store;
  return engine;
}

test('autoRecall renders the old result as history and explains the version label', async () => {
  const oldResult = result('old-memory', {
    slotKey: 'person:team',
    metadata: { subject: 'James', lastTimestamp: 100, when: { start: '2026-08-01', precision: 'date' } },
    text: 'old memory text',
  });
  const newResult = result('new-memory', {
    slotKey: 'person:team',
    metadata: { subject: 'James', lastTimestamp: 200 },
    text: 'new memory text',
  });
  const engine = makeEngine([oldResult, newResult]);

  const response = await engine.assemble([{ role: 'user', content: 'version query' }]);
  const text = response.messages.map(message => String(message.content ?? '')).join('\n');
  const oldLine = text.split('\n').find(line => line.includes('old memory text'));
  const newLine = text.split('\n').find(line => line.includes('new memory text'));

  assert.match(oldLine, /↳ 更早:old memory text 〔事件日期 2026-08-01〕/);
  assert.doesNotMatch(oldLine, /較舊版本/);
  assert.doesNotMatch(newLine, /較舊版本/);
  assert.match(text, /版本標籤表示這筆是同組中的較舊版本/);
});

test('recall returns the version relation as structured data', async () => {
  const engine = makeEngine([
    result('old-memory', { slotKey: 'person:team', metadata: { subject: 'James', lastTimestamp: 100 } }),
    result('new-memory', { slotKey: 'person:team', metadata: { subject: 'James', lastTimestamp: 200 } }),
  ]);

  const output = await engine.recall('version query', 5);

  assert.deepEqual(output[0].versionRelation, { isOlder: true, newerId: 'new-memory' });
  assert.equal(output[1].versionRelation, undefined);
});
