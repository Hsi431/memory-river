import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';

async function processCausalUpdate({
  oldSlotKey = 'person:favorite_team',
  newSlotKey = 'person:favorite_team',
  oldSlotSubject = 'James',
  omitOldSlotSubject = false,
  oldMetadataSubject,
  newSlotSubject = 'James',
  newMetadataSubject,
  oldCardinality = 'single',
  newCardinality = 'single',
  oldStatus = 'active',
  oldRowStatus,
  relation = { action: 'UPDATE', parentId: 'old-memory' },
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-causal-gate-'));
  const procPath = path.join(root, 'pending.processing');
  const oldMetadata = { status: oldStatus };
  if (!omitOldSlotSubject) oldMetadata.slotSubject = oldSlotSubject;
  if (oldMetadataSubject !== undefined) oldMetadata.subject = oldMetadataSubject;
  const oldMemory = {
    id: 'old-memory',
    slotKey: oldSlotKey,
    ...(oldRowStatus === undefined ? {} : { status: oldRowStatus }),
    metadata: JSON.stringify(oldMetadata),
  };
  const statusChanges = [];
  const stored = [];
  const relationCalls = [];
  const store = {
    hybridVectorSearch: async () => [],
    searchBySlotKey: async () => [],
    store: async input => {
      const entry = { id: 'new-memory', ...input };
      stored.push(entry);
      return entry;
    },
    getById: async () => oldMemory,
  };
  const watcher = new InboxWatcher(
    store,
    { embed: async () => [0.1, 0.2, 0.3, 0.4] },
    {
      determineRelation: async () => {
        relationCalls.push(true);
        return relation;
      },
    },
    null,
    null,
    {
      generate: async () => JSON.stringify({
        slotKey: newSlotKey,
        slotValue: 'Liverpool',
        subject: newSlotSubject,
        cardinality: newCardinality,
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
    text: 'favorite team fact',
    category: 'preference',
    importance: 0.8,
    ...(newMetadataSubject === undefined ? {} : { metadata: { subject: newMetadataSubject } }),
  }));

  try {
    await watcher._processMemoryEntry(procPath);
    return { statusChanges, stored, relationCalls };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const causalChanges = statusChanges => statusChanges.filter(change => change.reason === 'causal_update');

test('causal UPDATE deprecates only when all slot guard fields match', async () => {
  const cases = [
    {
      name: 'new memory has no slotKey',
      options: { newSlotKey: '' },
      expected: 0,
    },
    {
      name: 'new cardinality is null',
      options: { newCardinality: null },
      expected: 0,
    },
    {
      name: 'parent and new slotKey differ',
      options: { oldSlotKey: 'person:favorite_team', newSlotKey: 'person:favorite_game' },
      expected: 0,
    },
    {
      name: 'both effective subjects are null',
      options: { oldSlotSubject: null, newSlotSubject: null },
      expected: 0,
    },
    {
      name: 'all guard fields match',
      options: {},
      expected: 1,
    },
  ];

  for (const { name, options, expected } of cases) {
    const result = await processCausalUpdate(options);
    assert.equal(causalChanges(result.statusChanges).length, expected, name);
  }
});

test('causal UPDATE parent status is rechecked inside the parent lock', async () => {
  const result = await processCausalUpdate({ oldStatus: 'deprecated' });

  assert.equal(causalChanges(result.statusChanges).length, 0);
});

test('causal UPDATE relation and parentId remain unchanged when the deprecate gate rejects', async () => {
  const result = await processCausalUpdate({ newCardinality: null });

  assert.deepEqual(result.relationCalls, [true]);
  assert.equal(result.stored.length, 1);
  assert.equal(result.stored[0].parentId, 'old-memory');
  assert.equal(causalChanges(result.statusChanges).length, 0);
});

test('causal UPDATE uses metadata.subject fallback on both sides', async () => {
  const result = await processCausalUpdate({
    omitOldSlotSubject: true,
    oldMetadataSubject: ' John ',
    newSlotSubject: null,
    newMetadataSubject: 'JOHN',
  });

  assert.equal(causalChanges(result.statusChanges).length, 1);
});
