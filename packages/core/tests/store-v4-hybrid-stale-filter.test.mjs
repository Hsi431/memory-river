import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';

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
    embed: async () => [0.1, 0.2, 0.3, 0.4],
  });

  try {
    await store.ensureInitialized();
    await fn({ store });
  } finally {
    await store.shutdown?.().catch?.(() => {});
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function storeMemory(store, text, metadata = '{}') {
  return await store.store({
    text,
    vector: [0.1, 0.2, 0.3, 0.4],
    importance: 0.8,
    category: 'fact',
    parentId: null,
    metadata,
  });
}

function makeCandidate(entry, overrides = {}) {
  return {
    entry,
    vectorScore: overrides.vectorScore ?? 0.8,
    rankScore: overrides.rankScore ?? 0.8,
    rawDistance: overrides.rawDistance ?? 0.25,
    bm25Score: overrides.bm25Score ?? 0,
    fusedScore: overrides.fusedScore ?? 0.8,
  };
}

function makeStaleEntry(id, metadata = '{}') {
  return {
    id,
    text: `stale ${id}`,
    textTokens: `stale ${id}`,
    vector: [0.1, 0.2, 0.3, 0.4],
    importance: 0.8,
    category: 'fact',
    parentId: null,
    metadata,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function stubHybridSources(store, vectorResults, ftsResults = []) {
  store.vectorSearch = async () => vectorResults;
  store.ftsAvailable = true;
  store.ftsSearch = async () => ftsResults;
}

test('hybridVectorSearch preserves the raw vector distance', async () => {
  await withTempStore('t7-hybrid-distance-', async ({ store }) => {
    const current = await storeMemory(store, 'distance consistency');
    const vectorResults = await store.vectorSearch([0.1, 0.2, 0.3, 0.4], 1);

    const hybridResults = await store.hybridVectorSearch('distance consistency', 1);

    assert.equal(vectorResults[0].entry.id, current.id);
    assert.equal(hybridResults[0].entry.id, current.id);
    assert.equal(hybridResults[0].rawDistance, vectorResults[0].rawDistance);
    assert.equal(hybridResults[0].rankScore, 1 / 61);
    assert.equal(hybridResults[0].vectorScore, hybridResults[0].rankScore);
    assert.equal(hybridResults[0].bm25Score, 1 / 61);
  });
});

test('hybridVectorSearch falls back to FTS when embedding throws', async () => {
  await withTempStore('hybrid-embedding-throws-', async ({ store }) => {
    const current = await storeMemory(store, 'embedding fallback result');
    const ftsResult = makeCandidate(current, {
      vectorScore: 0,
      rankScore: 0,
      rawDistance: Number.POSITIVE_INFINITY,
      bm25Score: 1,
      fusedScore: 0,
    });
    const warnings = [];
    const originalWarn = console.warn;
    let vectorSearchCalled = false;
    let ftsSearchLimit;
    store._embedder = {
      embed: async () => {
        throw new Error('embedding unavailable');
      },
    };
    store.vectorSearch = async () => {
      vectorSearchCalled = true;
      return [];
    };
    store.ftsAvailable = true;
    store.ftsSearch = async (_query, limit) => {
      ftsSearchLimit = limit;
      return [ftsResult];
    };
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      const results = await store.hybridVectorSearch('embedding fallback', 2);

      assert.deepEqual(results.map(result => result.entry.id), [current.id]);
      assert.equal(vectorSearchCalled, false);
      assert.equal(ftsSearchLimit, 4);
      assert.equal(warnings.length, 1);
      assert.equal(
        warnings.some(message => message.includes('Embedding failed; falling back to FTS')),
        true,
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('hybridVectorSearch keeps candidates that exist in current memories', async () => {
  await withTempStore('xr1-hybrid-current-', async ({ store }) => {
    const currentA = await storeMemory(store, 'current a');
    const currentB = await storeMemory(store, 'current b');
    stubHybridSources(store, [
      makeCandidate(currentA),
      makeCandidate(currentB),
    ]);

    const results = await store.hybridVectorSearch('query', 5);

    assert.deepEqual(results.map(result => result.entry.id), [currentA.id, currentB.id]);
  });
});

test('hybridVectorSearch returns no more results than its requested limit', async () => {
  await withTempStore('hybrid-limit-', async ({ store }) => {
    const entries = await Promise.all(['one', 'two', 'three'].map(text => storeMemory(store, text)));
    stubHybridSources(store, entries.map(makeCandidate));

    const results = await store.hybridVectorSearch('query', 2);

    assert.equal(results.length, 2);
  });
});

test('hybridVectorSearch filters one stale candidate and keeps current candidates', async () => {
  await withTempStore('xr1-hybrid-one-stale-', async ({ store }) => {
    const current = await storeMemory(store, 'current memory');
    const stale = makeStaleEntry('stale-row-1');
    stubHybridSources(store, [
      makeCandidate(stale),
      makeCandidate(current),
    ]);

    const results = await store.hybridVectorSearch('query', 5);

    assert.deepEqual(results.map(result => result.entry.id), [current.id]);
  });
});

test('hybridVectorSearch returns empty when all candidates are stale', async () => {
  await withTempStore('xr1-hybrid-all-stale-', async ({ store }) => {
    stubHybridSources(store, [
      makeCandidate(makeStaleEntry('stale-row-1')),
      makeCandidate(makeStaleEntry('stale-row-2')),
    ]);

    const results = await store.hybridVectorSearch('query', 5);

    assert.deepEqual(results, []);
  });
});

test('hybridVectorSearch returns early for empty fused results', async () => {
  await withTempStore('xr1-hybrid-empty-', async ({ store }) => {
    let queryCalled = false;
    const originalQuery = store.ramTable.query.bind(store.ramTable);
    store.ramTable.query = () => {
      queryCalled = true;
      return originalQuery();
    };
    stubHybridSources(store, []);

    const results = await store.hybridVectorSearch('query', 5);

    assert.deepEqual(results, []);
    assert.equal(queryCalled, false);
  });
});

test('hybridVectorSearch filters stale and deprecated candidates in the same pipeline', async () => {
  await withTempStore('xr1-hybrid-stale-deprecated-', async ({ store }) => {
    const current = await storeMemory(store, 'current memory');
    const deprecated = await storeMemory(
      store,
      'deprecated memory',
      JSON.stringify({ status: 'deprecated' }),
    );
    const stale = makeStaleEntry('stale-row-1');
    stubHybridSources(store, [
      makeCandidate(stale),
      makeCandidate(deprecated),
      makeCandidate(current),
    ]);

    const results = await store.hybridVectorSearch('query', 5);

    assert.deepEqual(results.map(result => result.entry.id), [current.id]);
  });
});

test('hybridVectorSearch fails open when stale existence lookup throws', async () => {
  await withTempStore('xr1-hybrid-fail-open-', async ({ store }) => {
    const current = await storeMemory(store, 'current memory');
    const stale = makeStaleEntry('stale-row-1');
    const warnings = [];
    const originalWarn = console.warn;
    const originalQuery = store.ramTable.query.bind(store.ramTable);
    console.warn = (...args) => warnings.push(args.join(' '));
    store.ramTable.query = () => {
      throw new Error('lookup failed');
    };
    stubHybridSources(store, [
      makeCandidate(stale),
      makeCandidate(current),
    ]);

    try {
      const results = await store.hybridVectorSearch('query', 5);

      assert.deepEqual(results.map(result => result.entry.id), [stale.id, current.id]);
      assert.equal(warnings.some(message => message.includes('[PR-XR-1]')), true);
    } finally {
      console.warn = originalWarn;
      store.ramTable.query = originalQuery;
    }
  });
});
