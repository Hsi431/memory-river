import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';

test('UPDATE keeps the old memory active when writing its replacement fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-update-order-'));
  const procPath = path.join(root, 'pending-update.processing');
  const statusChanges = [];
  const oldMemory = { id: 'parent-1', text: 'old memory', metadata: JSON.stringify({ status: 'active' }) };
  const store = {
    hybridVectorSearch: async () => [],
    getById: async () => oldMemory,
    store: async () => { throw new Error('store failed'); },
  };
  const watcher = new InboxWatcher(
    store,
    { embed: async () => [0.1, 0.2, 0.3, 0.4] },
    { determineRelation: async () => ({ action: 'UPDATE', parentId: oldMemory.id }) },
    null,
    null,
    { generate: async () => '' },
    root,
    2000,
    undefined,
    { changeStatus: async (change) => { statusChanges.push(change); } },
    async () => {},
  );

  try {
    fs.writeFileSync(procPath, JSON.stringify({ text: 'replacement memory', category: 'fact' }));

    await assert.rejects(watcher._processMemoryEntry(procPath), /store failed/);

    assert.deepEqual(statusChanges, []);
    assert.equal(JSON.parse(oldMemory.metadata).status, 'active');
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  }
});
