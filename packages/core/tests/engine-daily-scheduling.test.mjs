import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryRiverEngine } from '../dist/engine.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

const OriginalDate = Date;
const OriginalTimers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};

function installFakeClock(nowMs) {
  const timeouts = [];
  const intervals = [];
  let now = nowMs;
  class FixedDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length === 0 ? [now] : args));
    }

    static now() {
      return now;
    }
  }
  globalThis.Date = FixedDate;
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timeouts.push(timer);
    return timer;
  };
  globalThis.clearTimeout = () => {};
  globalThis.setInterval = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    intervals.push(timer);
    return timer;
  };
  globalThis.clearInterval = () => {};
  return {
    timeouts,
    intervals,
    setNow(value) {
      now = value;
    },
    restore() {
      globalThis.Date = OriginalDate;
      Object.assign(globalThis, OriginalTimers);
    },
  };
}

function createEngine(root) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.concentration.timezone = 'America/New_York';
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
  engine.nightConsolidatorRef = {};
  engine.cleanupEngineRef = {};
  engine.tryRunNightConsolidator = async () => {};
  engine.runStartupRecoveryWithProtection = async () => {};
  engine.runCleanupEngineNow = async () => {};
  return engine;
}

test('overlapping direct night consolidation calls run only once', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-night-reentrancy-'));
  const engine = createEngine(root);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
    engine.clearNightConsolidatorTimers();
    engine.clearCleanupEngineTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });
  engine.nightConsolidatorRef = {
    async consolidateRange() {
      calls += 1;
      await gate;
      return {
        plan: { processedCount: 1, decisions: [], mergedCount: 0, updatedCount: 0, keptCount: 1 },
        errors: [],
      };
    },
  };

  const first = engine.runNightConsolidatorNow('run-1');
  const second = engine.runNightConsolidatorNow('run-2');

  assert.equal(calls, 1, 'a second direct call must not enter consolidation');
  release();
  await Promise.all([first, second]);
  assert.match(warnings.join('\n'), /run skipped.*still in progress/);
});

test('night schedule keeps triggering while a previous consolidation is pending', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-night-stalled-schedule-'));
  const engine = createEngine(root);
  const start = Date.UTC(2026, 2, 8, 6, 30);
  const clock = installFakeClock(start);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
    engine.clearNightConsolidatorTimers();
    engine.clearCleanupEngineTimers();
    clock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });
  engine.nightConsolidatorRef = {
    async consolidateRange() {
      calls += 1;
      await gate;
      return {
        plan: { processedCount: 1, decisions: [], mergedCount: 0, updatedCount: 0, keptCount: 1 },
        errors: [],
      };
    },
  };
  engine.tryRunNightConsolidator = MemoryRiverEngine.prototype.tryRunNightConsolidator.bind(engine);

  engine.scheduleNightConsolidator();
  const firstTimer = clock.timeouts[0];
  clock.setNow(start + firstTimer.delay);
  const firstRun = firstTimer.callback();
  for (let i = 0; i < 5 && calls === 0; i += 1) await Promise.resolve();

  const nextTimer = clock.timeouts[2];
  assert.ok(nextTimer, 'the next daily timer must be installed before waiting for this run');
  assert.equal(calls, 1);
  clock.setNow(start + firstTimer.delay + nextTimer.delay);
  await nextTimer.callback();

  assert.equal(calls, 1, 'a scheduled run must skip while the prior run is pending');
  assert.match(warnings.join('\n'), /scheduled run skipped.*runningFor=86400000 ms/);
  release();
  await firstRun;
});

test('cleanup schedule keeps triggering while a previous cleanup is pending', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-cleanup-stalled-schedule-'));
  const engine = createEngine(root);
  const start = Date.UTC(2026, 10, 1, 5, 30);
  const clock = installFakeClock(start);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
    engine.clearNightConsolidatorTimers();
    engine.clearCleanupEngineTimers();
    clock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });
  engine.runCleanupEngineNow = async () => {
    calls += 1;
    await gate;
  };

  engine.scheduleCleanupEngine();
  const firstTimer = clock.timeouts[0];
  clock.setNow(start + firstTimer.delay);
  const firstRun = firstTimer.callback();
  const nextTimer = clock.timeouts[1];
  assert.ok(nextTimer, 'the next daily timer must be installed before waiting for this run');
  assert.equal(calls, 1);
  clock.setNow(start + firstTimer.delay + nextTimer.delay);
  await nextTimer.callback();

  assert.equal(calls, 1, 'a scheduled run must skip while the prior run is pending');
  assert.match(warnings.join('\n'), /scheduled run skipped.*runningFor=86400000 ms/);
  release();
  await firstRun;
});

test('night schedule uses configured timezone across DST and recalculates after a long run', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-night-schedule-'));
  const engine = createEngine(root);
  const clock = installFakeClock(Date.UTC(2026, 2, 8, 6, 30));
  t.after(() => {
    engine.clearNightConsolidatorTimers();
    engine.clearCleanupEngineTimers();
    clock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  engine.scheduleNightConsolidator();
  const firstNightTimer = clock.timeouts[0];
  assert.equal(firstNightTimer.delay, 30 * 60 * 1000);

  clock.setNow(Date.UTC(2026, 2, 8, 9, 30));
  await firstNightTimer.callback();

  assert.equal(clock.timeouts[2].delay, 21.5 * 60 * 60 * 1000);
});

test('cleanup schedule recalculates from completion time across the fall DST transition', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-cleanup-schedule-'));
  const engine = createEngine(root);
  const clock = installFakeClock(Date.UTC(2026, 10, 1, 5, 30));
  t.after(() => {
    engine.clearNightConsolidatorTimers();
    engine.clearCleanupEngineTimers();
    clock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  engine.scheduleCleanupEngine();
  const firstCleanupTimer = clock.timeouts[0];
  assert.equal(firstCleanupTimer.delay, 3.5 * 60 * 60 * 1000);

  clock.setNow(Date.UTC(2026, 10, 1, 11, 30));
  await firstCleanupTimer.callback();

  assert.equal(clock.timeouts[1].delay, 21.5 * 60 * 60 * 1000);
});
