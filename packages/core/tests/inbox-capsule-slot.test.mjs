import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';

async function processMemory({ text, category, metadata = {}, existing = [] }) {
  const root = fs.mkdtempSync(path.join('/tmp', 'T15-inbox-capsule-slot-'));
  const procPath = path.join(root, 'pending.processing');
  const stored = [];
  const statusChanges = [];
  const existingById = new Map(existing.map(entry => [entry.id, entry]));
  let searchBySlotKeyCalls = 0;
  const store = {
    hybridVectorSearch: async () => [],
    searchBySlotKey: async () => {
      searchBySlotKeyCalls += 1;
      return existing;
    },
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
        slotKey: 'user:npm_account',
        slotValue: 'hsi431',
        subject: 'user',
        cardinality: 'single',
        confidence: 0.9,
        extractionDomain: 'identity',
        isStructured: true,
      }),
    },
    root,
    2000,
    undefined,
    {
      changeStatus: async change => {
        statusChanges.push(change);
        const entry = existingById.get(change.memoryId);
        if (entry) {
          const entryMetadata = JSON.parse(entry.metadata);
          entryMetadata.status = change.toStatus;
          entry.metadata = JSON.stringify(entryMetadata);
        }
      },
    },
    async () => {},
  );

  fs.writeFileSync(procPath, JSON.stringify({ text, category, importance: 0.8, metadata }));

  try {
    await watcher._processMemoryEntry(procPath);
    return { existing, stored, statusChanges, searchBySlotKeyCalls };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function existingMemory(id, metadata = {}) {
  return {
    id,
    text: '使用者的 npm 帳號是舊值',
    category: 'entity',
    slotKey: 'user:npm_account',
    metadata: JSON.stringify({
      status: 'active',
      slotSubject: 'user',
      slotCardinality: 'single',
      ...metadata,
    }),
  };
}

test('ordinary fact tagged working_memory keeps its structured property slot', async () => {
  const result = await processMemory({
    text: '使用者的 npm 帳號是 hsi431。',
    category: 'entity',
    metadata: { capsuleType: 'working_memory' },
  });

  assert.equal(result.stored[0].slotKey, 'user:npm_account');
  assert.equal(result.stored[0].slotValue, 'hsi431');
});

test('history session preamble mentioning a property gets no slot and does not supersede a note', async () => {
  const oldNote = existingMemory('old-note');
  const result = await processMemory({
    text: '【前情提要】使用者的 npm 帳號是 hsi431，並正在整理整段對話的背景。',
    category: 'history',
    metadata: { capsuleType: 'working_memory' },
    existing: [oldNote],
  });

  assert.equal(result.stored[0].slotKey, undefined);
  assert.equal(Object.hasOwn(result.stored[0], 'supersedes'), false);
  assert.equal(result.searchBySlotKeyCalls, 0);
  assert.equal(result.statusChanges.length, 0);
  assert.equal(JSON.parse(oldNote.metadata).status, 'active');
});

test('an ordinary working_memory fact with a slot key is superseded by a newer fact', async () => {
  const oldNote = existingMemory('old-note', { capsuleType: 'working_memory' });
  const result = await processMemory({
    text: '使用者的 npm 帳號是 hsi431。',
    category: 'entity',
    existing: [oldNote],
  });

  assert.equal(JSON.parse(oldNote.metadata).status, 'deprecated');
  assert.equal(result.statusChanges.length, 1);
  assert.equal(result.stored[0].slotKey, 'user:npm_account');
});

test('an existing history session preamble is not superseded by an ordinary fact', async () => {
  const oldSummary = existingMemory('old-summary', { capsuleType: 'working_memory' });
  oldSummary.category = 'history';
  oldSummary.text = '【前情提要】使用者的 npm 帳號是舊值。';
  const result = await processMemory({
    text: '使用者的 npm 帳號是 hsi431。',
    category: 'entity',
    existing: [oldSummary],
  });

  assert.equal(JSON.parse(oldSummary.metadata).status, 'active');
  assert.equal(result.statusChanges.length, 0);
  assert.equal(Object.hasOwn(result.stored[0], 'supersedes'), false);
});

test('ordinary notes with the same slot and subject still supersede', async () => {
  const oldNote = existingMemory('old-note');
  const result = await processMemory({
    text: '使用者的 npm 帳號是 hsi431。',
    category: 'entity',
    existing: [oldNote],
  });

  assert.equal(JSON.parse(oldNote.metadata).status, 'deprecated');
  assert.deepEqual(result.statusChanges, [{
    memoryId: 'old-note',
    toStatus: 'deprecated',
    reason: 'slot_supersedes',
    source: 'inbox-watcher.slot',
    supersededBy: 'new-memory',
  }]);
});
