import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';

const ID_ONE = '11111111-1111-4111-8111-111111111111';
const ID_TWO = '22222222-2222-4222-8222-222222222222';

function insertRow(id, text) {
  return {
    id,
    text,
    textTokens: text,
    vector: [0.1, 0.2, 0.3, 0.4],
    importance: 0.5,
    category: 'other',
    parentId: null,
    metadata: '{}',
    createdAt: 1,
    updatedAt: 1,
    confidence: null,
    slotKey: null,
    slotValue: null,
    extractionDomain: null,
    supersedes: null,
    lastConcentratedAt: null,
    sessionId: null,
    status: 'active',
  };
}

function makeWal(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-wal-'));
  const walPath = path.join(root, 'wal.jsonl');
  fs.writeFileSync(
    walPath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''),
  );
  return {
    root,
    walPath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

function readWal(walPath) {
  const content = fs.readFileSync(walPath, 'utf8').trim();
  return content ? content.split('\n').map((line) => JSON.parse(line)) : [];
}

function makeTable(initialRows = [], onUpdate, { failMergeOnNull = false } = {}) {
  const rows = initialRows.map((row) => ({ ...row }));
  return {
    rows,
    async countRows(where) {
      const id = where?.match(/id = '([^']+)'/)?.[1];
      return id ? rows.filter((candidate) => candidate.id === id).length : rows.length;
    },
    async add(newRows) {
      rows.push(...newRows.map((row) => ({ ...row })));
    },
    async update(values, opts) {
      // 模擬真 LanceDB 的兩種多載:
      // update(map, {where}) 的 map 是 SQL 表達式,值必須是字串(原始陣列會炸);
      // update({where, values}) 的 values 吃原始 JS 值(vector 走這條)。
      const isObjectForm = opts === undefined && values && typeof values.where === 'string';
      const where = isObjectForm ? values.where : opts.where;
      const assign = isObjectForm ? values.values : values;
      if (!isObjectForm) {
        for (const [key, value] of Object.entries(assign)) {
          if (typeof value !== 'string') {
            throw new Error(`SQL update map requires string expressions, got ${typeof value} for '${key}'`);
          }
        }
      }
      const id = where.match(/id = '([^']+)'/)?.[1];
      await onUpdate?.(id);
      const row = rows.find((candidate) => candidate.id === id);
      if (row) Object.assign(row, assign);
    },
    async delete(where) {
      const id = where.match(/id = '([^']+)'/)?.[1];
      const index = rows.findIndex((candidate) => candidate.id === id);
      if (index >= 0) rows.splice(index, 1);
    },
    mergeInsert() {
      return {
        whenNotMatchedInsertAll() {
          return this;
        },
        async execute(newRows) {
          if (failMergeOnNull && newRows.some((row) => row.parentId === null)) {
            throw new Error('makeVector cannot infer the type');
          }
          for (const row of newRows) {
            if (!rows.some((candidate) => candidate.id === row.id)) {
              rows.push({ ...row });
            }
          }
        },
      };
    },
  };
}

function makeRecoveryStore(walPath, {
  checkpoint = 0,
  failOnceForId,
  ssdFailOnceForId,
  ramRows = [],
  ssdRows = [],
  ssdAvailable = true,
  failMergeOnNull = false,
} = {}) {
  let currentCheckpoint = checkpoint;
  let failed = false;
  const replayedIds = [];
  const onUpdate = async (id) => {
    if (id === failOnceForId && !failed) {
      failed = true;
      throw new Error('injected replay failure');
    }
    replayedIds.push(id);
  };
  let ssdFailed = false;
  const onSsdUpdate = async (id) => {
    if (id === ssdFailOnceForId && !ssdFailed) {
      ssdFailed = true;
      throw new Error('injected SSD write failure');
    }
  };
  const store = {
    walPath,
    ssdAvailable,
    ramTable: makeTable(ramRows, onUpdate, { failMergeOnNull }),
    ssdTable: makeTable(ssdRows, onSsdUpdate, { failMergeOnNull }),
    validateId() {},
    async getLastCommittedTxnId() {
      return currentCheckpoint;
    },
    async updateWalMetadata(txnId) {
      currentCheckpoint = txnId;
    },
    async rewriteWal(entries) {
      return await MemoryStore.prototype.rewriteWal.call(this, entries);
    },
    async clearWal() {
      return await MemoryStore.prototype.clearWal.call(this);
    },
  };

  return {
    store,
    replayedIds,
    getCheckpoint: () => currentCheckpoint,
    getRamRows: () => store.ramTable.rows,
    getSsdRows: () => store.ssdTable.rows,
  };
}

