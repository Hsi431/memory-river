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

function makeRecorder() {
  const fn = (...args) => {
    fn.calls.push(args);
  };
  fn.calls = [];
  return fn;
}

function makeApi(root) {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    pluginConfig: {
      autoRecall: false,
      dbPath: path.join(root, 'ssd'),
      ramDbPath: path.join(root, 'ram'),
      inboxPath: path.join(root, 'inbox'),
      embedding: { dimensions: 4 },
    },
    registerTool: makeRecorder(),
    registerHook: () => {},
    on: () => {},
    registerService: () => {},
    registerContextEngine: () => {},
  };
}

async function setup() {
  const mod = await import(`${pathToFileURL(path.join(buildDir, 'index.js')).href}?skill_tools=${importCounter++}`);
  const hooks = mod.__memoryRiverTestHooks;
  hooks.resetState();
  hooks.setState({ pluginInitPromise: new Promise(() => {}) });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-skill-tools-'));
  const api = makeApi(root);
  mod.default.register(api);

  const tools = new Map(api.registerTool.calls.map(([tool]) => [tool.name, tool]));
  assert.ok(tools.has('skill_save'));
  assert.ok(tools.has('skill_load'));

  return {
    hooks,
    tools,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function makeSkillStore() {
  const entries = [];
  return {
    entries,
    async queryAllWithMeta() {
      return entries.map(entry => ({ ...entry, metadataObj: JSON.parse(entry.metadata) }));
    },
    async store(entry) {
      const stored = {
        ...entry,
        id: 'skill-id-1',
        createdAt: 1,
        updatedAt: 1,
      };
      entries.push(stored);
      return stored;
    },
    async update(id, updates) {
      const entry = entries.find(candidate => candidate.id === id);
      if (!entry) return false;
      Object.assign(entry, updates);
      return true;
    },
    async boostHealth() {
      return true;
    },
    async getById(id) {
      return entries.find(candidate => candidate.id === id) ?? null;
    },
  };
}

const VALID_SKILL = {
  name: 'git-release',
  summary: 'Create and publish a release.',
  triggers: ['publish release', 'create tag'],
  steps: ['Run the release checks.', 'Create and push the tag.'],
};

test('skill_save returns validation violations as an isError response', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.tools.get('skill_save').execute('call-1', {
      name: 'bad name',
      summary: '',
      triggers: [],
      steps: ['only one'],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /violations/);
    assert.match(result.content[0].text, /^skill_save rejected/);
  } finally {
    ctx.cleanup();
  }
});

test('skill_save stores a valid capsule', async () => {
  const ctx = await setup();
  try {
    const store = makeSkillStore();
    ctx.hooks.setState({
      pluginInitPromise: Promise.resolve(),
      memoryStoreRef: store,
      embedderRef: { embed: async () => [0, 0, 0, 0] },
      statusManagerRef: {},
    });

    const result = await ctx.tools.get('skill_save').execute('call-2', VALID_SKILL);

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /skill saved: git-release/);
    assert.equal(store.entries.length, 1);
    assert.deepEqual(JSON.parse(store.entries[0].metadata).executionSteps, VALID_SKILL.steps);
  } finally {
    ctx.cleanup();
  }
});

test('skill_load returns full steps and a non-error not-found response', async () => {
  const ctx = await setup();
  try {
    const store = makeSkillStore();
    await store.store({
      text: VALID_SKILL.summary,
      category: 'skill',
      importance: 0.7,
      metadata: JSON.stringify({
        capsuleVersion: 2,
        skillName: VALID_SKILL.name,
        triggerConditions: VALID_SKILL.triggers,
        executionSteps: VALID_SKILL.steps,
        usageCount: 0,
        lastUsedAt: null,
        status: 'active',
      }),
    });
    ctx.hooks.setState({
      pluginInitPromise: Promise.resolve(),
      memoryStoreRef: store,
    });

    const loaded = await ctx.tools.get('skill_load').execute('call-3', { name: VALID_SKILL.name });
    assert.equal(loaded.isError, undefined);
    assert.match(loaded.content[0].text, /執行步驟:\n1\. Run the release checks\.\n2\. Create and push the tag\./);
    assert.match(loaded.content[0].text, /使用次數: 1/);

    const missing = await ctx.tools.get('skill_load').execute('call-4', { name: 'missing' });
    assert.equal(missing.isError, undefined);
    assert.equal(missing.content[0].text, 'skill not found: missing');
  } finally {
    ctx.cleanup();
  }
});
