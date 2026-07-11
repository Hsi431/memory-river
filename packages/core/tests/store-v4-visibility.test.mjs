import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';

function makeRow(id, status = 'active', metadataStatus) {
  return {
    id,
    text: id,
    textTokens: id,
    vector: [0.1, 0.2, 0.3, 0.4],
    importance: 0.5,
    category: 'other',
    parentId: null,
    metadata: JSON.stringify(metadataStatus ? { status: metadataStatus } : {}),
    status,
    createdAt: 1,
    updatedAt: 1,
    _distance: 0.1,
    _score: 1,
  };
}

function makeStore(rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-visibility-'));
  const requestedLimits = [];
  const searchRequests = [];
  const store = new MemoryStore(path.join(root, 'ssd'), path.join(root, 'ram'), 4);
  store.ramTable = {
    search(...args) {
      searchRequests.push(args);
      return {
        limit(limit) {
          requestedLimits.push(limit);
          return { async toArray() { return rows.slice(0, limit); } };
        },
      };
    },
  };
  store.ftsAvailable = true;
  return {
    store,
    requestedLimits,
    searchRequests,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

test('vectorSearch and ftsSearch exclude archived rows and over-fetch past inactive rows', async () => {
  const rows = [
    makeRow('archived-top', 'archived'),
    makeRow('superseded-meta', 'active', 'superseded'),
    makeRow('active-1'),
    makeRow('active-2'),
  ];
  const harness = makeStore(rows);

  try {
    const vector = await harness.store.vectorSearch([0.1, 0.2, 0.3, 0.4], 2);
    const fts = await harness.store.ftsSearch('active', 2);

    assert.deepEqual(vector.map(result => result.entry.id), ['active-1', 'active-2']);
    assert.deepEqual(fts.map(result => result.entry.id), ['active-1', 'active-2']);
    assert.deepEqual(harness.requestedLimits, [22, 22]);
    assert.deepEqual(harness.searchRequests[1], ['active', 'fts', ['textTokens']]);
  } finally {
    harness.cleanup();
  }
});

test('ftsSearch drops non-matching rows before visibility slicing', async () => {
  const rows = [
    makeRow('zero-score-a'),
    makeRow('positive-score'),
    makeRow('zero-score-b'),
  ];
  rows[0]._score = 0;
  rows[1]._score = 0.7;
  rows[2]._score = 0;
  const harness = makeStore(rows);

  try {
    const results = await harness.store.ftsSearch('positive', 5);

    assert.deepEqual(results.map(result => result.entry.id), ['positive-score']);
    assert.equal(results[0].bm25Score, 0.7);
  } finally {
    harness.cleanup();
  }
});

test('ftsSearch returns empty when LanceDB reports only zero-score rows', async () => {
  const rows = [makeRow('zero-score-a'), makeRow('zero-score-b')];
  rows.forEach(row => { row._score = 0; });
  const harness = makeStore(rows);

  try {
    assert.deepEqual(await harness.store.ftsSearch('absent', 5), []);
  } finally {
    harness.cleanup();
  }
});

test('ensureFtsIndex returns before background legacy-row retokenization completes', async () => {
  const harness = makeStore([]);
  const updates = [];
  let createdColumn = '';
  let releaseUpdate;
  const updateGate = new Promise(resolve => { releaseUpdate = resolve; });
  harness.store.ramTable = {
    async listIndices() {
      return [{ indexType: 'FTS', columns: ['text'], name: 'text_idx' }];
    },
    query() {
      return {
        select() {
          return {
            offset() {
              return this;
            },
            limit() {
              return this;
            },
            async toArray() {
              return [{
                id: 'legacy-row',
                text: '星辰科技 uses Zorblax',
                textTokens: '星 辰 科 技 u s e s Z o r b l a x',
              }];
            },
          };
        },
      };
    },
    async update(options) {
      updates.push(options);
      await updateGate;
    },
    async createIndex(column) {
      createdColumn = column;
    },
  };

  try {
    const originalListIndices = harness.store.ramTable.listIndices;
    let listCount = 0;
    harness.store.ramTable.listIndices = async () => {
      listCount++;
      if (listCount === 1) return originalListIndices();
      return [{ indexType: 'FTS', columns: ['textTokens'], name: 'textTokens_idx' }];
    };

    await harness.store.ensureFtsIndex(harness.store.ramTable, 'migration-test');

    assert.equal(createdColumn, 'textTokens');
    assert.equal(updates.length, 0);
    assert.equal(harness.store.ftsAvailable, true);

    await new Promise(resolve => setImmediate(resolve));
    while (updates.length === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(updates[0].values.textTokens.includes('Zorblax'), true);
    assert.equal(updates[0].values.textTokens.includes('Z o r'), false);
    releaseUpdate();
    while (harness.store._ftsRetokenizingTables?.has(harness.store.ramTable)) {
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally {
    harness.cleanup();
  }
});

test('hybridVectorSearch excludes archived candidates', async () => {
  const rows = [
    makeRow('archived', 'active', 'archived'),
    makeRow('active'),
  ];
  const harness = makeStore([]);
  harness.store.vectorSearch = async () => rows.map(row => ({
    entry: row,
    vectorScore: 1,
    rankScore: 1,
    rawDistance: 0.1,
    bm25Score: 0,
    fusedScore: 0,
  }));
  harness.store.ftsSearch = async () => [];
  harness.store.ramTable = {
    query() {
      return {
        where() {
          return {
            select() {
              return {
                limit() {
                  return { async toArray() { return rows.map(row => ({ id: row.id })); } };
                },
              };
            },
          };
        },
      };
    },
  };

  try {
    const results = await harness.store.hybridVectorSearch('query', 2);
    assert.deepEqual(results.map(result => result.entry.id), ['active']);
  } finally {
    harness.cleanup();
  }
});
