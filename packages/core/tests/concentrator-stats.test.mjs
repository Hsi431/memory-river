import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { Field, Int64, Schema, Utf8 } from 'apache-arrow';

import { ConcentratorAdapter } from '../dist/distill/concentrator-adapter.js';
import { MemoryStore } from '../dist/store/store-v4.js';
import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';

let transcriptArchive;

function makeTempPaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const ram = path.join(root, 'ram-db');
  const ssd = path.join(root, 'ssd-db');
  const inbox = path.join(root, 'inbox');
  const transcripts = path.join(root, 'transcripts');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ram, { recursive: true });
  fs.mkdirSync(ssd, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(transcripts, { recursive: true });
  return { root, home, ram, ssd, inbox, transcripts };
}

async function createLegacyConcentratorStatsTable(dbPath) {
  const db = await lancedb.connect(dbPath);
  await db.createEmptyTable('concentrator_stats', new Schema([
    new Field('id', new Utf8(), false),
    new Field('timestamp', new Int64(), false),
    new Field('sessionKey', new Utf8(), false),
    new Field('source', new Utf8(), false),
    new Field('outcome', new Utf8(), false),
    new Field('reason', new Utf8(), true),
    new Field('durationMs', new Int64(), true),
    new Field('meta', new Utf8(), true),
  ]));
}

async function withTempStore(prefix, fn, setupBeforeStore) {
  const paths = makeTempPaths(prefix);
  const oldHome = process.env.HOME;
  const oldTranscriptPath = process.env.MEMORY_TRANSCRIPT_PATH;
  process.env.HOME = paths.home;
  process.env.MEMORY_TRANSCRIPT_PATH = paths.transcripts;
  transcriptArchive = createTranscriptArchive(paths.transcripts);
  transcriptArchive.clearTranscriptCache();

  if (setupBeforeStore) {
    await setupBeforeStore(paths);
  }

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
    transcriptArchive.clearTranscriptCache();
    fs.rmSync(paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function makeMessages() {
  return [
    { role: 'user', content: '請整理我們剛剛討論的 memory river D2-3 metric 設計。', timestamp: 1710000000000 },
    { role: 'assistant', content: '需要新增 concentrator_stats，記錄 provider fallback 成敗。', timestamp: 1710000001000 },
  ];
}

function makeAdapter(paths, store, callProvider) {
  const adapter = new ConcentratorAdapter({
    apiKey: 'gemini-key',
    model: 'gemini-test',
    inboxPath: paths.inbox,
    concentrationTarget: 1,
    minimaxApiKey: 'minimax-key',
    lmStudioFallback: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:65535',
      modelId: 'local-test',
    },
    statsStore: store,
    transcriptArchive,
    sessionSummaryDir: path.join(paths.root, 'session-summaries'),
  });

  adapter.callProvider = callProvider;
  adapter.writeSessionSummary = async () => {};
  adapter.capsuleBridge = {
    async writeToInbox() {
      return path.join(paths.inbox, 'captured.txt');
    },
  };
  return adapter;
}

test('successful concentrate writes one success concentrator_stats row', async () => {
  await withTempStore('concentrator-stats-success-', async ({ store, paths }) => {
    const identity = {
      canonicalKey: 'canonical:stats:success',
      sessionKey: 'session-stats-success',
      sessionId: 'sid-stats-success',
    };
    const attempted = [];
    const adapter = makeAdapter(paths, store, async (provider) => {
      attempted.push(provider);
      return JSON.stringify({
        capsule: 'metric capsule success',
        notes: [],
        confidence: 0.9,
      });
    });

    await adapter.concentrate(makeMessages(), false, true, { sessionIdentity: identity });

    assert.deepEqual(attempted, ['gemini']);
    const rows = await store.getRecentConcentratorStats(10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canonicalKey, identity.canonicalKey);
    assert.equal(rows[0].sessionId, identity.sessionId);
    assert.equal(rows[0].provider, 'gemini');
    assert.equal(rows[0].outcome, 'success');
    assert.deepEqual(JSON.parse(rows[0].attemptedProviders), ['gemini']);
    assert.ok(rows[0].inputTokens > 0);
    assert.ok(rows[0].outputTokens > 0);
    assert.equal(rows[0].failureReason, null);
  });
});

test('all provider failures write one failure concentrator_stats row', async () => {
  await withTempStore('concentrator-stats-failure-', async ({ store, paths }) => {
    const identity = {
      canonicalKey: 'canonical:stats:failure',
      sessionKey: 'session-stats-failure',
      sessionId: 'sid-stats-failure',
    };
    const attempted = [];
    const adapter = makeAdapter(paths, store, async (provider) => {
      attempted.push(provider);
      throw new Error(`timeout from ${provider}`);
    });

    await adapter.concentrate(makeMessages(), false, true, { sessionIdentity: identity });

    assert.deepEqual(attempted, ['gemini']);
    const rows = await store.getRecentConcentratorStats(10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canonicalKey, identity.canonicalKey);
    assert.equal(rows[0].sessionId, identity.sessionId);
    assert.equal(rows[0].provider, 'all_failed');
    assert.equal(rows[0].outcome, 'failure');
    assert.deepEqual(JSON.parse(rows[0].attemptedProviders), ['gemini', 'deepseek']);
    assert.ok(rows[0].inputTokens > 0);
    assert.equal(rows[0].outputTokens, null);
    assert.equal(rows[0].failureReason, 'timeout');
  });
});

test('legacy concentrator_stats table migrates by adding metric columns without rebuild', async () => {
  await withTempStore(
    'concentrator-stats-migration-',
    async ({ store }) => {
      await store.recordConcentratorStat({
        canonicalKey: 'canonical:stats:migrated',
        sessionId: null,
        provider: 'gemini',
        outcome: 'success',
        attemptedProviders: JSON.stringify(['gemini']),
        inputTokens: 123,
        outputTokens: 45,
        durationMs: 67,
        failureReason: null,
      });

      const rows = await store.queryConcentratorStats({
        canonicalKey: 'canonical:stats:migrated',
        limit: 5,
      });

      assert.equal(rows.length, 1);
      assert.equal(rows[0].canonicalKey, 'canonical:stats:migrated');
      assert.equal(rows[0].provider, 'gemini');
      assert.equal(rows[0].outcome, 'success');
      assert.equal(rows[0].inputTokens, 123);
      assert.equal(rows[0].outputTokens, 45);
    },
    async (paths) => {
      await createLegacyConcentratorStatsTable(paths.ram);
      await createLegacyConcentratorStatsTable(paths.ssd);
    },
  );
});
