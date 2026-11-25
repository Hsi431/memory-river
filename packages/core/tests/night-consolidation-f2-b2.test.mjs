import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NightConsolidator } from '../dist/lifecycle/night-consolidation.js';

test('B2: night prompt does not label the current memory as superseded by itself', async () => {
  const now = Date.now();
  const current = {
    id: 'current-memory', text: 'current', vector: [0.1], importance: 0.5,
    category: 'fact', parentId: null, metadata: '{"status":"active"}',
    createdAt: now, updatedAt: now, slotKey: 'profile:city', slotValue: 'Taipei',
  };
  const other = { ...current, id: 'other-memory', text: 'other' };
  let prompt = '';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-night-b2-'));
  const consolidator = new NightConsolidator({
    queryAll: async () => [current],
    getById: async id => id === current.id ? current : null,
    update: async () => true,
    delete: async () => true,
    searchBySlotKey: async () => [current, other],
  }, {
    concentrator: { generate: async value => { prompt = value; return '{"decisions":[],"summary":"test"}'; } },
    statusManager: { changeStatusBatch: async () => [] },
  }, path.join(root, 'night.jsonl'));

  try {
    await consolidator.consolidateRange('all', 'b2-test');
    const tag = prompt.match(/已被替代 by: ([^\]]+)/)?.[1] ?? '';
    assert.deepEqual(tag.split(', ').filter(Boolean), ['other-me']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
