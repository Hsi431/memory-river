import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryRiverEngine } from '../dist/engine.js';

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

function makeEngine(results, { respectLimit = false } = {}) {
  const store = {
    async hybridSkillCapsuleSearch() {
      return [];
    },
    async recordMemoryRecalls() {},
  };
  const calls = [];
  const search = async (_query, limit) => {
    calls.push(limit);
    return {
      results: respectLimit ? results.slice(0, limit) : results,
      hookOriginIds: [],
      hookOriginKeywords: {},
      queryHash: 'auto-recall-query',
    };
  };
  const retriever = {
    getStore: () => store,
    hybridSearch: search,
    hybridSearchWithoutBoost: search,
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
  return { engine, calls };
}

function injectedText(response) {
  return response.messages
    .filter(message => message.role === 'system')
    .map(message => String(message.content ?? ''))
    .join('\n');
}

async function withEnv(values, fn) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('autoRecall formats continuous and disjoint sourceEntryIds as compact ranges', async () => {
  const { engine } = makeEngine([
    result('continuous', { metadata: { sourceEntryIds: Array.from({ length: 18 }, (_, index) => 336 + index) } }),
    result('disjoint', { metadata: { sourceEntryIds: [336, 337, 338, 348, 349, 350] } }),
  ]);

  const text = injectedText(await engine.assemble([{ role: 'user', content: 'range query' }]));

  assert.match(text, /\[來源turns 336-353\] continuous/);
  assert.match(text, /\[來源turns 336-338,348-350\] disjoint/);
});

test('autoRecall compression keeps five memories under 700 characters', async () => {
  const ids = Array.from({ length: 18 }, (_, index) => 336 + index);
  const sixtyCharacterBody = id => `${id}:${'x'.repeat(59 - id.length)}`;
  const memories = [
    result('old', {
      slotKey: 'person:team',
      metadata: { subject: 'James', lastTimestamp: 100, sourceEntryIds: ids },
      text: sixtyCharacterBody('old'),
    }),
    result('new', {
      slotKey: 'person:team',
      metadata: { subject: 'James', lastTimestamp: 200, sourceEntryIds: ids },
      text: sixtyCharacterBody('new'),
    }),
    result('third', { metadata: { sourceEntryIds: ids }, text: sixtyCharacterBody('third') }),
    result('fourth', { metadata: { sourceEntryIds: ids }, text: sixtyCharacterBody('fourth') }),
    result('fifth', { metadata: { sourceEntryIds: ids }, text: sixtyCharacterBody('fifth') }),
  ];

  await withEnv({ MR_AUTORECALL_VERSION_MERGE: '0', MR_AUTORECALL_OVERFETCH: '0' }, async () => {
    const { engine } = makeEngine(memories);
    const compressed = injectedText(await engine.assemble([{ role: 'user', content: 'compression query' }]));
    const oldHeader = '[記憶為候選證據，未必相關或足夠；不足時優先用其 sourceEntryIds 做 entry_ids rehydrate，召回空泛時改用問題中的具體實體 keyword，確認原文支持再回答]';
    const oldTimeHeader = '[時間標籤為候選證據，`事件日期` 是記憶宣稱的事件時間、`的對話` 是這段話被講出來的日期；沒有標籤代表時間不明。]';
    const oldVersionHeader = '[版本標籤表示這筆是同組中的較舊版本，且更新版也在本次結果中；沒有標籤代表未判定有較新版本。]';
    const legacy = [
      '[相關記憶]:',
      oldHeader,
      oldTimeHeader,
      oldVersionHeader,
      ...memories.map((memory, index) => (
        `• [來源turns entryIds=${JSON.stringify(ids)}｜需要精確細節時可用 memory_rehydrate mode='entry_ids'] `
        + memory.entry.text
        + (index === 0 ? ' 〔較舊版本；本次結果中有更新的一筆〕' : '')
      )),
    ].join('\n');

    console.log(`A compression chars: before=${legacy.length} after=${compressed.length}`);
    assert.ok(compressed.length < legacy.length);
    assert.ok(compressed.length < 700, `compressed injection was ${compressed.length} characters`);
    assert.match(compressed, /\[來源turns 336-353\]/);
    assert.doesNotMatch(compressed, /entryIds=\[/);
  });
});

test('autoRecall overfetches before merging and fills the freed sixth slot', async () => {
  const memories = [
    result('old', { slotKey: 'person:team', metadata: { subject: 'James', lastTimestamp: 100 }, text: 'old version memory' }),
    result('new', { slotKey: 'person:team', metadata: { subject: 'James', lastTimestamp: 200 }, text: 'new version memory' }),
    result('third', { text: 'third independent memory' }),
    result('fourth', { text: 'fourth independent memory' }),
    result('fifth', { text: 'fifth independent memory' }),
    result('sixth', { text: 'sixth independent memory' }),
  ];

  await withEnv({ MR_AUTORECALL_K: '5', MR_AUTORECALL_VERSION_MERGE: '1' }, async () => {
    const { engine, calls } = makeEngine(memories, { respectLimit: true });
    let observedResults;
    const response = await engine.assemble(
      [{ role: 'user', content: 'overfetch query' }],
      { onAutoRecallResults: event => { observedResults = event.results; } },
    );
    const text = injectedText(response);

    assert.equal(calls[0], 8);
    assert.equal(observedResults.length, 5);
    assert.equal((text.match(/^• /gm) ?? []).length, 5);
    assert.match(text, /sixth independent memory/);
  });
});

test('autoRecall renders three versions as a primary plus two history lines', async () => {
  const memories = [1, 2, 3].map(version => result(`v${version}`, {
    slotKey: 'person:team',
    metadata: { subject: 'James', lastTimestamp: version * 100, sourceEntryIds: [version * 10, version * 10 + 1] },
    text: `version ${version} memory`,
  }));
  const { engine } = makeEngine(memories);

  const text = injectedText(await engine.assemble([{ role: 'user', content: 'three versions query' }]));
  const memoryLines = text.split('\n').filter(line => line.startsWith('• ') || line.includes('↳ 更早:'));

  assert.match(text, /• \[來源turns 30-31\] version 3 memory/);
  assert.match(text, /↳ 更早:\[來源turns 20-21\] version 2 memory/);
  assert.match(text, /↳ 更早:\[來源turns 10-11\] version 1 memory/);
  assert.equal(memoryLines.length, 3);
  assert.doesNotMatch(text, /另有/);
  assert.doesNotMatch(memoryLines.join('\n'), /較舊版本/);
});

test('autoRecall truncates five-version history to two and reports the omitted count', async () => {
  const memories = [1, 2, 3, 4, 5].map(version => result(`v${version}`, {
    slotKey: 'person:team',
    metadata: { subject: 'James', lastTimestamp: version * 100, sourceEntryIds: [version * 10, version * 10 + 1] },
    text: `version ${version} memory`,
  }));
  const { engine } = makeEngine(memories);

  const text = injectedText(await engine.assemble([{ role: 'user', content: 'five versions query' }]));

  assert.match(text, /• \[來源turns 50-51\] version 5 memory/);
  assert.match(text, /↳ 更早:\[來源turns 40-41\] version 4 memory/);
  assert.match(text, /↳ 更早:\[來源turns 30-31\] version 3 memory/);
  assert.match(text, /↳ 另有 2 筆更早的版本/);
  assert.doesNotMatch(text, /version 1 memory/);
  assert.doesNotMatch(text, /version 2 memory/);
});

test('autoRecall version merge switch off preserves one line per result', async () => {
  const memories = [
    result('old', { slotKey: 'person:team', metadata: { subject: 'James', lastTimestamp: 100, sourceEntryIds: [1, 2] }, text: 'old version memory' }),
    result('new', { slotKey: 'person:team', metadata: { subject: 'James', lastTimestamp: 200, sourceEntryIds: [3, 4] }, text: 'new version memory' }),
    result('other', { metadata: { sourceEntryIds: [5, 6] }, text: 'other independent memory' }),
  ];

  await withEnv({ MR_AUTORECALL_VERSION_MERGE: '0' }, async () => {
    const { engine, calls } = makeEngine(memories);
    const text = injectedText(await engine.assemble([{ role: 'user', content: 'switch query' }]));

    assert.equal(calls[0], 5);
    assert.equal((text.match(/^• /gm) ?? []).length, 3);
    assert.match(text, /• \[來源turns 1-2\] old version memory .*較舊版本/);
    assert.match(text, /• \[來源turns 3-4\] new version memory/);
    assert.match(text, /• \[來源turns 5-6\] other independent memory/);
    assert.doesNotMatch(text, /↳ 更早:/);
  });
});
