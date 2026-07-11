import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const buildDir = process.env.MEMORY_RIVER_BUILD_DIR
  ? path.resolve(process.env.MEMORY_RIVER_BUILD_DIR)
  : path.resolve('dist');

let importCounter = 0;

async function freshHooks() {
  const mod = await import(`${pathToFileURL(path.join(buildDir, 'index.js')).href}?gwm_contract=${importCounter++}`);
  const hooks = mod.__memoryRiverTestHooks;
  assert.ok(hooks, '__memoryRiverTestHooks export is required');
  hooks.resetState();
  hooks.setState({ gwmRef: null });
  return hooks;
}

function assertGwmError(result) {
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^❌ GWM_NOT_INITIALIZED:/);
}

test('gwm_on gwmRef null returns isError', async () => {
  const hooks = await freshHooks();
  assertGwmError(await hooks.executeGwmOn({
    taskName: 'task',
    taskDescription: 'desc',
  }));
});

test('gwm_off gwmRef null returns isError', async () => {
  const hooks = await freshHooks();
  assertGwmError(await hooks.executeGwmOff());
});

test('gwm_status gwmRef null returns isError', async () => {
  const hooks = await freshHooks();
  assertGwmError(hooks.executeGwmStatus());
});

test('gwm_update gwmRef null returns isError', async () => {
  const hooks = await freshHooks();
  assertGwmError(await hooks.executeGwmUpdate({ taskName: 'next' }));
});
