import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NightConsolidator } from '../dist/lifecycle/night-consolidation.js';

const OriginalDate = Date;
const fixedNow = new OriginalDate(2026, 7, 26, 3, 0, 0, 0).getTime();

class FixedDate extends OriginalDate {
  constructor(...args) {
    super(...(args.length === 0 ? [fixedNow] : args));
  }

  static now() {
    return fixedNow;
  }
}

function memory(id, timestamp, updatedAt = timestamp) {
  return {
    id,
    text: id,
    vector: [0.1],
    importance: 0.5,
    category: 'fact',
    parentId: null,
    metadata: '{}',
    createdAt: timestamp,
    updatedAt,
  };
}

async function withFixedNow(fn) {
  globalThis.Date = FixedDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = OriginalDate;
  }
}

async function consolidate(range, memories) {
  const prompts = [];
  const logPath = path.join(os.tmpdir(), `night-consolidation-range-${process.pid}-${Math.random()}.jsonl`);
  const store = {
    queryAll: async () => memories,
    getById: async (id) => memories.find((entry) => entry.id === id) ?? null,
    update: async () => true,
    delete: async () => true,
    searchBySlotKey: async () => [],
  };
  const consolidator = new NightConsolidator(store, {
    concentrator: {
      generate: async (prompt) => {
        prompts.push(prompt);
        const ids = [...prompt.matchAll(/id=([^\s]+) createdAt=/g)].map((match) => match[1]);
        return JSON.stringify({
          decisions: ids.map((id) => ({ action: 'keep', memoryId: id, reason: 'range test' })),
          summary: 'range test',
        });
      },
    },
    statusManager: { changeStatusBatch: async () => [] },
  }, logPath);

  try {
    const result = await consolidator.consolidateRange(range, `range-${range}`);
    const candidateIds = prompts.flatMap((prompt) => [...prompt.matchAll(/id=([^\s]+) createdAt=/g)].map((match) => match[1]));
    return { result, candidateIds };
  } finally {
    fs.rmSync(logPath, { force: true });
  }
}

test('last24h excludes 25-hour-old memories and includes 20-hour and 1-hour memories', async () => {
  await withFixedNow(async () => {
    const memories = [
      memory('older-than-window', fixedNow - 25 * 60 * 60 * 1000),
      memory('twenty-hours-old', fixedNow - 20 * 60 * 60 * 1000),
      memory('one-hour-old', fixedNow - 60 * 60 * 1000),
      memory('window-lower-bound', fixedNow - 24 * 60 * 60 * 1000),
      memory('now-bound', fixedNow),
      memory('updated-at-fallback', 0, fixedNow - 60 * 60 * 1000),
    ];

    const { result, candidateIds } = await consolidate('last24h', memories);

    assert.equal(result.plan.processedCount, 5);
    assert.deepEqual(candidateIds, [
      'twenty-hours-old',
      'one-hour-old',
      'window-lower-bound',
      'now-bound',
      'updated-at-fallback',
    ]);
    assert.ok(!candidateIds.includes('older-than-window'));
  });
});

test('consolidateRange today keeps its midnight-to-now behavior', async () => {
  await withFixedNow(async () => {
    const memories = [
      memory('previous-day', fixedNow - 20 * 60 * 60 * 1000),
      memory('today', fixedNow - 60 * 60 * 1000),
    ];

    const { result, candidateIds } = await consolidate('today', memories);

    assert.equal(result.plan.processedCount, 1);
    assert.deepEqual(candidateIds, ['today']);
  });
});
