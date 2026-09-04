import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NightConsolidator } from '../dist/lifecycle/night-consolidation.js';

test('night consolidation skips invalid LLM decisions while executing valid ones', async () => {
  const now = Date.now();
  const memories = ['memory-a', 'memory-b'].map((id) => ({
    id,
    text: id,
    vector: [0.1],
    importance: 0.5,
    category: 'fact',
    parentId: null,
    metadata: '{}',
    createdAt: now,
    updatedAt: now,
  }));
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const statusRequests = [];
  const updates = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-night-validation-')), 'night.jsonl');
  const consolidator = new NightConsolidator({
    queryAll: async () => memories,
    getById: async (id) => byId.get(id) ?? null,
    update: async (id, update) => { updates.push({ id, update }); return true; },
    delete: async () => true,
    searchBySlotKey: async () => [],
  }, {
    concentrator: { generate: async () => JSON.stringify({
      decisions: [
        { action: 'delete', memoryId: 'outside-batch', reason: 'invalid target' },
        { action: 'merge', memoryId: 'memory-a', mergeIntoId: 'memory-a', reason: 'self merge' },
        { action: 'explode', memoryId: 'memory-a', reason: 'invalid action' },
        { action: 'update', memoryId: 'memory-a', newConfidence: 2, reason: 'invalid confidence' },
        { action: 'delete', memoryId: 'memory-b', reason: 'valid decision' },
      ],
      summary: 'test',
    }) },
    statusManager: {
      changeStatusBatch: async (requests) => {
        statusRequests.push(...requests);
        return requests.map((request) => ({ ok: true, memoryId: request.memoryId }));
      },
    },
  }, logPath);

  try {
    const result = await consolidator.consolidateToday('validation-run');

    assert.deepEqual(result.plan.decisions.map((decision) => decision.memoryId), ['memory-b']);
    assert.deepEqual(statusRequests.map((request) => request.memoryId), ['memory-b']);
    assert.deepEqual(updates, []);
    assert.equal(warnings.filter((warning) => warning.includes('invalid LLM decision')).length, 4);
  } finally {
    console.warn = originalWarn;
    try {
      fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${path.dirname(logPath)}:`, error?.code ?? error);
    }
  }
});

async function runMergeForSlotMetadata(sourceMetadata, targetMetadata) {
  const now = Date.now();
  const memories = [
    { id: 'source-memory', text: 'source', vector: [0.1], importance: 0.5, category: 'preference', parentId: null, metadata: typeof sourceMetadata === 'string' ? sourceMetadata : JSON.stringify(sourceMetadata), createdAt: now, updatedAt: now },
    { id: 'target-memory', text: 'target', vector: [0.1], importance: 0.5, category: 'preference', parentId: null, metadata: typeof targetMetadata === 'string' ? targetMetadata : JSON.stringify(targetMetadata), createdAt: now, updatedAt: now },
  ];
  const statusRequests = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-night-merge-slot-'));
  const consolidator = new NightConsolidator({
    queryAll: async () => memories,
    getById: async id => memories.find(memory => memory.id === id) ?? null,
    update: async () => true,
    delete: async () => true,
    searchBySlotKey: async () => [],
  }, {
    concentrator: { generate: async () => JSON.stringify({
      decisions: [{ action: 'merge', memoryId: 'source-memory', mergeIntoId: 'target-memory', reason: 'same slot' }],
      summary: 'test',
    }) },
    statusManager: {
      changeStatusBatch: async requests => {
        statusRequests.push(...requests);
        return requests.map(request => ({ ok: true, memoryId: request.memoryId }));
      },
    },
  }, path.join(root, 'night.jsonl'));

  try {
    await consolidator.consolidateRange('all', 'merge-slot-test');
    return statusRequests;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('night consolidation merge requires matching subjects and single cardinality', async () => {
  assert.equal((await runMergeForSlotMetadata(
    { slotSubject: 'James', slotCardinality: 'single' },
    { slotSubject: 'John', slotCardinality: 'single' },
  )).length, 0);
  assert.equal((await runMergeForSlotMetadata(
    { slotSubject: 'James', slotCardinality: 'single' },
    { slotSubject: ' james ', slotCardinality: 'single' },
  )).length, 1);
  assert.equal((await runMergeForSlotMetadata(
    { slotSubject: 'James', slotCardinality: 'multi' },
    { slotSubject: 'James', slotCardinality: 'single' },
  )).length, 0);
});

test('night consolidation merge excludes malformed metadata', async () => {
  const requests = await runMergeForSlotMetadata('{bad', { slotSubject: 'James', slotCardinality: 'single' });
  assert.equal(requests.length, 0);
});
