import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';

function makeTempPaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const ram = path.join(root, 'ram-db');
  const ssd = path.join(root, 'ssd-db');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ram, { recursive: true });
  fs.mkdirSync(ssd, { recursive: true });
  return { root, home, ram, ssd };
}

async function withTempStore(prefix, fn) {
  const paths = makeTempPaths(prefix);
  const oldHome = process.env.HOME;
  process.env.HOME = paths.home;

  const store = new MemoryStore(paths.ssd, paths.ram, 4, undefined, {
    embed: async () => [0, 0, 0, 0],
  });

  try {
    await store.ensureInitialized();
    await fn({ store, paths });
  } finally {
    await store.shutdown?.().catch?.(() => {});
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    try {
      fs.rmSync(paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${paths.root}:`, error?.code ?? error);
    }
  }
}

test('subsystem_effectiveness table is initialized', async () => {
  await withTempStore('subsystem-effectiveness-init-', async ({ store }) => {
    const tableNames = await store.db.tableNames();
    assert.ok(tableNames.includes('subsystem_effectiveness'));
  });
});

test('recordSubsystemEffectiveness appends a readable event', async () => {
  await withTempStore('subsystem-effectiveness-record-', async ({ store }) => {
    await store.recordSubsystemEffectiveness({
      ts: '2026-05-06T00:00:00.000Z',
      subsystem: 'causal_chain',
      event: 'relation_created',
      entityId: 'memory-1',
      relatedId: 'parent-1',
      sessionKey: 'session-key-1',
      sessionId: 'host-session-1',
      queryHash: 'q1',
      outcome: 'created',
      count: 2,
      score: 0.75,
      durationMs: 12,
      metadata: { source: 'test' },
    });

    const rows = await store.querySubsystemEffectiveness({ limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subsystem, 'causal_chain');
    assert.equal(rows[0].event, 'relation_created');
    assert.equal(rows[0].entityId, 'memory-1');
    assert.equal(rows[0].relatedId, 'parent-1');
    assert.equal(rows[0].sessionKey, 'session-key-1');
    assert.equal(rows[0].sessionId, 'host-session-1');
    assert.equal(rows[0].queryHash, 'q1');
    assert.equal(rows[0].outcome, 'created');
    assert.equal(rows[0].count, 2);
    assert.equal(rows[0].score, 0.75);
    assert.equal(rows[0].durationMs, 12);
    assert.deepEqual(JSON.parse(rows[0].metadata), { source: 'test' });
  });
});

test('querySubsystemEffectiveness filters by subsystem', async () => {
  await withTempStore('subsystem-effectiveness-filter-', async ({ store }) => {
    await store.recordSubsystemEffectiveness({ subsystem: 'hooks', event: 'hook_triggered', entityId: 'keyword-1' });
    await store.recordSubsystemEffectiveness({ subsystem: 'gwm', event: 'prompt_included', entityId: 'task-1' });
    await store.recordSubsystemEffectiveness({ subsystem: 'hooks', event: 'hook_triggered', entityId: 'keyword-2' });

    const rows = await store.querySubsystemEffectiveness({ subsystem: 'hooks', limit: 10 });
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map(row => row.entityId)), new Set(['keyword-1', 'keyword-2']));
  });
});

test('querySubsystemEffectiveness filters by since timestamp', async () => {
  await withTempStore('subsystem-effectiveness-since-', async ({ store }) => {
    await store.recordSubsystemEffectiveness({
      ts: '2026-05-06T00:00:00.000Z',
      subsystem: 'conflict',
      event: 'candidate_seen',
      entityId: 'old',
    });
    await store.recordSubsystemEffectiveness({
      ts: '2026-05-06T00:00:01.000Z',
      subsystem: 'conflict',
      event: 'candidate_seen',
      entityId: 'new',
    });

    const rows = await store.querySubsystemEffectiveness({
      since: '2026-05-06T00:00:00.500Z',
      limit: 10,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entityId, 'new');
  });
});

test('recordSubsystemEffectiveness fills missing fields with non-null defaults', async () => {
  await withTempStore('subsystem-effectiveness-defaults-', async ({ store }) => {
    await store.recordSubsystemEffectiveness({});

    const rows = await store.querySubsystemEffectiveness({ limit: 1 });
    assert.equal(rows.length, 1);
    assert.ok(rows[0].id);
    assert.ok(rows[0].ts);
    assert.equal(rows[0].subsystem, '');
    assert.equal(rows[0].event, '');
    assert.equal(rows[0].entityId, '');
    assert.equal(rows[0].relatedId, '');
    assert.equal(rows[0].sessionKey, '');
    assert.equal(rows[0].sessionId, '');
    assert.equal(rows[0].queryHash, '');
    assert.equal(rows[0].outcome, '');
    assert.equal(rows[0].count, 0);
    assert.equal(rows[0].score, 0);
    assert.equal(rows[0].durationMs, 0);
    assert.equal(rows[0].metadata, '');
  });
});

test('recordSubsystemEffectiveness is append-only', async () => {
  await withTempStore('subsystem-effectiveness-append-', async ({ store }) => {
    await store.recordSubsystemEffectiveness({ subsystem: 'skill_capsule', event: 'path_a', entityId: 'skill-1' });
    await store.recordSubsystemEffectiveness({ subsystem: 'skill_capsule', event: 'path_b', entityId: 'skill-1' });

    const rows = await store.querySubsystemEffectiveness({ subsystem: 'skill_capsule', limit: 10 });
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map(row => row.event)), new Set(['path_a', 'path_b']));
  });
});
