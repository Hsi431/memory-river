import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore, SchemaViolationError } from '../dist/store/store-v4.js';

function makePaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-test-'));
  return {
    root,
    ssd: path.join(root, 'ssd'),
    ram: path.join(root, 'ram'),
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
      }
    },
  };
}

test('constructor does not register process signal listeners', async () => {
  const beforeSigterm = process.listenerCount('SIGTERM');
  const beforeSigint = process.listenerCount('SIGINT');
  const store = new MemoryStore('/tmp/unused-ssd', '/tmp/unused-ram', 4);

  try {
    assert.equal(process.listenerCount('SIGTERM'), beforeSigterm);
    assert.equal(process.listenerCount('SIGINT'), beforeSigint);
  } finally {
    await store.shutdown();
  }
});

test('store() clamps importance before insert', async () => {
  const paths = makePaths();
  try {
    const store = new MemoryStore(paths.ssd, paths.ram, 4);
    const stored = await store.store({
      text: 'importance clamp test',
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 8,
      category: 'other',
      parentId: null,
      metadata: '{}',
    });
    assert.equal(stored.importance, 1);
    const row = await store.getById(stored.id);
    assert.equal(row?.importance, 1);
  } finally {
    paths.cleanup();
  }
});

test('store() writes insert and commit WAL records while SSD is degraded', async () => {
  const paths = makePaths();
  const walPath = path.join(paths.root, 'wal.jsonl');
  try {
    const store = new MemoryStore(paths.ssd, paths.ram, 4, walPath);
    await store.ensureInitialized();
    store.ssdAvailable = false;

    const stored = await store.store({
      text: 'durable degraded insert',
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 0.7,
      category: 'other',
      parentId: null,
      metadata: '{}',
    });

    const wal = fs.readFileSync(walPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(wal.length, 2);
    assert.equal(wal[0].action, 'insert');
    assert.equal(wal[0].id, stored.id);
    assert.deepEqual(wal[0].row.vector, stored.vector);
    assert.deepEqual(wal[0].row, stored);
    assert.deepEqual(
      { action: wal[1].action, id: wal[1].id, txnId: wal[1].txnId },
      { action: 'commit', id: stored.id, txnId: wal[0].txnId },
    );
  } finally {
    paths.cleanup();
  }
});

test('schema violation writes metric and throws SchemaViolationError', async () => {
  const paths = makePaths();
  try {
    const store = new MemoryStore(paths.ssd, paths.ram, 4);
    await store.ensureInitialized();
    const broken = {
      id: '',
      text: '',
      vector: [0.1],
      importance: 8,
      confidence: 2,
      metadata: '{}',
      createdAt: 1777969711,
      updatedAt: 1777969711,
    };

    await assert.rejects(
      () => store.rejectSchemaViolation(broken, store.validateEntrySchema(broken)),
      (err) => err instanceof SchemaViolationError && err.violations.includes('id-missing'),
    );

    const table = await store.db.openTable('conflict_stats');
    const rows = await table.query().where("`operationName` = 'schema_violation'").limit(10).toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].finalOutcome, 'rejected');
    assert.equal(rows[0].fragmentId, '<missing-id>');
    assert.match(rows[0].callerPath, /violations=/);
  } finally {
    paths.cleanup();
  }
});
