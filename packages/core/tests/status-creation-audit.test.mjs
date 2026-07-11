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
    await fn({ store });
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

test('new memory creation initializes active status and records creation audit', async () => {
  await withTempStore('status-creation-audit-', async ({ store }) => {
    const stored = await store.store({
      text: 'creation audit test',
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 0.7,
      category: 'free_text',
      parentId: null,
      metadata: JSON.stringify({ source: 'test' }),
      creationAuditSource: 'test.creation',
    });

    const reloaded = await store.getById(stored.id);
    assert.ok(reloaded);
    assert.equal(JSON.parse(reloaded.metadata).status, 'active');

    const auditRows = await store.queryStatusAudit({
      memoryId: stored.id,
      source: 'test.creation',
      limit: 5,
    });

    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].fromStatus, null);
    assert.equal(auditRows[0].toStatus, 'active');
    assert.equal(auditRows[0].reason, 'created');
    assert.equal(auditRows[0].partial, false);
  });
});
