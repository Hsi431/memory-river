import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as lancedb from '@lancedb/lancedb';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dbPath;
let started;
let handleDashboardRequest;
let startServer;

before(async () => {
  ({ startDashboardServer: startServer, handleDashboardRequest } = await import(path.join(packageDir, 'dist/serve.js')));
  dbPath = await mkdtemp(path.join(tmpdir(), 'mr-dashboard-serve-'));
  const db = await lancedb.connect(dbPath);
  const now = Date.now();

  await db.createTable('subsystem_effectiveness', [
    {
      id: 'event-1',
      ts: new Date(now).toISOString(),
      subsystem: 'causal',
      event: 'attribution',
      entityId: 'memory-1',
      relatedId: '',
      sessionKey: 'session-key',
      sessionId: 'session-id',
      queryHash: 'query-hash',
      outcome: 'used',
      count: 1,
      score: 0.8,
      durationMs: 12,
      metadata: JSON.stringify({ method: 'fixture' }),
    },
  ]);

  await db.createTable('night_consolidation_stats', [
    {
      runId: 'run-1',
      ts: now - 1_000,
      phase: 'run_started',
      outcome: 'ok',
      durationMs: 0,
      scheduledFor: 0,
      candidateCount: 1,
      attemptedCount: 0,
      failedCount: 0,
      errorMessage: '',
      metadata: JSON.stringify({ source: 'fixture' }),
    },
    {
      runId: 'run-1',
      ts: now,
      phase: 'run_completed',
      outcome: 'ok',
      durationMs: 1_000,
      scheduledFor: 0,
      candidateCount: 1,
      attemptedCount: 1,
      failedCount: 0,
      errorMessage: '',
      metadata: JSON.stringify({ source: 'fixture' }),
    },
  ]);

  await db.createTable('memories', [
    {
      id: 'memory-1',
      text: 'Alpha memory about rivers',
      category: 'fact',
      importance: 0.9,
      confidence: 0.8,
      status: 'active',
      slotKey: 'profile.name',
      slotValue: 'Alpha',
      sessionId: 'session-1',
      parentId: '',
      createdAt: now - 2_000,
      updatedAt: now - 1_000,
      metadata: JSON.stringify({ health: { healthScore: 30 } }),
    },
    {
      id: 'memory-2',
      text: 'Beta memory',
      category: 'preference',
      importance: 0.5,
      confidence: 0.7,
      status: 'archived',
      slotKey: '',
      slotValue: '',
      sessionId: 'session-2',
      parentId: '',
      createdAt: now - 1_000,
      updatedAt: now,
      metadata: JSON.stringify({ health: { healthScore: 100 } }),
    },
  ]);

  await db.createTable('graph_triples', [
    {
      subject: 'Alpha',
      relation: 'likes',
      object: 'Rivers',
      sourceMemoryId: 'memory-1',
      createdAt: now,
    },
    {
      subject: 'Beta',
      relation: 'knows',
      object: 'Gamma',
      sourceMemoryId: 'memory-2',
      createdAt: now,
    },
  ]);

  try {
    started = await startServer(dbPath, 0);
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    started = null;
  }
});

after(async () => {
  if (started) {
    await new Promise((resolve, reject) => {
      started.server.close(error => error ? reject(error) : resolve());
    });
  }
  if (dbPath) await rm(dbPath, { recursive: true, force: true });
});

async function getJson(pathname) {
  if (!started) {
    const result = await handleDashboardRequest(dbPath, 'GET', pathname);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  const response = await fetch(`${started.url}${pathname}`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

test('serves the single-page dashboard', async () => {
  let html;
  if (started) {
    const response = await fetch(started.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    html = await response.text();
  } else {
    const result = await handleDashboardRequest(dbPath, 'GET', '/');
    assert.equal(result.status, 200);
    assert.match(result.contentType, /^text\/html/);
    html = result.body;
  }
  assert.match(html, /Memory River Dashboard/);
  for (const tab of ['Tables', 'Effectiveness', 'Night', 'Memories', 'Graph', 'Slots']) {
    assert.match(html, new RegExp(tab));
  }
});

test('tables endpoint returns row counts', async () => {
  const data = await getJson('/api/tables');
  assert.ok(Array.isArray(data.items));
  assert.deepEqual(
    data.items.find(item => item.name === 'memories'),
    { name: 'memories', rows: 2 },
  );
});

test('effectiveness endpoint returns filtered summaries', async () => {
  const data = await getJson('/api/effectiveness?since=all&subsystem=causal');
  assert.equal(data.totalEvents, 1);
  assert.equal(data.subsystems[0].name, 'causal');
  assert.deepEqual(data.subsystems[0].outcomes, { used: 1 });
  assert.equal(data.subsystems[0].scores.median, 0.8);
});

test('night endpoint returns run verdicts and phases', async () => {
  const data = await getJson('/api/night?since=all');
  assert.equal(data.totalRuns, 1);
  assert.equal(data.verdicts['✅ healthy'], 1);
  assert.equal(data.runs[0].runId, 'run-1');
  assert.deepEqual(data.runs[0].phases.map(phase => phase.phase), ['run_started', 'run_completed']);
});

test('memories endpoint filters, paginates, and exposes health score', async () => {
  const filtered = await getJson('/api/memories?limit=1&offset=0&category=fact&status=active&q=river');
  assert.equal(filtered.total, 1);
  assert.equal(filtered.limit, 1);
  assert.equal(filtered.offset, 0);
  assert.equal(filtered.items[0].id, 'memory-1');
  assert.equal(filtered.items[0].healthScore, 30);

  const secondPage = await getJson('/api/memories?limit=1&offset=1');
  assert.equal(secondPage.total, 2);
  assert.equal(secondPage.items.length, 1);
});

test('graph endpoint searches subject and object', async () => {
  const bySubject = await getJson('/api/graph?limit=50&offset=0&q=Alpha');
  assert.equal(bySubject.total, 1);
  assert.equal(bySubject.items[0].sourceMemoryId, 'memory-1');

  const byObject = await getJson('/api/graph?q=Gamma');
  assert.equal(byObject.total, 1);
  assert.equal(byObject.items[0].subject, 'Beta');
});

test('slots endpoint only returns memories with a non-empty slot key', async () => {
  const data = await getJson('/api/slots?limit=50&offset=0');
  assert.equal(data.total, 1);
  assert.equal(data.items[0].slotKey, 'profile.name');
});

test('API errors are JSON and do not crash the server', async () => {
  if (started) {
    const invalid = await fetch(`${started.url}/api/memories?limit=501`);
    assert.equal(invalid.status, 400);
    assert.match(invalid.headers.get('content-type'), /^application\/json/);
    assert.match((await invalid.json()).error, /limit must be/);

    const missing = await fetch(`${started.url}/api/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'API endpoint not found' });
  } else {
    const invalid = await handleDashboardRequest(dbPath, 'GET', '/api/memories?limit=501');
    assert.equal(invalid.status, 400);
    assert.match(invalid.contentType, /^application\/json/);
    assert.match(invalid.body.error, /limit must be/);

    const missing = await handleDashboardRequest(dbPath, 'GET', '/api/missing');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'API endpoint not found' });
  }

  const tables = await getJson('/api/tables');
  assert.ok(tables.items.length >= 4);
});
