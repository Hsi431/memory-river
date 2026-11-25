import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CleanupEngine } from '../dist/lifecycle/cleanup-engine.js';

test('cleanup moves only trashed memories older than retention into JSON trash', async () => {
  const now = Date.now();
  const old = {
    id: 'old-trashed-memory', text: 'old', vector: [0.1], importance: 0.5,
    category: 'fact', parentId: null,
    metadata: JSON.stringify({ status: 'trashed', trashedAt: now - 8 * 24 * 60 * 60 * 1000 }),
    createdAt: now - 20 * 24 * 60 * 60 * 1000, updatedAt: now,
  };
  const recent = {
    ...old,
    id: 'recent-trashed-memory',
    text: 'recent',
    metadata: JSON.stringify({ status: 'trashed', trashedAt: now - 2 * 24 * 60 * 60 * 1000 }),
  };
  const memories = new Map([[old.id, old], [recent.id, recent]]);
  const deleted = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-cleanup-trash-'));
  const trashPath = path.join(root, 'trash');
  const engine = new CleanupEngine({
    decayMemories: async () => ({
      decayed: 0, deleted: 0, coreProtected: 0, wouldDecay: 0, wouldDelete: 0,
      deferredDecay: 0, deferredDelete: 0,
      deleteCandidateSummary: {
        count: 0, firstId: null, lastId: null, minCreatedAt: null, maxCreatedAt: null, createdAtByDay: {},
      },
    }),
    queryAll: async () => [...memories.values()],
    getById: async id => memories.get(id) ?? null,
    delete: async id => { deleted.push(id); memories.delete(id); return true; },
  }, {
    enabled: true, decayDays: 7, deleteBelow: 10, trashPath,
    trashRetentionDays: 7, enableTrashAutoPurge: false,
  });

  try {
    const result = await engine.runSmartCleanup('trash-test');
    assert.deepEqual(deleted, [old.id]);
    assert.deepEqual([...memories.keys()], [recent.id]);
    assert.equal(result.deleted, 1);
    const files = fs.readdirSync(trashPath);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(trashPath, files[0]), 'utf8')), old);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
