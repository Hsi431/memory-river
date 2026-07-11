import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';

function makeQueryRows(rows) {
  return {
    query() {
      return {
        limit() {
          return {
            async toArray() {
              return rows;
            },
          };
        },
      };
    },
  };
}

function makeStore(rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-decay-null-id-'));
  const store = new MemoryStore(
    path.join(root, 'ssd'),
    path.join(root, 'ram'),
    8,
    {
      initialScore: 100,
      decayPerRun: 5,
      decayIntervalMs: 24 * 60 * 60 * 1000,
      deleteThreshold: 0,
      coreCategories: ['identity', 'constraint', 'business', 'core_rule'],
      coreImportanceThreshold: 0.85,
    },
  );
  store.ramTable = makeQueryRows(rows);
  return store;
}

function makeRows() {
  return [
    {
      id: '11111111-1111-4111-8111-111111111111',
      text: 'valid row',
      category: 'other',
      importance: 0.1,
      metadata: JSON.stringify({
        health: {
          healthScore: 1,
          lastAccessedAt: 1,
          lastDecayedAt: 1,
          accessCount: 0,
          decayCount: 0,
        },
      }),
      createdAt: 1,
    },
    { id: null, text: 'null id row', category: 'other', importance: 0.1, metadata: '{}', createdAt: 2 },
    { text: 'undefined id row', category: 'other', importance: 0.1, metadata: '{}', createdAt: 3 },
    { id: 123, text: 'number id row', category: 'other', importance: 0.1, metadata: '{}', createdAt: 4 },
  ];
}

async function withWarnCapture(fn) {
  const originalWarn = console.warn;
  const calls = [];
  console.warn = (...args) => {
    calls.push(args);
  };
  try {
    const result = await fn(calls);
    return { result, calls };
  } finally {
    console.warn = originalWarn;
  }
}

test('decayMemories skips rows with invalid id and processes valid rows', async () => {
  const store = makeStore(makeRows());

  const { result, calls } = await withWarnCapture(() =>
    store.decayMemories(5, 0, { dryRun: true }),
  );

  assert.equal(result.wouldDelete, 1);
  assert.equal(result.deleteCandidateSummary.count, 1);
  assert.equal(result.deleteCandidateSummary.firstId, '11111111-1111-4111-8111-111111111111');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([message]) => message === '[decayMemories] skipping row with invalid id:'));
});

test('getHealthStats skips rows with invalid id and processes valid rows', async () => {
  const store = makeStore(makeRows());

  const { result, calls } = await withWarnCapture(() =>
    store.getHealthStats(),
  );

  assert.equal(result.total, 4);
  assert.equal(result.core, 0);
  assert.equal(result.healthy, 0);
  assert.equal(result.decaying, 0);
  assert.equal(result.critical, 1);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([message]) => message === '[getHealthStats] skipping row with invalid id:'));
});
