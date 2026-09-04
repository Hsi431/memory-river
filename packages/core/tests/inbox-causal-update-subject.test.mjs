import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';

function makeMemory(id, slotSubject, slotCardinality) {
  return {
    id,
    slotKey: 'person:favorite_team',
    metadata: JSON.stringify({
      status: 'active',
      ...(slotSubject === undefined ? {} : { slotSubject }),
      ...(slotCardinality === undefined ? {} : { slotCardinality }),
    }),
  };
}

async function processCausalUpdate({ oldSubject, newSubject, oldCardinality = null, newCardinality = null, oldMetadata = undefined }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-causal-subject-'));
  const procPath = path.join(root, 'pending.processing');
  const oldMemory = makeMemory('old-memory', oldSubject, oldCardinality);
  if (oldMetadata !== undefined) oldMemory.metadata = oldMetadata;
  const statusChanges = [];
  const store = {
    hybridVectorSearch: async () => [],
    searchBySlotKey: async () => [],
    store: async input => ({ id: 'new-memory', ...input }),
    getById: async () => oldMemory,
  };
  const watcher = new InboxWatcher(
    store,
    { embed: async () => [0.1, 0.2, 0.3, 0.4] },
    { determineRelation: async () => ({ action: 'UPDATE', parentId: oldMemory.id }) },
    null,
    null,
    {
      generate: async () => JSON.stringify({
        slotKey: 'person:favorite_team',
        slotValue: 'Liverpool',
        subject: newSubject,
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
      changeStatus: async change => {
        statusChanges.push(change);
      },
    },
    async () => {},
  );

  fs.writeFileSync(procPath, JSON.stringify({
    text: 'favorite team fact',
    category: 'preference',
    importance: 0.8,
  }));

  try {
    await watcher._processMemoryEntry(procPath);
    return statusChanges;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function causalUpdateChanges(statusChanges) {
  return statusChanges.filter(change => change.reason === 'causal_update');
}

test('causal UPDATE does not deprecate a different subject', async () => {
  const statusChanges = await processCausalUpdate({ oldSubject: 'John', newSubject: 'James' });

  assert.equal(causalUpdateChanges(statusChanges).length, 0);
});

test('causal UPDATE deprecates the same subject', async () => {
  const statusChanges = await processCausalUpdate({
    oldSubject: ' james ',
    newSubject: 'JAMES',
    oldCardinality: 'single',
    newCardinality: 'single',
  });

  assert.equal(causalUpdateChanges(statusChanges).length, 1);
  assert.equal(causalUpdateChanges(statusChanges)[0].memoryId, 'old-memory');
});

// 雙 null 沒有任何結構證據，是 causal 誤殺的主要通道。
test('causal UPDATE no longer deprecates when both subjects are null', async () => {
  const statusChanges = await processCausalUpdate({ oldSubject: null, newSubject: null });

  assert.equal(causalUpdateChanges(statusChanges).length, 0);
});

test('causal UPDATE does not deprecate when only the new memory has a subject', async () => {
  const statusChanges = await processCausalUpdate({ oldSubject: null, newSubject: 'James' });

  assert.equal(causalUpdateChanges(statusChanges).length, 0);
});

test('causal UPDATE does not deprecate when the new cardinality is multi', async () => {
  const statusChanges = await processCausalUpdate({
    oldSubject: 'James',
    newSubject: 'James',
    oldCardinality: 'single',
    newCardinality: 'multi',
  });

  assert.equal(causalUpdateChanges(statusChanges).length, 0);
});

test('causal UPDATE does not deprecate when the old cardinality is multi', async () => {
  const statusChanges = await processCausalUpdate({
    oldSubject: 'James',
    newSubject: 'James',
    oldCardinality: 'multi',
    newCardinality: 'single',
  });

  assert.equal(causalUpdateChanges(statusChanges).length, 0);
});

test('causal UPDATE deprecates when both cardinalities are single', async () => {
  const statusChanges = await processCausalUpdate({
    oldSubject: 'James',
    newSubject: 'James',
    oldCardinality: 'single',
    newCardinality: 'single',
  });

  assert.equal(causalUpdateChanges(statusChanges).length, 1);
});

test('causal UPDATE does not deprecate when old metadata is malformed', async () => {
  const statusChanges = await processCausalUpdate({
    oldSubject: null,
    newSubject: null,
    oldCardinality: 'single',
    newCardinality: 'single',
    oldMetadata: '{bad',
  });

  assert.equal(causalUpdateChanges(statusChanges).length, 0);
});
