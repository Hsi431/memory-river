import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CleanupEngine } from '../dist/lifecycle/cleanup-engine.js';

const EMPTY_SUMMARY = {
  count: 0,
  firstId: null,
  lastId: null,
  minCreatedAt: null,
  maxCreatedAt: null,
  createdAtByDay: {},
};

/** 記錄 decayMemories 被叫幾次,並讓呼叫端可以控制它何時完成。 */
function makeGatedStore() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const store = {
    async decayMemories() {
      calls += 1;
      await gate;
      return {
        coreProtected: 0,
        wouldDecay: 0,
        wouldDelete: 0,
        decayed: 0,
        deleted: 0,
        deferredDelete: 0,
        deferredDecay: 0,
        deleteCandidateSummary: EMPTY_SUMMARY,
      };
    },
  };
  return { store, release: () => release(), get calls() { return calls; } };
}

function makeEngine(store) {
  const trashPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-cleanup-test-'));
  return new CleanupEngine(store, {
    enabled: true,
    decayDays: 7,
    deleteBelow: 10,
    trashPath,
    useTrash: false,
    enableTrashAutoPurge: false,
  });
}

test('並行的兩次清理只會真的跑一次(daily-schedule 撞 session-end)', async () => {
  const gated = makeGatedStore();
  const engine = makeEngine(gated.store);

  // 2026-09-16 的死機重現:兩個觸發點在 0.8 秒內先後進來,
  // 第二次必須被擋掉,否則兩份 Optimize 並行會把記憶體吃光。
  const first = engine.runSmartCleanup('daily-schedule');
  const second = engine.runSmartCleanup('session-end');

  gated.release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(gated.calls, 1, 'decayMemories 只能被執行一次');
  assert.notEqual(firstResult.skipped, true, '第一次不該被標成 skipped');
  assert.equal(secondResult.skipped, true, '第二次必須回報 skipped');
});

test('session-end entry skips decay while another cleanup is running', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-cleanup-session-end-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gated = makeGatedStore();
  const engine = new CleanupEngine(gated.store, {
    enabled: true,
    decayDays: 7,
    deleteBelow: 10,
    trashPath: path.join(root, 'trash'),
    useTrash: false,
    enableTrashAutoPurge: false,
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => { console.warn = originalWarn; });

  const first = engine.runSmartCleanup('daily-schedule');
  engine.onSessionEnd('session-2', []);
  await Promise.resolve();

  assert.equal(gated.calls, 1, 'session-end must reuse the cleanup in-flight lock');
  assert.match(warnings.join('\n'), /run skipped.*session-end/);
  gated.release();
  await first;
});

test('前一次跑完之後,下一次清理可以正常進行', async () => {
  const gated = makeGatedStore();
  const engine = makeEngine(gated.store);

  gated.release();
  await engine.runSmartCleanup('daily-schedule');
  const later = await engine.runSmartCleanup('session-end');

  assert.equal(gated.calls, 2, '鎖必須在跑完後釋放');
  assert.notEqual(later.skipped, true);
});

test('清理失敗也要把鎖放掉,不能把後續清理永久卡死', async () => {
  let calls = 0;
  const store = {
    async decayMemories() {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return {
        coreProtected: 0,
        wouldDecay: 0,
        wouldDelete: 0,
        decayed: 0,
        deleted: 0,
        deferredDelete: 0,
        deferredDecay: 0,
        deleteCandidateSummary: EMPTY_SUMMARY,
      };
    },
  };
  const engine = makeEngine(store);

  await assert.rejects(() => engine.runSmartCleanup('daily-schedule'), /boom/);
  const after = await engine.runSmartCleanup('session-end');

  assert.equal(calls, 2, '前一次拋錯後鎖必須被釋放');
  assert.notEqual(after.skipped, true);
});
