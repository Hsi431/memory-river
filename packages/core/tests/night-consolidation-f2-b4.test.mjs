import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NightConsolidator } from '../dist/lifecycle/night-consolidation.js';

function makeMemory(id, metadata = { status: 'active', slotSubject: 'Mina', slotCardinality: 'single' }) {
  const now = Date.now();
  return {
    id, text: id, vector: [0.1], importance: 0.5, category: 'preference',
    parentId: null, metadata: JSON.stringify(metadata), createdAt: now, updatedAt: now,
  };
}

function makeConsolidator(memories, decisions, embedder) {
  const byId = new Map(memories.map(memory => [memory.id, memory]));
  const statusRequests = [];
  const updates = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-night-b4-'));
  const consolidator = new NightConsolidator({
    queryAll: async () => memories,
    getById: async id => byId.get(id) ?? null,
    update: async (id, patch, newVector) => { updates.push({ id, patch, newVector }); return true; },
    delete: async () => true,
    searchBySlotKey: async () => [],
  }, {
    concentrator: { generate: async () => JSON.stringify({ decisions, summary: 'test' }) },
    embedder,
    statusManager: {
      changeStatusBatch: async requests => {
        statusRequests.push(...requests);
        for (const request of requests) {
          const memory = byId.get(request.memoryId);
          memory.metadata = JSON.stringify({ ...JSON.parse(memory.metadata), status: request.toStatus, supersededBy: request.supersededBy });
        }
        return requests.map(request => ({ ok: true, memoryId: request.memoryId }));
      },
    },
  }, path.join(root, 'night.jsonl'));
  return { consolidator, memories, statusRequests, updates, root };
}

test('B4: rejects mutual merges in one consolidation batch before both memories are hidden', async () => {
  const fixture = makeConsolidator(
    [makeMemory('memory-a'), makeMemory('memory-b')],
    [
      { action: 'merge', memoryId: 'memory-a', mergeIntoId: 'memory-b', reason: 'same slot' },
      { action: 'merge', memoryId: 'memory-b', mergeIntoId: 'memory-a', reason: 'same slot' },
    ],
  );
  try {
    await fixture.consolidator.consolidateRange('all', 'b4-mutual');
    assert.equal(fixture.statusRequests.length, 1);
    assert.equal(fixture.memories.filter(memory => JSON.parse(memory.metadata).status === 'active').length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('B4: rejects a merge whose existing supersedes chain leads back to its source', async () => {
  const fixture = makeConsolidator(
    [
      makeMemory('memory-a'),
      makeMemory('memory-b', { status: 'deprecated', slotSubject: 'Mina', slotCardinality: 'single', supersededBy: 'memory-c' }),
      makeMemory('memory-c', { status: 'deprecated', slotSubject: 'Mina', slotCardinality: 'single', supersededBy: 'memory-a' }),
    ],
    [{ action: 'merge', memoryId: 'memory-a', mergeIntoId: 'memory-b', reason: 'same slot' }],
  );
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await fixture.consolidator.consolidateRange('all', 'b4-existing-chain');
    assert.equal(fixture.statusRequests.length, 0);
    assert.equal(warnings.some(warning => warning.includes('merge cycle rejected')), true);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('B4: rewritten text is marked as needing a vector refresh', async () => {
  const fixture = makeConsolidator(
    [makeMemory('memory-a')],
    [{ action: 'update', memoryId: 'memory-a', newText: 'rewritten text', reason: 'clarified' }],
  );
  try {
    await fixture.consolidator.consolidateRange('all', 'b4-vector');
    assert.equal(fixture.updates.length, 1);
    assert.equal(fixture.updates[0].patch.text, 'rewritten text');
    assert.equal(JSON.parse(fixture.updates[0].patch.metadata).vectorNeedsRecompute, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('B4: rewritten text is re-embedded when an embedder is available', async () => {
  const embedded = [];
  const fixture = makeConsolidator(
    [makeMemory('memory-a')],
    [{ action: 'update', memoryId: 'memory-a', newText: 'rewritten text', reason: 'clarified' }],
    { embed: async (text, kind) => { embedded.push([text, kind]); return [0.9, 0.1]; } },
  );
  try {
    await fixture.consolidator.consolidateRange('all', 'b4-reembed');
    assert.deepEqual(embedded, [['rewritten text', 'store']]);
    assert.deepEqual(fixture.updates[0].newVector, [0.9, 0.1]);
    assert.equal(JSON.parse(fixture.updates[0].patch.metadata).vectorNeedsRecompute, undefined);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('B4: failed re-embed falls back to the recompute marker', async () => {
  const fixture = makeConsolidator(
    [makeMemory('memory-a')],
    [{ action: 'update', memoryId: 'memory-a', newText: 'rewritten text', reason: 'clarified' }],
    { embed: async () => { throw new Error('ollama down'); } },
  );
  try {
    await fixture.consolidator.consolidateRange('all', 'b4-reembed-fail');
    assert.equal(fixture.updates[0].newVector, undefined);
    assert.equal(JSON.parse(fixture.updates[0].patch.metadata).vectorNeedsRecompute, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
