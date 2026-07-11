import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const buildDir = process.env.MEMORY_RIVER_BUILD_DIR
  ? path.resolve(process.env.MEMORY_RIVER_BUILD_DIR)
  : path.resolve('dist');

let importCounter = 0;

async function freshHooks() {
  const mod = await import(`${pathToFileURL(path.join(buildDir, 'index.js')).href}?memory_store_contract=${importCounter++}`);
  const hooks = mod.__memoryRiverTestHooks;
  assert.ok(hooks, '__memoryRiverTestHooks export is required');
  hooks.resetState();
  return hooks;
}

test('memory_store capsuleBridgeRef null returns isError', async () => {
  const hooks = await freshHooks();
  hooks.setState({ capsuleBridgeRef: null });

  const result = await hooks.executeMemoryStore({ text: 'remember this' });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, '❌ INBOX_WRITER_UNAVAILABLE: capsule bridge not initialized');
});
