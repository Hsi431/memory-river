import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const buildDir = process.env.MEMORY_RIVER_BUILD_DIR
  ? path.resolve(process.env.MEMORY_RIVER_BUILD_DIR)
  : path.resolve('dist');

let importCounter = 0;

async function freshModule() {
  const mod = await import(`${pathToFileURL(path.join(buildDir, 'index.js')).href}?gwm_eff=${importCounter++}`);
  const hooks = mod.__memoryRiverTestHooks;
  assert.ok(hooks, '__memoryRiverTestHooks export is required');
  hooks.resetState();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-gwm-eff-'));
  mod.default.register(makeApi(tmp));
  hooks.setState({ activeConcentrator: null });

  return {
    mod,
    hooks,
    cleanup: () => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[test-teardown] best-effort rm failed for ${tmp}:`, error?.code ?? error);
      }
    },
  };
}

function makeApi(root) {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    pluginConfig: {
      autoRecall: true,
      dbPath: path.join(root, 'ssd'),
      ramDbPath: path.join(root, 'ram'),
      inboxPath: path.join(root, 'inbox'),
      embedding: { dimensions: 4 },
    },
    registerTool: () => {},
    registerHook: () => {},
    on: () => {},
    registerService: () => ({ start: () => {}, stop: () => {} }),
    registerContextEngine: () => {},
  };
}

function makeStore({ reject = false } = {}) {
  const events = [];
  return {
    events,
    async recordSubsystemEffectiveness(event) {
      events.push(event);
      if (reject) throw new Error('stat down');
    },
    async hybridSkillCapsuleSearch() {
      return [];
    },
  };
}

function makeRetriever(store, {
  results = [],
  queryHash = 'expanded-hash',
  primaryThrows = false,
} = {}) {
  const calls = [];
  return {
    calls,
    getStore: () => store,
    async hybridSearch(query) {
      calls.push({ method: 'hybridSearch', query });
      if (primaryThrows) throw new Error('primary down');
      return { results, hookOriginIds: [], hookOriginKeywords: {}, queryHash };
    },
    async hybridSearchWithoutBoost(query) {
      calls.push({ method: 'hybridSearchWithoutBoost', query });
      return { results, hookOriginIds: [], hookOriginKeywords: {}, queryHash: `${queryHash}-fallback` };
    },
  };
}

function makeGwm({
  keywords = ['task1', 'task2'],
  drift = { isDrifting: false, similarity: 1 },
  shouldInject = false,
  reminder = '',
} = {}) {
  return {
    state: {
      active: true,
      taskName: 'task',
      taskDescription: 'task description',
      keywords,
      driftRoundCount: 2,
    },
    isActive: () => true,
    detectDrift: async () => drift,
    shouldInject: () => shouldInject,
    getReminderMessage: () => reminder,
    markInjected: async () => {},
  };
}

async function setup({ storeOptions, retrieverOptions, gwmOptions } = {}) {
  const ctx = await freshModule();
  const store = makeStore(storeOptions);
  const retriever = makeRetriever(store, retrieverOptions);
  const gwmRef = makeGwm(gwmOptions);
  ctx.hooks.setState({
    retrieverRef: retriever,
    memoryStoreRef: store,
    gwmRef,
    pluginInitPromise: Promise.resolve(),
  });
  return { ...ctx, store, retriever, gwmRef };
}

function user(content) {
  return { role: 'user', content };
}

function byEvent(events, event) {
  return events.filter(row => row.event === event);
}

test('gwm_short_query_expanded records expanded event', async () => {
  const ctx = await setup();
  try {
    await ctx.mod.assemble([user('hi')]);

    const rows = byEvent(ctx.store.events, 'gwm_short_query_expanded');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'expanded');
    assert.equal(rows[0].count, 2);
    assert.equal(rows[0].metadata.keywordCount, 2);
    assert.equal(rows[0].metadata.originalLen, 2);
    assert.ok(ctx.retriever.calls[0].query.includes('task1 task2'));
  } finally {
    ctx.cleanup();
  }
});

test('gwm_keywords_recalled records recalled outcome', async () => {
  const memory = { entry: { id: 'm1', text: 'remember task1', metadata: '{}' }, finalScore: 0.8 };
  const ctx = await setup({ retrieverOptions: { results: [memory], queryHash: 'q-recalled' } });
  try {
    await ctx.mod.assemble([user('hi')]);

    const rows = byEvent(ctx.store.events, 'gwm_keywords_recalled');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'recalled');
    assert.equal(rows[0].queryHash, 'q-recalled');
    assert.equal(rows[0].count, 1);
    assert.equal(rows[0].metadata.memoryCount, 1);
  } finally {
    ctx.cleanup();
  }
});

test('gwm_keywords_recalled records empty outcome', async () => {
  const ctx = await setup({ retrieverOptions: { results: [], queryHash: 'q-empty' } });
  try {
    await ctx.mod.assemble([user('hi')]);

    const rows = byEvent(ctx.store.events, 'gwm_keywords_recalled');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'empty');
    assert.equal(rows[0].queryHash, 'q-empty');
    assert.equal(rows[0].count, 0);
    assert.equal(rows[0].metadata.memoryCount, 0);
  } finally {
    ctx.cleanup();
  }
});

test('gwm_drift_injected records injected outcome', async () => {
  const ctx = await setup({
    gwmOptions: {
      drift: { isDrifting: true, similarity: 0.5 },
      shouldInject: true,
      reminder: 'task reminder',
    },
  });
  try {
    const result = await ctx.mod.assemble([user('long enough user message')]);

    const rows = byEvent(ctx.store.events, 'gwm_drift_injected');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'injected');
    assert.equal(rows[0].score, 0.5);
    assert.equal(rows[0].metadata.reminderLen, 'task reminder'.length);
    assert.ok(result.messages.some(message => message.role === 'system' && message.content === 'task reminder'));
  } finally {
    ctx.cleanup();
  }
});

test('gwm instrumentation failure does not affect assemble', async () => {
  const ctx = await setup({ storeOptions: { reject: true } });
  try {
    const result = await ctx.mod.assemble([user('hi')]);

    assert.ok(Array.isArray(result.messages));
    assert.ok(ctx.retriever.calls.length > 0);
  } finally {
    ctx.cleanup();
  }
});
