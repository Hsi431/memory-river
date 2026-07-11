import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';

function makePaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-hooks-'));
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

test('queryHookBearing returns only memories with hooks and does not materialize vectors', async () => {
  const paths = makePaths();
  try {
    const store = new MemoryStore(paths.ssd, paths.ram, 4);
    const withHook = await store.store({
      text: 'hook-bearing memory',
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 0.7,
      category: 'fact',
      parentId: null,
      metadata: JSON.stringify({
        hooks: [{ keyword: 'database migration', weight: 'high', weightScore: 1 }],
      }),
    });
    const withoutHook = await store.store({
      text: 'plain memory',
      vector: [0.4, 0.3, 0.2, 0.1],
      importance: 0.7,
      category: 'fact',
      parentId: null,
      metadata: '{}',
    });

    const hookBearing = await store.queryHookBearing();

    assert.deepEqual(hookBearing.map((entry) => entry.id), [withHook.id]);
    assert.deepEqual(hookBearing[0].vector, []);
    assert.equal(Object.hasOwn(hookBearing[0], 'vector'), true);

    const table = await store.db.openTable('memories');
    const rows = await table.query()
      .select(['id', 'hasHooks'])
      .where(`id = '${withHook.id}' OR id = '${withoutHook.id}'`)
      .toArray();
    const byId = new Map(rows.map((row) => [row.id, row.hasHooks]));
    assert.equal(byId.get(withHook.id), true);
    assert.equal(byId.get(withoutHook.id), false);
  } finally {
    paths.cleanup();
  }
});

test('metadata updates keep hasHooks derived from metadata.hooks', async () => {
  const paths = makePaths();
  try {
    const store = new MemoryStore(paths.ssd, paths.ram, 4);
    const stored = await store.store({
      text: 'updatable memory',
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 0.7,
      category: 'fact',
      parentId: null,
      metadata: '{}',
    });

    await store.update(stored.id, {
      metadata: JSON.stringify({
        hooks: [{ keyword: 'new hook', weight: 'medium', weightScore: 0.7 }],
      }),
    });
    assert.deepEqual((await store.queryHookBearing()).map((entry) => entry.id), [stored.id]);

    await store.update(stored.id, { metadata: JSON.stringify({ hooks: [] }) });
    assert.deepEqual(await store.queryHookBearing(), []);
  } finally {
    paths.cleanup();
  }
});
