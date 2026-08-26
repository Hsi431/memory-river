import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NightConsolidator } from '../dist/lifecycle/night-consolidation.js';

function memory(id, createdAt, text = id) {
  return {
    id,
    text,
    vector: [0.1],
    importance: 0.7,
    category: 'fact',
    parentId: null,
    metadata: '{}',
    createdAt,
    updatedAt: createdAt,
  };
}

function makeHarness(memories, decisions) {
  const calls = { update: 0, delete: 0, statusBatch: 0 };
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'night-consolidation-plan-'));
  const store = {
    queryAll: async () => memories,
    getById: async (id) => memories.find((entry) => entry.id === id) ?? null,
    update: async () => { calls.update++; return true; },
    delete: async () => { calls.delete++; return true; },
    searchBySlotKey: async () => [],
  };
  const consolidator = new NightConsolidator(store, {
    concentrator: { generate: async () => JSON.stringify({ decisions, summary: 'test plan' }) },
    statusManager: {
      changeStatusBatch: async (requests) => {
        calls.statusBatch += requests.length;
        return requests.map((request) => ({ ok: true, memoryId: request.memoryId }));
      },
    },
  }, path.join(logDir, 'consolidation.jsonl'));
  return { calls, consolidator, logDir };
}

function cleanupHarness(harness) {
  if (harness.logDir) fs.rmSync(harness.logDir, { recursive: true, force: true });
}

test('plan-only creates a complete plan and performs no mutations', async () => {
  const now = Date.now();
  const memories = [
    memory('plan-merge', now, 'merge this memory'),
    memory('plan-merge-target', now, 'keep this target'),
    memory('plan-delete', now, 'delete this memory'),
    memory('plan-update', now, 'update this memory'),
    memory('plan-deprecated', now, 'deprecate this memory'),
  ];
  const decisions = [
    { action: 'merge', memoryId: 'plan-merge', mergeIntoId: 'plan-merge-target', reason: 'duplicate' },
    { action: 'delete', memoryId: 'plan-delete', reason: 'obsolete' },
    { action: 'update', memoryId: 'plan-update', newCategory: 'decision', reason: 'wrong category' },
    { action: 'deprecated', memoryId: 'plan-deprecated', reason: 'superseded' },
  ];
  const harness = makeHarness(memories, decisions);
  const runId = 'plan-only-run';
  const expectedPlanPath = path.join(harness.logDir, `consolidation-plan-${runId}.json`);

  try {
    const result = await harness.consolidator.consolidateRange('all', runId, 'scheduled_timer', { planOnly: true });
    assert.equal(result.planOnly, true);
    assert.equal(result.plan.decisions.length, decisions.length);
    assert.deepEqual(harness.calls, { update: 0, delete: 0, statusBatch: 0 });
    assert.equal(fs.existsSync(expectedPlanPath), true);

    const written = JSON.parse(fs.readFileSync(expectedPlanPath, 'utf8'));
    assert.equal(written.planOnly, true);
    assert.deepEqual(written.decisions.map((decision) => decision.memoryId), decisions.map((decision) => decision.memoryId));
    assert.deepEqual(written.decisions.map((decision) => decision.action), decisions.map((decision) => decision.action));
    assert.equal(written.decisions[0].mergeIntoId, 'plan-merge-target');
    assert.equal(written.decisions[0].reason, 'duplicate');
    assert.equal(written.decisions[0].category, 'fact');
    assert.equal(written.decisions[0].importance, 0.7);
    assert.equal(written.decisions[0].text, 'merge this memory');
  } finally {
    cleanupHarness(harness);
  }
});

test('consolidation without options executes the existing apply path', async () => {
  const now = Date.now();
  const memories = [memory('normal-update', now)];
  const harness = makeHarness(memories, [
    { action: 'update', memoryId: 'normal-update', newCategory: 'decision', reason: 'reclassify' },
  ]);

  try {
    const result = await harness.consolidator.consolidateRange('all', 'normal-run');
    assert.equal(result.planOnly, false);
    assert.equal(harness.calls.update, 1);
  } finally {
    cleanupHarness(harness);
  }
});

test('all includes memories older than 30 days while last24h excludes them', async () => {
  const now = Date.now();
  const memories = [
    memory('old-memory', now - 30 * 24 * 60 * 60 * 1000),
    memory('recent-memory', now - 60 * 60 * 1000),
  ];
  const decisions = memories.map((entry) => ({ action: 'keep', memoryId: entry.id, reason: 'range check' }));
  const allHarness = makeHarness(memories, decisions);
  const recentHarness = makeHarness(memories, decisions);

  try {
    const allResult = await allHarness.consolidator.consolidateRange('all', 'all-run', 'scheduled_timer', { planOnly: true });
    const recentResult = await recentHarness.consolidator.consolidateRange('last24h', 'recent-run', 'scheduled_timer', { planOnly: true });
    assert.equal(allResult.plan.processedCount, 2);
    assert.equal(recentResult.plan.processedCount, 1);
    assert.deepEqual(recentResult.plan.decisions.map((decision) => decision.memoryId), ['recent-memory']);
  } finally {
    cleanupHarness(allHarness);
    cleanupHarness(recentHarness);
  }
});
