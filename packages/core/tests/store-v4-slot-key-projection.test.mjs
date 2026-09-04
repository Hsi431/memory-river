import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';

test('getById(includeAllStatus) returns the persisted slotKey', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-slot-key-projection-'));
  const store = new MemoryStore(path.join(root, 'ssd'), path.join(root, 'ram'), 4);
  const slotKey = 'person:favorite_team';

  try {
    const stored = await store.store({
      text: 'favorite team fact',
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 0.8,
      category: 'preference',
      parentId: null,
      metadata: '{}',
      slotKey,
      slotValue: 'Liverpool',
    });

    const reloaded = await store.getById(stored.id, true);

    assert.ok(reloaded);
    assert.equal(reloaded.slotKey, slotKey);
  } finally {
    await store.shutdown();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  }
});
