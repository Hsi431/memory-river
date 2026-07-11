import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const expectedToolNames = [
  'memory_recall',
  'memory_store',
  'skill_save',
  'skill_load',
  'gwm_on',
  'gwm_off',
  'gwm_status',
  'gwm_update',
  'memory_rehydrate',
];

function makeRecorder(impl = () => undefined) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

function makeApi(name, root) {
  return {
    _name: name,
    logger: {
      info: makeRecorder(),
      warn: makeRecorder(),
      error: makeRecorder(),
      debug: makeRecorder(),
    },
    pluginConfig: {
      dbPath: path.join(root, name, 'ssd'),
      ramDbPath: path.join(root, name, 'ram'),
      inboxPath: path.join(root, name, 'inbox'),
      embedding: {
        provider: 'ollama',
        model: 'test-embedding',
        dimensions: 8,
      },
      concentration: {
        provider: 'minimax',
        model: 'test-concentrator',
        minimaxModel: 'test-minimax',
        asyncCompactAfterAssemble: false,
      },
      autoRecall: false,
    },
    registerTool: makeRecorder(),
    registerHook: makeRecorder(),
    on: makeRecorder(),
    registerService: makeRecorder(),
    registerContextEngine: makeRecorder(),
  };
}

function toolNames(api) {
  return api.registerTool.calls.map(([tool]) => tool.name);
}

test('register() registers tools for each API registry while keeping singleton store stable', async () => {
  const mod = await import(`../dist/index.js?t=${Date.now()}`);
  const memoryRiver = mod.default;
  const hooks = mod.__memoryRiverTestHooks;
  assert.ok(memoryRiver?.register, 'default export must expose register()');
  assert.ok(hooks, '__memoryRiverTestHooks export is required');

  hooks.resetState();
  hooks.setState({
    pluginInitPromise: new Promise(() => {}),
    pluginInitialized: false,
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-register-'));
  const api1 = makeApi('api1', root);
  const api2 = makeApi('api2', root);

  assert.doesNotThrow(() => memoryRiver.register(api1));
  const storeAfterApi1 = hooks.getState().memoryStoreRef;

  assert.doesNotThrow(() => memoryRiver.register(api2));
  const storeAfterApi2 = hooks.getState().memoryStoreRef;

  assert.equal(api1.registerTool.calls.length, 9);
  assert.equal(api2.registerTool.calls.length, 9);
  assert.deepEqual(toolNames(api1).sort(), [...expectedToolNames].sort());
  assert.deepEqual(toolNames(api2).sort(), [...expectedToolNames].sort());

  assert.equal(api1.registerService.calls.length, 1);
  assert.equal(api2.registerService.calls.length, 1);
  assert.equal(api1.registerService.calls[0][0].id, 'memory-river');
  assert.equal(api2.registerService.calls[0][0].id, 'memory-river');

  assert.equal(api1.registerContextEngine.calls.length, 1);
  assert.equal(api2.registerContextEngine.calls.length, 1);
  assert.equal(api1.registerContextEngine.calls[0][0], 'memory-river');
  assert.equal(api2.registerContextEngine.calls[0][0], 'memory-river');

  assert.ok(storeAfterApi1, 'first register should create memoryStoreRef');
  assert.strictEqual(storeAfterApi2, storeAfterApi1);
});
