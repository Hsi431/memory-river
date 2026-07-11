import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '@memory-river/core/store/store-v4';
import { Retriever } from '@memory-river/core/retrieval/retriever-v4';
import { HooksEngine } from '@memory-river/core/cognition/hooks-engine';
import { recordHookPromptIncludedEvents } from '../dist/index.js';
import { hashQuery } from '@memory-river/core/util/util-hash';

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
      fs.rmSync(paths.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      // LanceDB 背景寫入與 teardown rm 的競態在慢跑者(GitHub 2-core)上
      // 連 5 秒重試都可能輸。斷言已全部跑完,暫存目錄清不掉只警告不紅測。
      console.warn(`[hooks-effectiveness] best-effort teardown failed for ${paths.root}:`, error?.code ?? error);
    }
  }
}

async function storeMemory(store, text) {
  return await store.store({
    text,
    vector: [0.1, 0.2, 0.3, 0.4],
    importance: 0.8,
    category: 'fact',
    parentId: null,
    metadata: '{}',
  });
}

async function waitEffectiveness(store, filter, expectedCount) {
  for (let i = 0; i < 20; i++) {
    const rows = await store.querySubsystemEffectiveness({ ...filter, limit: 50 });
    if (rows.length >= expectedCount) return rows;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return await store.querySubsystemEffectiveness({ ...filter, limit: 50 });
}

async function runHookSearch(store, { retainRetainedHook = false } = {}) {
  const vectorMemory = await storeMemory(store, 'vector memory');
  const retainedHook = await storeMemory(store, 'retained hook memory');
  const droppedHook = await storeMemory(store, 'dropped hook memory');
  const hookMemories = [
    { memory: retainedHook, score: 0.91, viaHook: 'alpha hook' },
    { memory: droppedHook, score: 0.72, viaHook: 'beta hook' },
  ];
  const hooksEngine = {
    triggerHooks: async () => ({
      triggered: true,
      relatedMemories: hookMemories,
      naturalLanguage: 'hook memories',
    }),
    reportHookOutcome: async () => {},
  };

  store.hybridVectorSearch = async () => [{
    entry: vectorMemory,
    vectorScore: 0.8,
    rankScore: 0.8,
    rawDistance: 0.25,
    bm25Score: 0,
    fusedScore: 0.8,
    finalScore: 0.8,
  }];

  const retriever = new Retriever(
    store,
    { embed: async () => [0, 0, 0, 0] },
    { vectorWeight: 1, bm25Weight: 0, candidatePoolMultiplier: 2 },
    path.join(os.tmpdir(), 'memory-river-reranker-cache'),
    hooksEngine,
  );
  const retainedHookIds = retainRetainedHook ? new Set([retainedHook.id]) : new Set();
  retriever.cragEvaluate = async (_query, results) => results.filter(result => {
    if (result.entry.id === vectorMemory.id) return true;
    return retainedHookIds.has(result.entry.id);
  });

  const response = await retriever.hybridSearch('alpha hook query', 5);
  return { response, vectorMemory, retainedHook, droppedHook };
}

test('hooks effectiveness records hook_triggered', async () => {
  await withTempStore('hooks-effectiveness-triggered-', async ({ store }) => {
    const { response, retainedHook, droppedHook } = await runHookSearch(store, {
      retainRetainedHook: false,
    });

    const rows = await waitEffectiveness(store, {
      event: 'hook_triggered',
      subsystem: 'hooks',
    }, 2);

    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map(row => row.entityId)), new Set([retainedHook.id, droppedHook.id]));
    assert.equal(rows[0].queryHash, response.queryHash);
    assert.equal(rows[0].outcome, 'triggered');
    assert.equal(JSON.parse(rows[0].metadata).sourceMemoryId, rows[0].entityId);
  });
});

test('hooks effectiveness records hook_crag_retained outcome retained', async () => {
  await withTempStore('hooks-effectiveness-retained-', async ({ store }) => {
    const { response, retainedHook } = await runHookSearch(store, {
      retainRetainedHook: true,
    });

    const rows = await waitEffectiveness(store, {
      event: 'hook_crag_retained',
      outcome: 'retained',
      subsystem: 'hooks',
    }, 1);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].queryHash, response.queryHash);
    const retainedResult = response.results.find(result => result.entry.id === retainedHook.id);
    assert.equal(rows[0].score, Number(retainedResult?.finalScore ?? retainedResult?.fusedScore ?? 0));
  });
});

test('hooks effectiveness records hook_crag_retained outcome dropped', async () => {
  await withTempStore('hooks-effectiveness-dropped-', async ({ store }) => {
    const { droppedHook, response } = await runHookSearch(store, {
      retainRetainedHook: false,
    });

    const rows = await waitEffectiveness(store, {
      event: 'hook_crag_retained',
      outcome: 'dropped',
      subsystem: 'hooks',
    }, 2);

    assert.ok(rows.some(row => row.entityId === droppedHook.id));
    assert.ok(rows.every(row => row.queryHash === response.queryHash));
  });
});

