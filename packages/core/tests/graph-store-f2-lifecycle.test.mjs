import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CleanupEngine } from '../dist/lifecycle/cleanup-engine.js';
import { GraphStore } from '../dist/store/graph-store.js';
import { StatusManager } from '../dist/store/status-manager.js';

function makeTable(initialRows = []) {
  const rows = [...initialRows];
  function matches(row, predicate) {
    const value = predicate.match(/'((?:''|[^'])*)'/)?.[1]?.replace(/''/g, "'");
    return value === undefined || row.sourceMemoryId === value;
  }
  return {
    rows,
    add: async entries => rows.push(...entries),
    delete: async predicate => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i], predicate)) rows.splice(i, 1);
      }
    },
    query() {
      let predicate = '';
      return {
        where(value) { predicate = value; return this; },
        limit() { return this; },
        toArray: async () => rows.filter(row => matches(row, predicate)),
      };
    },
  };
}

function makeGraphStore(embedder) {
  const graph = new GraphStore({}, {}, embedder, 2);
  graph.ramTable = makeTable();
  graph.ssdTable = makeTable();
  return graph;
}

test('graph triples are removed when a memory becomes deprecated, superseded, or trashed', async () => {
  for (const toStatus of ['deprecated', 'superseded', 'trashed']) {
    const row = {
      id: `triple-${toStatus}`, subject: 'Mina', relation: 'likes', object: 'tea',
      sourceMemoryId: `memory-${toStatus}`, vector: [0.1, 0.2], createdAt: Date.now(),
    };
    const graph = makeGraphStore({ embed: async () => [0.1, 0.2] });
    graph.ramTable.rows.push(row);
    graph.ssdTable.rows.push(row);
    const entry = { metadata: JSON.stringify({ status: 'active' }) };
    const store = {
      getById: async () => entry,
      update: async (_id, patch) => { entry.metadata = patch.metadata; return true; },
      recordStatusAudit: async audit => audit.id,
    };
    const manager = new StatusManager(store, graph);

    const result = await manager.changeStatus({
      memoryId: row.sourceMemoryId,
      toStatus,
      reason: 'test',
      source: 'graph-test',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(await graph.findTriplesByMemoryId(row.sourceMemoryId), []);
    assert.equal(graph.ramTable.rows.length, 0);
    assert.equal(graph.ssdTable.rows.length, 0);
  }
});

test('cleanup deletion also removes triples for the deleted memory', async () => {
  const row = {
    id: 'triple-1', subject: 'Mina', relation: 'likes', object: 'tea',
    sourceMemoryId: 'memory-1', vector: [0.1, 0.2], createdAt: Date.now(),
  };
  const graph = makeGraphStore({ embed: async () => [0.1, 0.2] });
  graph.ramTable.rows.push(row);
  graph.ssdTable.rows.push(row);
  const entry = { id: 'memory-1', text: 'Mina likes tea', metadata: '{}', createdAt: Date.now() };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-graph-delete-'));
  const store = {
    getById: async () => entry,
    delete: async () => true,
  };
  const cleanup = new CleanupEngine(store, {
    enabled: true, decayDays: 7, deleteBelow: 10, trashPath: path.join(root, 'trash'),
  }, graph);

  try {
    assert.equal(await cleanup.delete(entry.id), true);
    assert.deepEqual(await graph.findTriplesByMemoryId(entry.id), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('single triple embedding failure does not write a zero-vector row', async () => {
  const graph = makeGraphStore({ embed: async () => { throw new Error('embedding unavailable'); } });
  const result = await graph.addTriple({ subject: 'Mina', relation: 'likes', object: 'tea' }, 'memory-1');
  assert.equal(result, null);
  assert.deepEqual(graph.ramTable.rows, []);
  assert.deepEqual(graph.ssdTable.rows, []);
});

test('batch triple embedding failure does not write zero-vector rows', async () => {
  const graph = makeGraphStore({
    embed: async () => [0.1, 0.2],
    embedBatch: async () => { throw new Error('batch embedding unavailable'); },
  });
  const results = await graph.addTriples([
    { subject: 'Mina', relation: 'likes', object: 'tea' },
    { subject: 'Mina', relation: 'likes', object: 'coffee' },
  ], 'memory-1');
  assert.deepEqual(results, []);
  assert.deepEqual(graph.ramTable.rows, []);
  assert.deepEqual(graph.ssdTable.rows, []);
});