async function recover(store) {
  await MemoryStore.prototype.recoverFromWal.call(store);
}

test('WAL txn counter resumes above the persisted checkpoint after restart', async () => {
  const paths = makeWal([
    { action: 'update', id: ID_ONE, values: { text: 'old' }, txnId: 40, timestamp: 1 },
  ]);
  try {
    const store = {
      walPath: paths.walPath,
      walTxnCounter: 0,
      async getLastCommittedTxnId() {
        return 500;
      },
    };

    await MemoryStore.prototype.restoreWalTxnCounter.call(store);
    const txnId = await MemoryStore.prototype.appendWal.call(store, {
      action: 'update',
      id: ID_TWO,
      values: { text: 'new' },
    });

    assert.equal(txnId, 501);
    assert.equal(readWal(paths.walPath).at(-1).txnId, 501);
  } finally {
    paths.cleanup();
  }
});

test('WAL checkpoint never decreases when updates arrive out of order', async () => {
  let persistedCheckpoint = 0;
  const metadataTable = {
    mergeInsert() {
      return {
        whenMatchedUpdateAll() {
          return this;
        },
        whenNotMatchedInsertAll() {
          return this;
        },
        async execute(rows) {
          persistedCheckpoint = Number(rows.toArray()[0].last_committed_txn_id);
        },
      };
    },
  };
  const store = {
    lastCheckpointTxnId: 0,
    walCheckpointInitialized: false,
    walCheckpointUpdateQueue: Promise.resolve(),
    ssdAvailable: false,
    walMetadataRamTable: metadataTable,
    async ensureWalMetadataTables() {},
    async getLastCommittedTxnId() {
      return persistedCheckpoint;
    },
  };

  await MemoryStore.prototype.updateWalMetadata.call(store, 12);
  await MemoryStore.prototype.updateWalMetadata.call(store, 7);

  assert.equal(await store.getLastCommittedTxnId(), 12);
});

test('failed replay keeps the failed transaction and later WAL entries for the next recovery', async () => {
  const paths = makeWal([
    { action: 'update', id: ID_ONE, values: { text: 'one' }, txnId: 1, timestamp: 1 },
    { action: 'commit', id: ID_ONE, txnId: 1, timestamp: 2 },
    { action: 'update', id: ID_TWO, values: { text: 'two' }, txnId: 2, timestamp: 3 },
    { action: 'commit', id: ID_TWO, txnId: 2, timestamp: 4 },
  ]);
  try {
    const recovery = makeRecoveryStore(paths.walPath, { failOnceForId: ID_TWO });

    await recover(recovery.store);

    assert.equal(recovery.getCheckpoint(), 1);
    assert.deepEqual(recovery.replayedIds, [ID_ONE]);
    assert.deepEqual(readWal(paths.walPath).map((entry) => [entry.action, entry.txnId]), [
      ['update', 2],
      ['commit', 2],
    ]);

    await recover(recovery.store);

    assert.equal(recovery.getCheckpoint(), 2);
    assert.deepEqual(recovery.replayedIds, [ID_ONE, ID_TWO]);
    assert.deepEqual(readWal(paths.walPath), []);
  } finally {
    paths.cleanup();
  }
});

test('successful replay clears the WAL', async () => {
  const paths = makeWal([
    { action: 'update', id: ID_ONE, values: { text: 'one' }, txnId: 7, timestamp: 1 },
    { action: 'commit', id: ID_ONE, txnId: 7, timestamp: 2 },
  ]);
  try {
    const recovery = makeRecoveryStore(paths.walPath, { checkpoint: 6 });

    await recover(recovery.store);

    assert.equal(recovery.getCheckpoint(), 7);
    assert.deepEqual(recovery.replayedIds, [ID_ONE]);
    assert.deepEqual(readWal(paths.walPath), []);
  } finally {
    paths.cleanup();
  }
});

