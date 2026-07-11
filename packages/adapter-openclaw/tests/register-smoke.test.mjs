import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeRecorder(impl = () => undefined) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

function makeApi(root) {
  return {
    logger: {
      info: makeRecorder(),
      warn: makeRecorder(),
      error: makeRecorder(),
      debug: makeRecorder(),
    },
    pluginConfig: {
      dbPath: path.join(root, 'ssd'),
      ramDbPath: path.join(root, 'ram'),
      inboxPath: path.join(root, 'inbox'),
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
    registerHook: makeRecorder(),
    on: makeRecorder(),
    registerTool: makeRecorder(),
    registerService: makeRecorder(),
    registerContextEngine: makeRecorder(),
  };
}

test('register() smoke registers OpenClaw surfaces without throwing', async () => {
  const mod = await import(`../dist/index.js?register_smoke=${Date.now()}`);
  const hooks = mod.__memoryRiverTestHooks;
  hooks.resetState();
  hooks.setState({
    pluginInitPromise: new Promise(() => {}),
    pluginInitialized: false,
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-register-smoke-'));
  const api = makeApi(root);

  assert.doesNotThrow(() => mod.register(api));

  assert.deepEqual(api.registerHook.calls.map(([name]) => name), ['session:compact:before']);
  assert.deepEqual(
    api.on.calls.map(([name]) => name).sort(),
    ['after_tool_call', 'agent_end', 'before_agent_start', 'llm_output', 'session_end'].sort(),
  );
  assert.equal(api.registerTool.calls.length, 9);
  assert.equal(api.registerService.calls.length, 1);
  assert.equal(api.registerContextEngine.calls.length, 1);
});