test('hooks effectiveness records hook_prompt_included', async () => {
  await withTempStore('hooks-effectiveness-prompt-', async ({ store }) => {
    const hookMemory = await storeMemory(store, 'prompt hook memory');
    const vectorMemory = await storeMemory(store, 'prompt vector memory');
    const queryHash = hashQuery('prompt query');

    recordHookPromptIncludedEvents(
      store,
      [
        { entry: vectorMemory, fusedScore: 0.8 },
        { entry: hookMemory, finalScore: 0.7, fusedScore: 0.6 },
      ],
      {
        hookOriginIds: [hookMemory.id],
        hookOriginKeywords: { [hookMemory.id]: 'prompt hook' },
        queryHash,
      },
    );

    const rows = await waitEffectiveness(store, {
      event: 'hook_prompt_included',
      subsystem: 'hooks',
    }, 1);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].entityId, hookMemory.id);
    assert.equal(rows[0].queryHash, queryHash);
    assert.equal(rows[0].outcome, 'included');
    assert.equal(rows[0].score, 0.7);
    assert.deepEqual(JSON.parse(rows[0].metadata), { rank: 2, keyword: 'prompt hook' });
  });
});

test('hooks effectiveness events for one search share queryHash', async () => {
  await withTempStore('hooks-effectiveness-queryhash-', async ({ store }) => {
    const { response, retainedHook } = await runHookSearch(store, {
      retainRetainedHook: true,
    });
    recordHookPromptIncludedEvents(
      store,
      response.results,
      response,
    );

    const rows = await waitEffectiveness(store, {
      subsystem: 'hooks',
    }, 4);

    assert.ok(rows.length >= 4);
    assert.ok(rows.every(row => row.queryHash === response.queryHash));
    assert.equal(response.queryHash, hashQuery('alpha hook query'));
    assert.ok(response.hookOriginIds.includes(retainedHook.id));
    assert.equal(response.hookOriginKeywords[retainedHook.id], 'alpha hook');
  });
});

test('triggerHooks result shape is unchanged', async () => {
  const memory = {
    id: '11111111-1111-4111-8111-111111111111',
    text: 'remember alpha hook behavior',
    vector: [0, 0, 0, 0],
    importance: 0.8,
    category: 'fact',
    parentId: null,
    metadata: JSON.stringify({
      hooks: [{ keyword: 'alpha hook', weight: 'high', weightScore: 1 }],
    }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const store = {
    queryAll: async () => [memory],
    queryHookBearing: async () => [memory],
    onShutdown: () => {},
  };
  const hooksEngine = new HooksEngine(
    store,
    { embed: async () => [0, 0, 0, 0] },
    { enabled: true, minTriggerScore: 0.5 },
    null,
    null,
  );

  const result = await hooksEngine.triggerHooks('please use alpha hook now');

  assert.equal(result.triggered, true);
  assert.equal(result.relatedMemories.length, 1);
  assert.equal(result.relatedMemories[0].memory.id, memory.id);
  assert.equal(result.relatedMemories[0].viaHook, 'alpha hook');
  assert.equal(typeof result.naturalLanguage, 'string');
});

test('hooks-engine status filter (PR-MS-2)', async () => {
  const cases = [
    { id: 'active', topStatus: 'active', metaStatus: 'active', expected: true },
    { id: 'missing', topStatus: 'active', metaStatus: undefined, expected: true },
    { id: 'null', topStatus: 'active', metaStatus: null, expected: true },
    { id: 'deprecated', topStatus: 'active', metaStatus: 'deprecated', expected: false },
    { id: 'trashed', topStatus: 'active', metaStatus: 'trashed', expected: false },
    { id: 'top-deprecated', topStatus: 'deprecated', metaStatus: 'active', expected: false },
  ];

  const memories = cases.map((fixture, index) => {
    const metadata = {
      hooks: [{ keyword: `status ${fixture.id}`, weight: 'high', weightScore: 1 }],
    };
    if (fixture.metaStatus !== undefined) metadata.status = fixture.metaStatus;

    return {
      id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
      text: `memory for ${fixture.id}`,
      vector: [0, 0, 0, 0],
      importance: 0.8,
      category: 'fact',
      parentId: null,
      metadata: JSON.stringify(metadata),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: fixture.topStatus,
    };
  });

  const store = {
    queryAll: async () => memories,
    queryHookBearing: async () => memories,
    onShutdown: () => {},
  };
  const hooksEngine = new HooksEngine(
    store,
    { embed: async () => [0, 0, 0, 0] },
    { enabled: true, minTriggerScore: 0.5 },
    null,
    null,
  );

  const result = await hooksEngine.triggerHooks('status');
  const triggeredIds = new Set(result.relatedMemories.map(item => item.memory.id));

  for (const fixture of cases) {
    const memory = memories[cases.indexOf(fixture)];
    assert.equal(
      triggeredIds.has(memory.id),
      fixture.expected,
      `${fixture.id} expected ${fixture.expected ? 'pass' : 'skip'}`,
    );
  }
});