test('committed insert replay restores a row missing from SSD', async () => {
  const row = insertRow(ID_ONE, 'restore me');
  const paths = makeWal([
    { action: 'insert', id: ID_ONE, row, txnId: 8, timestamp: 1 },
    { action: 'commit', id: ID_ONE, txnId: 8, timestamp: 2 },
  ]);
  try {
    // commitWal may have advanced the checkpoint before the async SSD insert landed.
    const recovery = makeRecoveryStore(paths.walPath, {
      checkpoint: 8,
      ramRows: [row],
    });

    await recover(recovery.store);

    assert.deepEqual(recovery.getSsdRows().map((entry) => entry.id), [ID_ONE]);
    assert.deepEqual(readWal(paths.walPath), []);
  } finally {
    paths.cleanup();
  }
});

test('committed update is backfilled to SSD after a failed SSD write', async () => {
  const staleRow = insertRow(ID_ONE, 'stale');
  const paths = makeWal([
    { action: 'update', id: ID_ONE, values: { importance: 0.9 }, txnId: 8, timestamp: 1 },
    { action: 'commit', id: ID_ONE, txnId: 8, timestamp: 2 },
  ]);
  try {
    const recovery = makeRecoveryStore(paths.walPath, {
      checkpoint: 8,
      ssdFailOnceForId: ID_ONE,
      ramRows: [{ ...staleRow, importance: 0.9 }],
      ssdRows: [staleRow],
    });

    await recover(recovery.store);
    assert.equal(recovery.getSsdRows()[0].importance, 0.5);
    assert.notDeepEqual(readWal(paths.walPath), []);

    await recover(recovery.store);
    assert.equal(Number(recovery.getSsdRows()[0].importance), 0.9);
    assert.deepEqual(readWal(paths.walPath), []);
  } finally {
    paths.cleanup();
  }
});

test('insert replay with null nullable fields drains WAL and advances checkpoint', async () => {
  const row = insertRow(ID_ONE, 'nullable fields');
  const paths = makeWal([
    { action: 'insert', id: ID_ONE, row, txnId: 8, timestamp: 1 },
    { action: 'commit', id: ID_ONE, txnId: 8, timestamp: 2 },
  ]);
  try {
    const recovery = makeRecoveryStore(paths.walPath, { failMergeOnNull: true });

    await recover(recovery.store);

    assert.equal(recovery.getCheckpoint(), 8);
    assert.deepEqual(recovery.getRamRows(), [row]);
    assert.deepEqual(recovery.getSsdRows(), [row]);
    assert.deepEqual(readWal(paths.walPath), []);
  } finally {
    paths.cleanup();
  }
});

test('insert replay is idempotent when SSD already contains the id', async () => {
  const row = insertRow(ID_ONE, 'already durable');
  const paths = makeWal([
    { action: 'insert', id: ID_ONE, row, txnId: 9, timestamp: 1 },
    { action: 'commit', id: ID_ONE, txnId: 9, timestamp: 2 },
  ]);
  try {
    const recovery = makeRecoveryStore(paths.walPath, {
      checkpoint: 9,
      ramRows: [row],
      ssdRows: [row],
    });

    await recover(recovery.store);

    assert.equal(recovery.getRamRows().filter((entry) => entry.id === ID_ONE).length, 1);
    assert.equal(recovery.getSsdRows().filter((entry) => entry.id === ID_ONE).length, 1);
  } finally {
    paths.cleanup();
  }
});

test('uncommitted insert is rolled forward to both stores', async () => {
  const row = insertRow(ID_ONE, 'crashed before commit');
  const paths = makeWal([
    { action: 'insert', id: ID_ONE, row, txnId: 10, timestamp: 1 },
  ]);
  try {
    const recovery = makeRecoveryStore(paths.walPath);

    await recover(recovery.store);

    assert.deepEqual(recovery.getRamRows(), [row]);
    assert.deepEqual(recovery.getSsdRows(), [row]);
    assert.deepEqual(readWal(paths.walPath), []);
  } finally {
    paths.cleanup();
  }
});

test('uncommitted update carrying a re-embedded vector replays the vector as a raw array', async () => {
  const row = insertRow(ID_ONE, 'old text');
  const newVector = [0.9, 0.8, 0.7, 0.6];
  const paths = makeWal([
    {
      action: 'update',
      id: ID_ONE,
      values: { text: 'new text', updatedAt: 2, vector: newVector },
      txnId: 3,
      timestamp: 1,
    },
  ]);
  try {
    const recovery = makeRecoveryStore(paths.walPath, { ramRows: [row], ssdRows: [row] });

    await recover(recovery.store);

    assert.deepEqual(recovery.getRamRows()[0].vector, newVector);
    assert.deepEqual(recovery.getSsdRows()[0].vector, newVector);
    assert.equal(recovery.getRamRows()[0].text, "'new text'");
    assert.deepEqual(readWal(paths.walPath), []);
  } finally {
    paths.cleanup();
  }
});

