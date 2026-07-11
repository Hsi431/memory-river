import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as lancedb from '@lancedb/lancedb';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dbPath;
let runCli;

before(async () => {
  ({ runCli } = await import(path.join(packageDir, 'dist/cli.js')));
  dbPath = await mkdtemp(path.join(tmpdir(), 'mr-dashboard-'));
  const db = await lancedb.connect(dbPath);
  const now = Date.now();
  const outcomes = ['used', 'used', 'partial', 'unused', 'unused'];

  await db.createTable('subsystem_effectiveness', outcomes.map((outcome, index) => ({
    id: `event-${index}`,
    ts: new Date(now - index * 1_000).toISOString(),
    subsystem: 'causal',
    event: 'attribution',
    entityId: `entity-${index}`,
    relatedId: '',
    sessionKey: 'session-key',
    sessionId: 'session-id',
    queryHash: 'query-hash',
    outcome,
    count: 1,
    score: 0.5 + index / 10,
    durationMs: 10,
    metadata: JSON.stringify({ method: 'fixture', snippet: `sample ${index}` }),
  })));

  await db.createTable('night_consolidation_stats', [
    {
      runId: 'run-1',
      ts: now - 2_000,
      phase: 'run_started',
      outcome: 'ok',
      durationMs: 0,
      scheduledFor: 0,
      candidateCount: 0,
      attemptedCount: 0,
      failedCount: 0,
      errorMessage: '',
      metadata: JSON.stringify({ source: 'test' }),
    },
    {
      runId: 'run-1',
      ts: now - 1_000,
      phase: 'run_completed',
      outcome: 'ok',
      durationMs: 1_000,
      scheduledFor: 0,
      candidateCount: 0,
      attemptedCount: 0,
      failedCount: 0,
      errorMessage: '',
      metadata: JSON.stringify({ source: 'test' }),
    },
  ]);

  await db.createTable('other_table', [{ value: 1 }]);
});

after(async () => {
  if (!dbPath) return;
  try {
    await rm(dbPath, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[test-teardown] best-effort rm failed for ${dbPath}:`, error?.code ?? error);
  }
});

async function capture(args) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => stdout.push(values.join(' '));
  console.error = (...values) => stderr.push(values.join(' '));
  try {
    const status = await runCli(args);
    return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('tables lists every table with row counts', async () => {
  const result = await capture(['tables', '--db', dbPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /subsystem_effectiveness\s+5 rows/);
  assert.match(result.stdout, /night_consolidation_stats\s+2 rows/);
  assert.match(result.stdout, /other_table\s+1 rows/);
});

test('effectiveness prints subsystem health and raw metadata', async () => {
  const result = await capture([
    'effectiveness',
    '--db',
    dbPath,
    '--since',
    'all',
    '--subsystem',
    'causal',
    '--raw',
    '1',
    '--meta',
    'method',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Total events: 5/);
  assert.match(result.stdout, /outcome distribution healthy/);
  assert.match(result.stdout, /Raw events \(latest 1\)/);
  assert.match(result.stdout, /metadata: \{ method: "fixture" \}/);
});

test('night prints run verdict statistics', async () => {
  const result = await capture(['night', '--db', dbPath, '--since', 'all']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Total runs: 1/);
  assert.match(result.stdout, /healthy: 1/);
  assert.match(result.stdout, /runId=run-1 source=test/);
  assert.match(result.stdout, /run_started \(ok\) → run_completed \(ok\)/);
});

test('missing --db prints usage and exits 1', async () => {
  const result = await capture(['tables']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--db is required/);
  assert.match(result.stderr, /Usage:/);
});
