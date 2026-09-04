import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';

async function processSlotFallback({ oldSubject, newSubject }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-slot-subject-fallback-'));
  const procPath = path.join(root, 'pending.processing');
  const oldMemory = {
    id: 'old-memory',
    slotKey: 'person:favorite_game',
    metadata: JSON.stringify({ status: 'active', subject: oldSubject }),
  };
  const statusChanges = [];
  const stored = [];
  const store = {
    hybridVectorSearch: async () => [],
    searchBySlotKey: async () => [oldMemory],
    store: async input => {
      const entry = { id: 'new-memory', ...input };
      stored.push(entry);
      return entry;
    },
  };
  const watcher = new InboxWatcher(
    store,
    { embed: async () => [0.1, 0.2, 0.3, 0.4] },
    { determineRelation: async () => ({ action: 'INDEPENDENT', parentId: null }) },
    null,
    null,
    {
      generate: async () => JSON.stringify({
        slotKey: 'person:favorite_game',
        slotValue: 'Apex Legends',
        subject: null,
        cardinality: 'single',
        confidence: 0.9,
        extractionDomain: 'preference',
        isStructured: true,
      }),
    },
    root,
    2000,
    undefined,
    {
      changeStatus: async change => statusChanges.push(change),
    },
    async () => {},
  );

  fs.writeFileSync(procPath, JSON.stringify({
    text: 'favorite game fact',
    category: 'preference',
    importance: 0.8,
    metadata: { subject: newSubject },
  }));

  try {
    await watcher._processMemoryEntry(procPath);
    return { oldMemory, stored, statusChanges };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('metadata.subject fallback supersedes when the effective subjects match', async () => {
  const result = await processSlotFallback({ oldSubject: ' John ', newSubject: 'JOHN' });

  assert.equal(result.statusChanges.length, 1);
  assert.equal(result.statusChanges[0].memoryId, 'old-memory');
  assert.equal(JSON.parse(result.stored[0].metadata).subject, 'JOHN');
});

test('metadata.subject fallback keeps a different subject active', async () => {
  const result = await processSlotFallback({ oldSubject: 'John', newSubject: 'James' });

  assert.equal(result.statusChanges.length, 0);
  assert.equal(JSON.parse(result.stored[0].metadata).subject, 'James');
});
