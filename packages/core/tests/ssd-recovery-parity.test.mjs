import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';

function makeStores(t, root) {
  const stores = [];
  t.after(async () => {
    for (const store of stores) {
      if (!store.testClosed) await store.shutdown();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return () => {
    const store = new MemoryStore(path.join(root, 'ssd'), path.join(root, 'ram'), 4, undefined, undefined, undefined, 60_000);
    store.safeRecordCreationAudit = async () => {};
    stores.push(store);
    return store;
  };
}

async function writeMemory(store, text) {
  return store.store({
    text,
    vector: [0.1, 0.2, 0.3, 0.4],
    importance: 0.5,
    category: 'other',
    parentId: null,
    metadata: '{}',
  });
}

async function snapshot(table) {
  const rows = await table.query().limit(1000).toArray();
  return rows.map(row => ({
    id: row.id,
    text: row.text,
    textTokens: row.textTokens,
    vector: row.vector?.values instanceof Float32Array
      ? Array.from(row.vector.values)
      : Array.from(row.vector ?? []),
    importance: row.importance,
    category: row.category,
    parentId: row.parentId,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sessionId: row.sessionId,
    lastConcentratedAt: row.lastConcentratedAt,
    status: row.status,
    hasHooks: row.hasHooks,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for SSD failure threshold'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test('RAM-only SSD recovery reconciles inserts, updates, and deletes before returning online', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-ssd-recovery-parity-'));
  const createStore = makeStores(t, root);
  const store = createStore();
  await store.ensureInitialized();
  const first = await writeMemory(store, 'before outage');
  const second = await writeMemory(store, 'will be deleted');
  await store.memorySsdWriteQueue;

  store.handleSsdSuccess = () => {};
  const originalAdd = store.ssdTable.add.bind(store.ssdTable);
  store.ssdTable.add = async () => { throw new Error('injected SSD write failure'); };
  for (let index = 0; index < 5; index++) await writeMemory(store, `offline insert ${index}`);
  await waitFor(() => !store.ssdAvailable);
  await store.memorySsdWriteQueue;
  store.ssdTable.add = originalAdd;

  await store.update(first.id, { text: 'updated in RAM-only mode' });
  await store.delete(second.id);
  await writeMemory(store, 'last offline insert');
  await store.memorySsdWriteQueue;
  await store.probeSsdRecovery();

  assert.equal(store.ssdAvailable, true);
  assert.deepEqual(await snapshot(store.ssdTable), await snapshot(store.ramTable));
});

test('RAM-only SSD recovery syncs every row after an outage with more than ten writes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'H1-ssd-recovery-many-'));
  const createStore = makeStores(t, root);
  const store = createStore();
  await store.ensureInitialized();

  store.handleSsdSuccess = () => {};
  const originalAdd = store.ssdTable.add.bind(store.ssdTable);
  store.ssdTable.add = async () => { throw new Error('injected SSD write failure'); };
  for (let index = 0; index < 5; index++) await writeMemory(store, `failure trigger ${index}`);
  await waitFor(() => !store.ssdAvailable);
  await store.memorySsdWriteQueue;

  for (let index = 0; index < 25; index++) await writeMemory(store, `offline memory ${index}`);
  await store.memorySsdWriteQueue;
  store.ssdTable.add = originalAdd;
  await store.probeSsdRecovery();

  assert.equal(await store.ssdTable.countRows(), await store.ramTable.countRows());
  assert.deepEqual(await snapshot(store.ssdTable), await snapshot(store.ramTable));
});

test('SSD sync stops after three changing rounds and leaves another sync pending', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'H1-ssd-sync-round-limit-'));
  const createStore = makeStores(t, root);
  const store = createStore();
  await store.ensureInitialized();
  await writeMemory(store, 'initial memory');
  await store.memorySsdWriteQueue;
  store.ssdAvailable = false;
  store.ssdNeedsSync = true;

  let rounds = 0;
  const warnings = [];
  const originalMergeInsert = store.ssdTable.mergeInsert.bind(store.ssdTable);
  const originalWarn = console.warn;
  store.ssdTable.mergeInsert = (...args) => {
    let merge = originalMergeInsert(...args);
    return {
      whenMatchedUpdateAll(...methodArgs) {
        merge = merge.whenMatchedUpdateAll(...methodArgs);
        return this;
      },
      whenNotMatchedInsertAll(...methodArgs) {
        merge = merge.whenNotMatchedInsertAll(...methodArgs);
        return this;
      },
      async execute(rows) {
        await merge.execute(rows);
        rounds++;
        if (rounds <= 4) await writeMemory(store, `concurrent memory ${rounds}`);
      },
    };
  };
  console.warn = (...values) => warnings.push(values.join(' '));
  try {
    await store.syncSsdFromRam();
    await store.memorySsdWriteQueue;

    assert.deepEqual({
      rounds,
      needsSync: store.ssdNeedsSync,
      warned: warnings.some(message => message.includes('did not converge')),
    }, { rounds: 3, needsSync: true, warned: true });
  } finally {
    store.ssdTable.mergeInsert = originalMergeInsert;
    console.warn = originalWarn;
  }
});

test('startup with non-empty RAM reconciles the SSD from the RAM table', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-ssd-startup-parity-'));
  const createStore = makeStores(t, root);
  const beforeRestart = createStore();
  await beforeRestart.ensureInitialized();
  const entry = await writeMemory(beforeRestart, 'old SSD value');
  await beforeRestart.memorySsdWriteQueue;
  await beforeRestart.shutdown();
  beforeRestart.testClosed = true;

  const ramDb = await import('@lancedb/lancedb').then(({ connect }) => connect(path.join(root, 'ram')));
  const ramTable = await ramDb.openTable('memories');
  await ramTable.update({ text: "'newer RAM value'" }, { where: `id = '${entry.id}'` });
  await ramDb.close();
  fs.writeFileSync(path.join(root, 'wal.jsonl'), '');

  const afterRestart = createStore();
  await afterRestart.ensureInitialized();

  assert.deepEqual(await snapshot(afterRestart.ssdTable), await snapshot(afterRestart.ramTable));
});

test('startup sync never deletes SSD rows that are missing from a partial RAM copy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-ssd-startup-partial-ram-'));
  const createStore = makeStores(t, root);
  const beforeRestart = createStore();
  await beforeRestart.ensureInitialized();
  const kept = await writeMemory(beforeRestart, 'present in RAM');
  const onlyOnSsd = await writeMemory(beforeRestart, 'missing from partial RAM');
  await beforeRestart.memorySsdWriteQueue;
  await beforeRestart.shutdown();
  beforeRestart.testClosed = true;

  const ramDb = await import('@lancedb/lancedb').then(({ connect }) => connect(path.join(root, 'ram')));
  const ramTable = await ramDb.openTable('memories');
  await ramTable.delete(`id = '${onlyOnSsd.id}'`);
  await ramDb.close();
  fs.writeFileSync(path.join(root, 'wal.jsonl'), '');

  const afterRestart = createStore();
  await afterRestart.ensureInitialized();

  const ssdIds = (await afterRestart.ssdTable.query().toArray()).map(row => String(row.id));
  assert.ok(ssdIds.includes(onlyOnSsd.id), 'SSD backup row must survive a partial RAM copy');
  assert.ok(ssdIds.includes(kept.id));
});
