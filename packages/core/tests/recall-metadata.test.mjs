import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';
import { Retriever } from '../dist/retrieval/retriever-v4.js';

function makeTempPaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const ram = path.join(root, 'ram-db');
  const ssd = path.join(root, 'ssd-db');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ram, { recursive: true });
  fs.mkdirSync(ssd, { recursive: true });
  return { root, home, ram, ssd };
}

async function withTempStore(prefix, fn) {
  const paths = makeTempPaths(prefix);
  const oldHome = process.env.HOME;
  process.env.HOME = paths.home;

  const store = new MemoryStore(paths.ssd, paths.ram, 4, undefined, {
    embed: async () => [0, 0, 0, 0],
  });

  try {
    await store.ensureInitialized();
    await fn({ store });
  } finally {
    await store.shutdown?.().catch?.(() => {});
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    try {
      fs.rmSync(paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${paths.root}:`, error?.code ?? error);
    }
  }
}

test('recordMemoryRecalls updates lastRecalledAt and increments recallCount', async () => {
  await withTempStore('recall-metadata-', async ({ store }) => {
    const stored = await store.store({
      text: 'recall metadata test',
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 0.5,
      category: 'fact',
      parentId: null,
      metadata: JSON.stringify({ source: 'test' }),
    });

    await store.recordMemoryRecalls([stored], 1000);
    const once = await store.getById(stored.id);
    assert.ok(once);
    const onceMeta = JSON.parse(once.metadata);
    assert.equal(onceMeta.lastRecalledAt, 1000);
    assert.equal(onceMeta.recallCount, 1);

    await store.recordMemoryRecalls([once], 2000);
    const twice = await store.getById(stored.id);
    assert.ok(twice);
    const twiceMeta = JSON.parse(twice.metadata);
    assert.equal(twiceMeta.lastRecalledAt, 2000);
    assert.equal(twiceMeta.recallCount, 2);

    const stats = await store.getRecallStats(stored.id);
    assert.ok(stats);
    assert.equal(stats.lastRecalledAt, 2000);
    assert.equal(stats.recallCount, 2);
    assert.equal(typeof stats.ageInDays, 'number');
    assert.equal(typeof stats.dormancyInDays, 'number');
  });
});

test('Retriever records recall metadata only for final returned results', async () => {
  const returnedId = '11111111-1111-4111-8111-111111111111';
  const filteredOutId = '22222222-2222-4222-8222-222222222222';
  const recorded = [];

  const fakeStore = {
    hybridVectorSearch: async () => [
      {
        entry: {
          id: returnedId,
          text: 'high scoring memory',
          vector: [0, 0, 0, 0],
          importance: 0.8,
          category: 'fact',
          parentId: null,
          metadata: '{}',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        vectorScore: 0.03,
        rankScore: 0.03,
        rawDistance: 0.2,
        bm25Score: 0,
        fusedScore: 0,
      },
      {
        entry: {
          id: filteredOutId,
          text: 'candidate that should not be returned',
          vector: [0, 0, 0, 0],
          importance: 0.5,
          category: 'fact',
          parentId: null,
          metadata: '{}',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        vectorScore: 0.01,
        rankScore: 0.01,
        rawDistance: 0.4,
        bm25Score: 0,
        fusedScore: 0,
      },
    ],
    recordMemoryRecalls: async (entries) => {
      recorded.push(entries.map(entry => entry.id));
    },
    getById: async () => null,
    query: async () => [],
  };

  const retriever = new Retriever(
    fakeStore,
    { embed: async () => [0, 0, 0, 0] },
    { vectorWeight: 1, bm25Weight: 0, candidatePoolMultiplier: 2 },
    path.join(os.tmpdir(), 'memory-river-reranker-cache'),
  );
  retriever.cragEvaluate = async (_query, results) => results;

  const searchResponse = await retriever.hybridSearch('needle', 1);
  const results = searchResponse.results;

  assert.equal(results.length, 1);
  assert.equal(results[0].entry.id, returnedId);
  assert.deepEqual(recorded, [[returnedId]]);
});

test('Retriever keeps a zero healthScore as a zero health factor', async () => {
  const fakeStore = {
    hybridVectorSearch: async () => [{
      entry: {
        id: '33333333-3333-4333-8333-333333333333', text: 'unhealthy memory', vector: [0, 0, 0, 0],
        importance: 0.5, category: 'fact', parentId: null,
        metadata: JSON.stringify({ health: { healthScore: 0 }, abstractness: 0 }), createdAt: Date.now(), updatedAt: Date.now(),
      },
      vectorScore: 0.01, rankScore: 0.01, rawDistance: 0.2, bm25Score: 0, fusedScore: 0,
    }],
    recordMemoryRecalls: async () => {}, getById: async () => null, query: async () => [],
  };
  const retriever = new Retriever(
    fakeStore, { embed: async () => [0, 0, 0, 0] },
    { vectorWeight: 1, bm25Weight: 0, candidatePoolMultiplier: 1 },
    path.join(os.tmpdir(), 'memory-river-reranker-cache'),
  );
  retriever.cragEvaluate = async (_query, results) => results;

  const { results } = await retriever.hybridSearchWithoutBoost('needle', 1);

  assert.ok(Math.abs(results[0].finalScore - 0.45) < Number.EPSILON);
});
