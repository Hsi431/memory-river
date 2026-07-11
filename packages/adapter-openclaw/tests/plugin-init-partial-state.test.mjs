import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const buildDir = process.env.MEMORY_RIVER_BUILD_DIR
  ? path.resolve(process.env.MEMORY_RIVER_BUILD_DIR)
  : path.resolve('dist');

let importCounter = 0;

async function freshHooks() {
  const mod = await import(`${pathToFileURL(path.join(buildDir, 'index.js')).href}?plugin_init_partial=${importCounter++}`);
  const hooks = mod.__memoryRiverTestHooks;
  assert.ok(hooks, '__memoryRiverTestHooks export is required');
  hooks.resetState();
  return hooks;
}

test('ensurePluginInitialized failure clears partial retriever hook graph refs', async () => {
  const hooks = await freshHooks();
  hooks.setState({
    retrieverRef: { stale: 'retriever' },
    hooksEngineRef: { stale: 'hooks' },
    graphStoreRef: { stale: 'graph' },
  });

  await assert.rejects(
    hooks.ensurePluginInitialized(),
    /memory-river 初始化前置依賴缺失/,
  );

  const state = hooks.getState();
  assert.equal(state.pluginInitPromise, null);
  assert.equal(state.pluginInitialized, false);
  assert.equal(state.retrieverRef, null);
  assert.equal(state.hooksEngineRef, null);
  assert.equal(state.graphStoreRef, null);
  assert.match(state.pluginInitError.message, /memory-river 初始化前置依賴缺失/);
});
