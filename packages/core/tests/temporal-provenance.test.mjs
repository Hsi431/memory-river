import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryRiverEngine } from '../dist/engine.js';
import { describeMemoryTemporalProvenance } from '../dist/retrieval/temporal-provenance.js';

function result(metadata, text = 'memory text') {
  return {
    entry: {
      id: 'temporal-memory',
      text,
      metadata,
      createdAt: 1780000000000,
    },
  };
}

test('date precision preserves the claimed date string without timezone conversion', () => {
  const provenance = describeMemoryTemporalProvenance({
    metadata: { when: { start: '2026-07-09', precision: 'date' } },
  });

  assert.equal(provenance.role, 'event_candidate');
  assert.equal(provenance.eventDate, '2026-07-09');
  assert.equal(provenance.label, '〔事件日期 2026-07-09〕');
  assert.deepEqual(provenance.claimed, { start: '2026-07-09', end: null, precision: 'date' });
});

test('range precision renders both claimed endpoints', () => {
  const provenance = describeMemoryTemporalProvenance({
    metadata: { when: { start: '2026-08-06', end: '2026-08-12', precision: 'range' } },
  });

  assert.equal(provenance.role, 'event_candidate');
  assert.equal(provenance.eventDate, '2026-08-06');
  assert.equal(provenance.eventEndDate, '2026-08-12');
  assert.equal(provenance.label, '〔事件期間 2026-08-06～2026-08-12〕');
});

test('datetime start equivalent to anchor is an observation without time of day in label', () => {
  const provenance = describeMemoryTemporalProvenance({
    metadata: {
      when: {
        start: '2026-08-21T02:00:00.000Z',
        anchor: '2026-08-21T02:00:30.000Z',
        precision: 'datetime',
      },
    },
  });

  assert.equal(provenance.role, 'observation');
  assert.equal(provenance.observedAt, '2026-08-21');
  assert.equal(provenance.label, '〔2026-08-21 的對話〕');
  assert.doesNotMatch(provenance.label, /T|\d{2}:\d{2}/);
});

test('datetime start one day from anchor is an event candidate', () => {
  const provenance = describeMemoryTemporalProvenance({
    metadata: {
      when: {
        start: '2026-08-12T00:00:00.000Z',
        anchor: '2026-08-13T00:00:00.000Z',
        precision: 'datetime',
      },
    },
  });

  assert.equal(provenance.role, 'event_candidate');
  assert.equal(provenance.eventDate, '2026-08-12');
  assert.equal(provenance.label, '〔事件日期 2026-08-12(候選)〕');
});

test('a two-hour batch without when is observed on firstTimestamp date', () => {
  const provenance = describeMemoryTemporalProvenance({
    metadata: {
      firstTimestamp: '2026-08-21T01:00:00.000Z',
      lastTimestamp: '2026-08-21T03:00:00.000Z',
    },
  });

  assert.equal(provenance.role, 'observation');
  assert.equal(provenance.observedAt, '2026-08-21');
  assert.equal(provenance.label, '〔2026-08-21 的對話〕');
});

test('a 48-day batch without when is unknown and has no label', () => {
  const provenance = describeMemoryTemporalProvenance({
    metadata: {
      firstTimestamp: '2026-07-01T00:00:00.000Z',
      lastTimestamp: '2026-08-18T00:00:00.000Z',
    },
  });

  assert.equal(provenance.role, 'unknown');
  assert.equal(provenance.label, null);
  assert.equal(provenance.eventDate, null);
  assert.equal(provenance.observedAt, null);
});

test('broken metadata JSON is treated as empty metadata', () => {
  assert.doesNotThrow(() => describeMemoryTemporalProvenance({ metadata: '{broken json' }));
  const provenance = describeMemoryTemporalProvenance({ metadata: '{broken json' });
  assert.equal(provenance.role, 'unknown');
  assert.equal(provenance.label, null);
});

test('createdAt is never used as a fallback label', () => {
  const provenance = describeMemoryTemporalProvenance({ createdAt: 1780000000000 });

  assert.equal(provenance.role, 'unknown');
  assert.equal(provenance.memoryCreatedAt, 1780000000000);
  assert.equal(provenance.label, null);
});

function makeEngine(results) {
  const store = {
    async hybridSkillCapsuleSearch() {
      return [];
    },
  };
  const retriever = {
    getStore: () => store,
    async hybridSearch() {
      return { results, hookOriginIds: [], hookOriginKeywords: {}, queryHash: 'temporal-query' };
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

test('core memory_recall renders the temporal label after the memory text', async () => {
  const engine = makeEngine([result({ when: { start: '2026-07-15', precision: 'date' } })]);
  const response = await engine.testHooks.executeMemoryRecall({ query: 'temporal query', limit: 5 });
  const text = response.content[0].text;

  assert.match(text, /memory text 〔事件日期 2026-07-15〕/);
  assert.match(text, /時間標籤為候選證據/);
});

test('autoRecall renders the temporal label after the memory text', async () => {
  const engine = makeEngine([result({ when: { start: '2026-08-12T00:00:00.000Z', anchor: '2026-08-13T00:00:00.000Z', precision: 'datetime' } })]);
  const response = await engine.assemble([{ role: 'user', content: 'temporal query' }]);
  const text = response.messages.map(message => String(message.content ?? '')).join('\n');

  assert.match(text, /memory text 〔事件日期 2026-08-12\(候選\)〕/);
  assert.match(text, /時間標籤為候選證據/);
});
