import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { randomUUID } from 'node:crypto';

import { MemoryStore } from '../dist/store/store-v4.js';
import { NightConsolidator } from '../dist/lifecycle/night-consolidation.js';

function makeTempPaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const ram = path.join(root, 'ram-db');
  const ssd = path.join(root, 'ssd-db');
  const transcripts = path.join(root, 'transcripts');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ram, { recursive: true });
  fs.mkdirSync(ssd, { recursive: true });
  fs.mkdirSync(transcripts, { recursive: true });
  return { root, home, ram, ssd, transcripts };
}

async function withTempStore(prefix, fn) {
  const paths = makeTempPaths(prefix);
  const oldHome = process.env.HOME;
  const oldTranscriptPath = process.env.MEMORY_TRANSCRIPT_PATH;
  process.env.HOME = paths.home;
  process.env.MEMORY_TRANSCRIPT_PATH = paths.transcripts;
  const store = new MemoryStore(paths.ssd, paths.ram, 4, undefined, {
    embed: async () => [0, 0, 0, 0],
  });

  try {
    await store.ensureInitialized();
    await fn({ store, paths });
  } finally {
    await store.shutdown?.().catch?.(() => {});
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldTranscriptPath === undefined) delete process.env.MEMORY_TRANSCRIPT_PATH;
    else process.env.MEMORY_TRANSCRIPT_PATH = oldTranscriptPath;
    fs.rmSync(paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function readNightStats(dbPath, runId) {
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable('night_consolidation_stats');
  return await table.query().where(`\`runId\` = '${runId}'`).limit(20).toArray();
}

async function waitNightStats(dbPath, runId, predicate) {
  for (let i = 0; i < 20; i++) {
    const rows = await readNightStats(dbPath, runId);
    if (predicate(rows)) return rows;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return await readNightStats(dbPath, runId);
}

test('recordNightConsolidationStat writes a readable row', async () => {
  await withTempStore('night-stats-write-', async ({ store, paths }) => {
    const runId = randomUUID();
    await store.recordNightConsolidationStat({
      runId,
      phase: 'query_completed',
      outcome: 'ok',
      candidateCount: 2,
      scannedCount: 10,
      metadata: { startOfDay: 1, endOfDay: 2 },
    });

    const rows = await readNightStats(paths.ram, runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runId, runId);
    assert.equal(rows[0].phase, 'query_completed');
    assert.equal(rows[0].outcome, 'ok');
    assert.equal(Number(rows[0].candidateCount), 2);
    assert.equal(Number(rows[0].scannedCount), 10);
    assert.deepEqual(JSON.parse(rows[0].metadata), { startOfDay: 1, endOfDay: 2 });
  });
});

test('same runId links multiple phases', async () => {
  await withTempStore('night-stats-runid-', async ({ store, paths }) => {
    const runId = randomUUID();
    await store.recordNightConsolidationStat({ runId, phase: 'schedule_created', scheduledFor: 1000 });
    await store.recordNightConsolidationStat({ runId, phase: 'timer_fired', scheduledFor: 1000, driftMs: 5 });
    await store.recordNightConsolidationStat({ runId, phase: 'run_started' });

    const rows = await readNightStats(paths.ram, runId);
    assert.equal(rows.length, 3);
    assert.deepEqual(new Set(rows.map(row => row.phase)), new Set(['schedule_created', 'timer_fired', 'run_started']));
  });
});

test('stats write failure does not throw', async () => {
  await withTempStore('night-stats-failure-', async ({ store }) => {
    store.nightConsolidationStatsRamTable.add = async () => {
      throw new Error('simulated lancedb add failure');
    };

    await assert.doesNotReject(() => store.recordNightConsolidationStat({
      runId: randomUUID(),
      phase: 'run_started',
    }));
  });
});

test('schema-invalid stats input does not propagate', async () => {
  await withTempStore('night-stats-schema-', async ({ store }) => {
    await assert.doesNotReject(() => store.recordNightConsolidationStat({
      runId: randomUUID(),
      phase: 123,
    }));
  });
});

test('NightConsolidator records zero_candidates for empty candidate set', async () => {
  await withTempStore('night-stats-zero-', async ({ store, paths }) => {
    const runId = randomUUID();
    const consolidator = new NightConsolidator({
      queryAll: async () => [],
      getById: async () => null,
      update: async () => true,
      delete: async () => true,
      searchBySlotKey: async () => [],
      recordNightConsolidationStat: store.recordNightConsolidationStat.bind(store),
    }, {
      statusManager: { changeStatusBatch: async () => [] },
    }, path.join(paths.root, 'consolidation-log.jsonl'));

    const result = await consolidator.consolidateToday(runId);
    assert.equal(result.plan.processedCount, 0);

    const rows = await waitNightStats(
      paths.ram,
      runId,
      rows => rows.some(row => row.phase === 'query_completed' && Number(row.candidateCount) === 0)
        && rows.some(row => row.phase === 'zero_candidates' && row.outcome === 'skipped'),
    );
    assert.ok(rows.some(row => row.phase === 'query_completed' && Number(row.candidateCount) === 0));
    assert.ok(rows.some(row => row.phase === 'zero_candidates' && row.outcome === 'skipped'));
  });
});

test('NightConsolidator records llm_failed when adapter throws', async () => {
  await withTempStore('night-stats-llm-fail-', async ({ store, paths }) => {
    const runId = randomUUID();
    const now = Date.now();
    const memory = {
      id: randomUUID(),
      text: '今晚要測試 NightConsolidator LLM failure stats',
      textTokens: '今晚 要 測試',
      vector: [0, 0, 0, 0],
      importance: 0.8,
      category: 'other',
      parentId: '',
      metadata: '{}',
      createdAt: now,
      updatedAt: now,
      slotKey: '',
      slotValue: '',
      confidence: 0.8,
    };
    const consolidator = new NightConsolidator({
      queryAll: async () => [memory],
      getById: async () => null,
      update: async () => true,
      delete: async () => true,
      searchBySlotKey: async () => [],
      recordNightConsolidationStat: store.recordNightConsolidationStat.bind(store),
    }, {
      concentrator: { generate: async () => { throw new Error('simulated llm failure'); } },
      statusManager: { changeStatusBatch: async () => [] },
    }, path.join(paths.root, 'consolidation-log.jsonl'));

    const result = await consolidator.consolidateToday(runId);
    assert.equal(result.plan.processedCount, 1);
    assert.equal(result.errors.length, 1);

    const rows = await waitNightStats(
      paths.ram,
      runId,
      rows => rows.some(row => row.phase === 'llm_batch_completed' && row.outcome === 'failed')
        && rows.some(row => row.phase === 'llm_failed' && row.errorMessage.includes('simulated llm failure')),
    );
    assert.ok(rows.some(row => row.phase === 'llm_batch_completed' && row.outcome === 'failed'));
    assert.ok(rows.some(row => row.phase === 'llm_failed' && row.errorMessage.includes('simulated llm failure')));
  });
});