test('SSD fallback replays insert, update, and delete through its single persistent table', async () => {
  const paths = makeWal([
    { action: 'insert', id: ID_ONE, row: insertRow(ID_ONE, 'before update'), txnId: 13, timestamp: 1 },
    { action: 'update', id: ID_ONE, values: { text: 'after update' }, txnId: 14, timestamp: 2 },
    { action: 'delete', id: ID_ONE, txnId: 15, timestamp: 3 },
  ]);
  const store = new MemoryStore(paths.root, paths.root, 4, paths.walPath);
  const table = makeTable();
  let checkpoint = 0;
  store.ssdAvailable = false;
  store.ramTable = table;
  store.ssdTable = table;
  store.validateId = () => {};
  store.getLastCommittedTxnId = async () => checkpoint;
  store.updateWalMetadata = async (txnId) => {
    checkpoint = txnId;
  };

  try {
    await recover(store);

    assert.equal(checkpoint, 15);
    assert.deepEqual(table.rows, []);
    assert.deepEqual(readWal(paths.walPath), []);
  } finally {
    paths.cleanup();
  }
});

for (const action of ['update', 'delete']) {
  test(`SSD-unavailable ${action} replay keeps WAL for retry`, async () => {
    const row = insertRow(ID_ONE, 'stale');
    const paths = makeWal([
      action === 'update'
        ? { action, id: ID_ONE, values: { importance: 0.9 }, txnId: 12, timestamp: 1 }
        : { action, id: ID_ONE, txnId: 12, timestamp: 1 },
      { action: 'commit', id: ID_ONE, txnId: 12, timestamp: 2 },
    ]);
    try {
      const recovery = makeRecoveryStore(paths.walPath, {
        ramRows: [row],
        ssdRows: [row],
        ssdAvailable: false,
      });

      await recover(recovery.store);

      assert.equal(recovery.getCheckpoint(), 0);
      assert.deepEqual(readWal(paths.walPath).map((entry) => entry.action), [action, 'commit']);
    } finally {
      paths.cleanup();
    }
  });
}

test('batch update replay failure keeps checkpoint and WAL for retry', async () => {
  const paths = makeWal([
    {
      action: 'batch_update',
      ids: [ID_ONE, ID_TWO],
      count: 2,
      entries: [
        { id: ID_ONE, metadata: '{"value":1}' },
        { id: ID_TWO, metadata: '{"value":2}' },
      ],
      txnId: 11,
      timestamp: 1,
    },
    { action: 'commit', id: 'batch', txnId: 11, timestamp: 2 },
  ]);
  try {
    const recovery = makeRecoveryStore(paths.walPath, {
      failOnceForId: ID_TWO,
      ramRows: [
        insertRow(ID_ONE, 'one'),
        insertRow(ID_TWO, 'two'),
      ],
      ssdRows: [
        insertRow(ID_ONE, 'one'),
        insertRow(ID_TWO, 'two'),
      ],
    });

    await recover(recovery.store);

    assert.equal(recovery.getCheckpoint(), 0);
    assert.deepEqual(readWal(paths.walPath).map((entry) => [entry.action, entry.txnId]), [
      ['batch_update', 11],
      ['commit', 11],
    ]);
  } finally {
    paths.cleanup();
  }
});

test('batch update row failure rejects without committing the WAL transaction', async () => {
  const paths = makeWal([]);
  const store = new MemoryStore(
    path.join(paths.root, 'ssd'),
    path.join(paths.root, 'ram'),
    4,
    paths.walPath,
  );
  store.ensureInitialized = async () => {};
  store.ssdAvailable = false;
  store.ramTable = makeTable([], async (id) => {
    if (id === ID_TWO) throw new Error('injected row failure');
  });

  try {
    await assert.rejects(
      store.batchUpdateMemories([
        { id: ID_ONE, metadata: '{"value":1}' },
        { id: ID_TWO, metadata: '{"value":2}' },
      ]),
      /batch_update failed for ids: 22222222-2222-4222-8222-222222222222/,
    );

    const entries = readWal(paths.walPath);
    assert.deepEqual(entries.map(entry => entry.action), ['batch_update']);
    assert.equal(entries[0].ids.includes(ID_TWO), true);
  } finally {
    paths.cleanup();
  }
});
