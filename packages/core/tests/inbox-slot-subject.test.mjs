import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';

function makeExistingMemory(id, slotSubject, slotCardinality) {
  return {
    id,
    slotKey: 'person:favorite_game',
    metadata: JSON.stringify({
      status: 'active',
      ...(slotSubject === undefined ? {} : { slotSubject }),
      ...(slotCardinality === undefined ? {} : { slotCardinality }),
    }),
  };
}

async function processSlotMemory({ existing, subject, cardinality = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-slot-subject-'));
  const procPath = path.join(root, 'pending.processing');
  const stored = [];
  const statusChanges = [];
  const existingById = new Map(existing.map(entry => [entry.id, entry]));
  const store = {
    hybridVectorSearch: async () => [],
    searchBySlotKey: async () => existing,
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
        subject,
        cardinality,
        confidence: 0.9,
        extractionDomain: 'preference',
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
          const metadata = JSON.parse(entry.metadata);
          metadata.status = change.toStatus;
          entry.metadata = JSON.stringify(metadata);
        }
      },
    },
    async () => {},
  );

  fs.writeFileSync(procPath, JSON.stringify({
    text: 'favorite game fact',
    category: 'preference',
    importance: 0.8,
  }));

  try {
    await watcher._processMemoryEntry(procPath);
    return { existing, stored, statusChanges };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('different subjects sharing a slot key both remain active', async () => {
  const oldMemory = makeExistingMemory('john-memory', 'John');
  const result = await processSlotMemory({ existing: [oldMemory], subject: 'James' });

  assert.equal(result.statusChanges.length, 0);
  assert.equal(JSON.parse(oldMemory.metadata).status, 'active');
  assert.equal(JSON.parse(result.stored[0].metadata).slotSubject, 'James');
});

test('same subject supersedes the old slot and records the new memory id', async () => {
  const oldMemory = makeExistingMemory('james-old', ' james ');
  const result = await processSlotMemory({ existing: [oldMemory], subject: 'JAMES' });

  assert.equal(JSON.parse(oldMemory.metadata).status, 'deprecated');
  assert.deepEqual(result.statusChanges, [{
    memoryId: 'james-old',
    toStatus: 'deprecated',
    reason: 'slot_supersedes',
    source: 'inbox-watcher.slot',
    supersededBy: 'new-memory',
  }]);
});

test('null subjects preserve the existing same-slot supersede behavior', async () => {
  const oldMemory = makeExistingMemory('unknown-old', null);
  const result = await processSlotMemory({ existing: [oldMemory], subject: null });

  assert.equal(result.statusChanges.length, 1);
  assert.equal(result.statusChanges[0].memoryId, 'unknown-old');
  assert.equal(JSON.parse(oldMemory.metadata).status, 'deprecated');
});

test('a subject does not supersede an old slot without a subject', async () => {
  const oldMemory = makeExistingMemory('unknown-old');
  const result = await processSlotMemory({ existing: [oldMemory], subject: 'James' });

  assert.equal(result.statusChanges.length, 0);
  assert.equal(JSON.parse(oldMemory.metadata).status, 'active');
});

test('multi cardinality does not supersede a same-subject old slot', async () => {
  const oldMemory = makeExistingMemory('james-old', 'James', 'single');
  const result = await processSlotMemory({ existing: [oldMemory], subject: 'James', cardinality: 'multi' });

  assert.equal(result.statusChanges.length, 0);
  assert.equal(JSON.parse(oldMemory.metadata).status, 'active');
  assert.equal(JSON.parse(result.stored[0].metadata).slotCardinality, 'multi');
});

test('an old multi cardinality slot is never superseded', async () => {
  const oldMemory = makeExistingMemory('james-old', 'James', 'multi');
  const result = await processSlotMemory({ existing: [oldMemory], subject: 'James', cardinality: 'single' });

  assert.equal(result.statusChanges.length, 0);
  assert.equal(JSON.parse(oldMemory.metadata).status, 'active');
});

test('malformed slot metadata is excluded from supersedes', async () => {
  const oldMemory = makeExistingMemory('james-old', 'James', 'single');
  oldMemory.metadata = '{bad';
  const result = await processSlotMemory({ existing: [oldMemory], subject: 'James', cardinality: 'single' });

  assert.equal(result.statusChanges.length, 0);
  assert.equal(JSON.parse(result.stored[0].metadata).slotCardinality, 'single');
});

test('slot extraction normalizes padded uppercase multi cardinality', async () => {
  const oldMemory = makeExistingMemory('james-old', 'James', 'single');
  const result = await processSlotMemory({ existing: [oldMemory], subject: 'James', cardinality: ' MULTI ' });

  assert.equal(result.statusChanges.length, 0);
  assert.equal(JSON.parse(result.stored[0].metadata).slotCardinality, 'multi');
  assert.equal(JSON.parse(result.stored[0].metadata).slotSubject, 'James');
});
