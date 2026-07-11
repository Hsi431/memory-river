import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  chooseStartupRecoveryMode,
  readCleanupState,
  shouldRunStartupRecovery,
  writeCleanupState,
} from '../dist/lifecycle/cleanup-state.js';

test('cleanup-state missing triggers startup recovery', () => {
  const decision = shouldRunStartupRecovery(null, 1000);
  assert.equal(decision.shouldRun, true);
  assert.equal(decision.reason, 'missing-state');
});

test('cleanup-state last success under 25h skips startup recovery', () => {
  const now = Date.now();
  const decision = shouldRunStartupRecovery({
    lastSuccessfulRunAt: now - 2 * 60 * 60 * 1000,
    lastDeleteCount: 1,
    lastDecayCount: 2,
  }, now);

  assert.equal(decision.shouldRun, false);
  assert.equal(decision.reason, 'recent-success');
});

test('cleanup-state last success over 25h triggers startup recovery', () => {
  const now = Date.now();
  const decision = shouldRunStartupRecovery({
    lastSuccessfulRunAt: now - 26 * 60 * 60 * 1000,
    lastDeleteCount: 1,
    lastDecayCount: 2,
  }, now);

  assert.equal(decision.shouldRun, true);
  assert.equal(decision.reason, 'stale-state');
});

test('startup recovery estimated delete over 2x limit is dry-run only', () => {
  const mode = chooseStartupRecoveryMode(41, { maxStartupDelete: 20, maxStartupDecay: 50 });
  assert.equal(mode.dryRunOnly, true);
  assert.equal(mode.reason, 'backlog-too-large');
});

test('startup recovery estimated delete between 1x and 2x limit runs capped', () => {
  const mode = chooseStartupRecoveryMode(30, { maxStartupDelete: 20, maxStartupDecay: 50 });
  assert.equal(mode.dryRunOnly, false);
  assert.equal(mode.reason, 'capped');
  assert.equal(mode.maxDelete, 20);
  assert.equal(mode.maxDecay, 50);
});

test('cleanup-state read/write round trip uses requested file path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-state-'));
  const filePath = path.join(root, 'state', 'cleanup-state.json');
  try {
    writeCleanupState({ lastSuccessfulRunAt: 123, lastDeleteCount: 4, lastDecayCount: 5 }, filePath);
    assert.deepEqual(readCleanupState(filePath), {
      lastSuccessfulRunAt: 123,
      lastDeleteCount: 4,
      lastDecayCount: 5,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
