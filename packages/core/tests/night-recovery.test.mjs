import test from 'node:test';
import assert from 'node:assert/strict';

import {
  healthCheck,
  shouldRunNow,
} from '../dist/lifecycle/night-recovery.js';

const DAY_MS = 24 * 60 * 60 * 1000;

test('shouldRunNow returns true when last success is older than 24h', async () => {
  const now = 1_800_000_000_000;
  const decision = await shouldRunNow({
    isRunning: false,
    lastSuccessfulRunTs: now - DAY_MS - 1,
    nowMs: now,
  });

  assert.equal(decision.shouldRun, true);
  assert.equal(decision.reason, 'stale_run');
});

test('shouldRunNow returns false when last success is newer than 24h', async () => {
  const now = 1_800_000_000_000;
  const decision = await shouldRunNow({
    isRunning: false,
    lastSuccessfulRunTs: now - DAY_MS + 1,
    nowMs: now,
  });

  assert.equal(decision.shouldRun, false);
  assert.equal(decision.reason, 'recent_run');
});

test('shouldRunNow returns true when stats table has no successful run', async () => {
  const decision = await shouldRunNow({
    isRunning: false,
    lastSuccessfulRunTs: null,
    nowMs: 1_800_000_000_000,
  });

  assert.equal(decision.shouldRun, true);
  assert.equal(decision.reason, 'no_success_record');
});

test('shouldRunNow returns false when a run is already active', async () => {
  const decision = await shouldRunNow({
    isRunning: true,
    lastSuccessfulRunTs: null,
    nowMs: 1_800_000_000_000,
  });

  assert.equal(decision.shouldRun, false);
  assert.equal(decision.reason, 'already_running');
});

test('healthCheck triggered writes recovery_triggered and calls runNightConsolidation', async () => {
  const now = 1_800_000_000_000;
  const stats = [];
  const calls = [];
  let running = false;

  const decision = await healthCheck({
    source: 'health_check_recovery',
    isRunning: () => running,
    setRunning: (value) => {
      running = value;
    },
    getLastSuccessfulRunTs: async () => now - DAY_MS - 1,
    recordStat: (stat) => stats.push(stat),
    runNightConsolidation: async (source) => {
      assert.equal(running, true);
      calls.push(source);
    },
    now: () => now,
    runIdFactory: () => `run-${stats.length + 1}`,
  });

  assert.equal(decision.shouldRun, true);
  assert.deepEqual(calls, ['health_check_recovery']);
  assert.equal(running, false);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].phase, 'recovery_triggered');
  assert.equal(stats[0].outcome, 'triggered');
  assert.deepEqual(JSON.parse(stats[0].metadata), {
    source: 'health_check_recovery',
    lastSuccessfulRunTs: now - DAY_MS - 1,
  });
});

test('healthCheck skipped for recent run writes recovery_skipped and does not call runNightConsolidation', async () => {
  const now = 1_800_000_000_000;
  const lastSuccessfulRunTs = now - DAY_MS + 1;
  const stats = [];
  let calls = 0;
  let running = false;

  const decision = await healthCheck({
    source: 'scheduled_timer',
    isRunning: () => running,
    setRunning: (value) => {
      running = value;
    },
    getLastSuccessfulRunTs: async () => lastSuccessfulRunTs,
    recordStat: (stat) => stats.push(stat),
    runNightConsolidation: async () => {
      calls += 1;
    },
    now: () => now,
    runIdFactory: () => `skip-${stats.length + 1}`,
  });

  assert.equal(decision.shouldRun, false);
  assert.equal(decision.reason, 'recent_run');
  assert.equal(calls, 0);
  assert.equal(running, false);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].phase, 'recovery_skipped');
  assert.equal(stats[0].outcome, 'skipped');
  assert.deepEqual(JSON.parse(stats[0].metadata), {
    source: 'scheduled_timer',
    reason: 'recent_run',
    lastSuccessfulRunTs,
  });
});
