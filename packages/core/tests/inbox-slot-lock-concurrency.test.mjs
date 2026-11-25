import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';

async function processConcurrentSlots(values) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-slot-lock-'));
  const records = [];
  let searchCalls = 0;
  let relationCalls = 0;
  let releaseSearchBatch;
  let releaseRelationBatch;
  const searchBatch = new Promise(resolve => { releaseSearchBatch = resolve; });
  const relationBatch = new Promise(resolve => { releaseRelationBatch = resolve; });
  const pause = () => new Promise(resolve => setTimeout(resolve, 25));
  const activeRecords = () => records.filter(entry => JSON.parse(entry.metadata).status !== 'deprecated');
  const asCandidate = entry => ({
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
    rawDistance: 0.05,
    bm25Score: 0,
    fusedScore: 0.99,
  });
  const store = {
    hybridVectorSearch: async () => {
      searchCalls += 1;
      if (searchCalls >= values.length) releaseSearchBatch();
      await Promise.race([searchBatch, pause()]);
      return activeRecords().map(asCandidate);
    },
    searchBySlotKey: async slotKey => records.filter(entry => entry.slotKey === slotKey),
    getById: async id => records.find(entry => entry.id === id),
    store: async input => {
      const entry = { id: `memory-${records.length + 1}`, ...input };
      records.push(entry);
      return entry;
    },
  };
  const watcher = new InboxWatcher(
    store,
    { embed: async () => [0.1, 0.2, 0.3, 0.4] },
    {
      determineRelation: async () => {
        const active = activeRecords();
        relationCalls += 1;
        if (relationCalls >= values.length) releaseRelationBatch();
        await Promise.race([relationBatch, pause()]);
        const latest = active.at(-1);
        return latest
          ? { action: 'UPDATE', parentId: latest.id }
          : { action: 'CREATE', parentId: null };
      },
    },
    null,
    null,
    {
      generate: async prompt => {
        const item = values.find(value => prompt.includes(value.text));
        return JSON.stringify({
          slotKey: 'account:monthly_budget',
          slotValue: item.value,
          subject: 'account',
          cardinality: 'single',
          confidence: 0.95,
          extractionDomain: 'technical',
          isStructured: true,
        });
      },
    },
    root,
    2000,
    undefined,
    {
      changeStatus: async change => {
        const entry = records.find(candidate => candidate.id === change.memoryId);
        const metadata = JSON.parse(entry.metadata);
        metadata.status = change.toStatus;
        entry.metadata = JSON.stringify(metadata);
        return { ok: true };
      },
    },
    async () => {},
  );
  const paths = values.map((_, index) => {
    const filePath = path.join(root, `pending-${index}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ text: values[index].text, category: 'fact', importance: 0.8 }));
    return filePath;
  });

  try {
    const results = await Promise.all(paths.map(filePath => watcher.processFile(filePath)));
    return { results, records, active: activeRecords() };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('three concurrent near-identical inbox entries leave one active memory', async () => {
  const value = { text: 'Monthly budget is 5000', value: 5000 };
  const result = await processConcurrentSlots([value, value, value]);

  assert.deepEqual(result.results.map(item => item.ok), [true, true, true]);
  assert.equal(result.records.length, 1);
  assert.equal(result.active.length, 1);
});

test('two concurrent values for the same slot leave only the replacement active', async () => {
  const result = await processConcurrentSlots([
    { text: 'Monthly budget is 5000', value: 5000 },
    { text: 'Monthly budget is 6000', value: 6000 },
  ]);

  assert.deepEqual(result.results.map(item => item.ok), [true, true]);
  assert.equal(result.records.length, 2);
  assert.equal(result.active.length, 1);
});
