import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';

function makeRow(id, healthScore) {
  const now = Date.now();
  return {
    id,
    text: id,
    category: 'history',
    importance: 0.1,
    metadata: JSON.stringify({ health: { healthScore, lastAccessedAt: now, lastDecayedAt: now, accessCount: 0, decayCount: 0 } }),
    createdAt: now,
  };
}

test('decayMemories scans rows beyond the former 10000-row ceiling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-decay-pagination-'));
  const store = new MemoryStore(path.join(root, 'ssd'), path.join(root, 'ram'), 8, {
    initialScore: 100,
    decayPerRun: 5,
    decayIntervalMs: 24 * 60 * 60 * 1000,
    deleteThreshold: 0,
    coreCategories: ['identity', 'constraint', 'business', 'core_rule'],
    coreImportanceThreshold: 0.85,
  });
  const rows = Array.from({ length: 10000 }, (_, index) => makeRow(`row-${index}`, 100));
  rows.push(makeRow('row-after-limit', 0));
  store.ensureInitialized = async () => {};
  store.ramTable = {
    query() {
      let offset = 0;
      let limit = Infinity;
      const query = {
        offset(value) { offset = value; return query; },
        limit(value) { limit = value; return query; },
        async toArray() { return rows.slice(offset, offset + limit); },
      };
      return query;
    },
  };

  try {
    const result = await store.decayMemories(5, 0, { dryRun: true });
    assert.equal(result.wouldDelete, 1);
    assert.equal(result.deleteCandidateSummary.lastId, 'row-after-limit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
