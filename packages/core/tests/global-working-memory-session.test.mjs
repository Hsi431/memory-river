import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GlobalWorkingMemory } from '../dist/cognition/global-working-memory.js';
import { MemoryRiverEngine } from '../dist/engine.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

function makeGwm(stateFile) {
  return new GlobalWorkingMemory({ embed: async (text) => [text.length, 1] }, stateFile);
}

function makeState(taskName) {
  return {
    active: true,
    taskName,
    taskDescription: `${taskName} description`,
    keywords: [taskName],
    embedding: [1, 0],
    driftRoundCount: 0,
    createdAt: 1,
  };
}

function makeEngine(root, gwmRef) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.autoRecall = false;
  const engine = new MemoryRiverEngine(config, {
    paths: {
      rerankerCacheDir: root,
      consolidationLog: path.join(root, 'consolidation.jsonl'),
      stateDir: path.join(root, 'state'),
      walFile: path.join(root, 'wal.jsonl'),
      sessionSummaryDir: path.join(root, 'sessions'),
      trashDir: path.join(root, 'trash'),
      gwmStateFile: path.join(root, 'gwm.json'),
    },
    transcriptArchive: { archiveSnapshot() {}, clearTranscriptCache() {} },
    deriveSessionFile: () => null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  });
  engine.testHooks.setState({ gwmRef });
  return engine;
}

test('GWM keeps task state isolated by session and persists each session', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-gwm-session-'));
  const stateFile = path.join(root, 'gwm.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const gwm = makeGwm(stateFile);
  await gwm.gwmOn('Session A task', 'A task description', ['alpha'], 'session-a');
  await gwm.gwmOn('Session B task', 'B task description', ['beta'], 'session-b');

  assert.match(gwm.gwmStatus('session-a'), /Session A task/);
  assert.doesNotMatch(gwm.gwmStatus('session-a'), /Session B task/);
  assert.match(gwm.gwmStatus('session-b'), /Session B task/);
  assert.doesNotMatch(gwm.gwmStatus('session-b'), /Session A task/);

  const reloaded = makeGwm(stateFile);
  await reloaded.load();
  assert.match(reloaded.gwmStatus('session-a'), /Session A task/);
  assert.match(reloaded.gwmStatus('session-b'), /Session B task/);

  await gwm.gwmOff('session-a');
  assert.match(gwm.gwmStatus('session-a'), /目前未啟動/);
  assert.match(gwm.gwmStatus('session-b'), /Session B task/);
});

test('GWM without a session key keeps the shared state behavior', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-gwm-default-'));
  const gwm = makeGwm(path.join(root, 'gwm.json'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await gwm.gwmOn('Shared task', 'Shared task description');
  assert.match(gwm.gwmStatus(), /Shared task/);
  await gwm.gwmUpdate({ taskName: 'Updated shared task' });
  assert.match(gwm.gwmStatus(), /Updated shared task/);
  await gwm.gwmOff();
  assert.match(gwm.gwmStatus(), /目前未啟動/);
});

test('GWM loads the legacy state-file shape as the unkeyed state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-gwm-legacy-'));
  const stateFile = path.join(root, 'gwm.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(stateFile, JSON.stringify(makeState('Legacy shared task')));

  const gwm = makeGwm(stateFile);
  await gwm.load();
  assert.match(gwm.gwmStatus(), /Legacy shared task/);
  assert.match(gwm.gwmStatus('session-a'), /目前未啟動/);
});

test('engine GWM tool entry uses the most recently assembled session key', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-gwm-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gwm = makeGwm(path.join(root, 'gwm.json'));
  const engine = makeEngine(root, gwm);

  await engine.assemble([{ role: 'user', content: 'Session A' }], { sessionKey: 'session-a' });
  await engine.executeGwmOn({ taskName: 'Engine A task', taskDescription: 'A task description', keywords: ['alpha'] }, engine.getCurrentSessionKey());
  await engine.assemble([{ role: 'user', content: 'Session B' }], { sessionKey: 'session-b' });
  await engine.executeGwmOn({ taskName: 'Engine B task', taskDescription: 'B task description', keywords: ['beta'] }, engine.getCurrentSessionKey());

  assert.match(engine.executeGwmStatus(engine.getCurrentSessionKey()).content[0].text, /Engine B task/);
  await engine.assemble([{ role: 'user', content: 'Back to A' }], { sessionKey: 'session-a' });
  assert.match(engine.executeGwmStatus(engine.getCurrentSessionKey()).content[0].text, /Engine A task/);
});
