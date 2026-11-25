import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';

async function processBudget({ text, existingValue, newValue }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-slot-value-'));
  const procPath = path.join(root, 'pending.processing');
  const oldMemory = {
    id: 'old-budget',
    text: `Monthly budget is ${existingValue}`,
    slotKey: 'account:monthly_budget',
    slotValue: existingValue,
    metadata: JSON.stringify({ status: 'active', slotSubject: 'account', slotCardinality: 'single' }),
  };
  const stored = [];
  const statusChanges = [];
  let relationCalls = 0;
  const candidate = {
    entry: {
      ...oldMemory,
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 0.8,
      category: 'fact',
      parentId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    vectorScore: 0.99,
    rankScore: 0.99,
    rawDistance: 0.05,
    bm25Score: 0,
    fusedScore: 0.99,
  };
  const store = {
    hybridVectorSearch: async () => [candidate],
    searchBySlotKey: async () => [oldMemory],
    getById: async () => oldMemory,
    store: async input => {
      const entry = { id: 'new-budget', ...input };
      stored.push(entry);
      return entry;
    },
  };
  const watcher = new InboxWatcher(
    store,
    { embed: async () => [0.1, 0.2, 0.3, 0.4] },
    {
      determineRelation: async () => {
        relationCalls += 1;
        return { action: 'UPDATE', parentId: oldMemory.id };
      },
    },
    null,
    null,
    {
      generate: async () => JSON.stringify({
        slotKey: 'account:monthly_budget',
        slotValue: newValue,
        subject: 'account',
        cardinality: 'single',
        confidence: 0.95,
        extractionDomain: 'technical',
        isStructured: true,
      }),
    },
    root,
    2000,
    undefined,
    {
      changeStatus: async change => {
        statusChanges.push(change);
        const metadata = JSON.parse(oldMemory.metadata);
        metadata.status = change.toStatus;
        oldMemory.metadata = JSON.stringify(metadata);
        return { ok: true };
      },
    },
    async () => {},
  );

  fs.writeFileSync(procPath, JSON.stringify({ text, category: 'fact', importance: 0.8 }));
  try {
    await watcher._processMemoryEntry(procPath);
    return { oldMemory, stored, statusChanges, relationCalls };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a close same-slot value change reaches UPDATE and replaces the old value', async () => {
  const result = await processBudget({
    text: 'Monthly budget changed to 6000',
    existingValue: 5000,
    newValue: 6000,
  });

  assert.equal(result.relationCalls, 1);
  assert.equal(result.stored.length, 1);
  assert.equal(result.stored[0].slotValue, 6000);
  assert.equal(JSON.parse(result.oldMemory.metadata).status, 'deprecated');
  assert.equal(result.statusChanges[0].memoryId, 'old-budget');
});

test('the same sentence and slot value still take the duplicate path', async () => {
  const result = await processBudget({
    text: 'Monthly budget is 5000',
    existingValue: 5000,
    newValue: 5000,
  });

  assert.equal(result.relationCalls, 0);
  assert.equal(result.stored.length, 0);
  assert.equal(result.statusChanges.length, 0);
  assert.equal(JSON.parse(result.oldMemory.metadata).status, 'active');
});

test('retrying an UPDATE completes a slot deprecation after its first failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-slot-update-retry-'));
  const procPath = path.join(root, 'pending.json');
  const oldMemory = {
    id: 'old-budget',
    text: 'Monthly budget is 5000',
    slotKey: 'account:monthly_budget',
    slotValue: 5000,
    metadata: JSON.stringify({ status: 'active', slotSubject: 'account', slotCardinality: 'single' }),
  };
  const stored = [];
  const allEntries = [oldMemory];
  let statusAttempts = 0;
  const asCandidate = (entry, rawDistance) => ({
    entry: {
      ...entry,
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 0.8,
      category: 'fact',
      parentId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    vectorScore: 0.99,
    rankScore: 0.99,
    rawDistance,
    bm25Score: 0,
    fusedScore: 0.99,
  });
  const store = {
    hybridVectorSearch: async () => stored.length === 0
      ? [asCandidate(oldMemory, 0.2)]
      : [asCandidate(stored[0], 0.05)],
    searchBySlotKey: async () => allEntries,
    getById: async () => oldMemory,
    store: async input => {
      const entry = { id: 'new-budget', ...input };
      stored.push(entry);
      allEntries.push(entry);
      return entry;
    },
  };
  const watcher = new InboxWatcher(
    store,
    { embed: async () => [0.1, 0.2, 0.3, 0.4] },
    { determineRelation: async () => ({ action: 'UPDATE', parentId: oldMemory.id }) },
    null,
    null,
    {
      generate: async () => JSON.stringify({
        slotKey: 'account:monthly_budget',
        slotValue: 6000,
        subject: 'account',
        cardinality: 'single',
        confidence: 0.95,
        extractionDomain: 'technical',
        isStructured: true,
      }),
    },
    root,
    2000,
    undefined,
    {
      changeStatus: async change => {
        statusAttempts += 1;
        if (statusAttempts === 1) return { ok: false, error: 'transient commit failure' };
        const entry = allEntries.find(candidate => candidate.id === change.memoryId);
        const metadata = JSON.parse(entry.metadata);
        metadata.status = change.toStatus;
        entry.metadata = JSON.stringify(metadata);
        return { ok: true };
      },
    },
    async () => {},
  );

  fs.writeFileSync(procPath, JSON.stringify({
    text: 'Monthly budget changed to 6000',
    category: 'fact',
    importance: 0.8,
  }));
  try {
    const result = await watcher.processFile(procPath);

    assert.equal(result.ok, true);
    const active = allEntries.filter(entry => JSON.parse(entry.metadata).status !== 'deprecated');
    assert.deepEqual(active.map(entry => entry.id), ['new-budget']);
    assert.equal(stored.length, 1);
    assert.equal(statusAttempts, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
