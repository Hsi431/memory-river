import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '@memory-river/core/store/store-v4';
import { createTranscriptArchive } from '@memory-river/core/transcript/transcript-archive';
import { resolveArchivedLineCount, persistArchivedLineCount } from '../dist/index.js';

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
    try {
      fs.rmSync(paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${paths.root}:`, error?.code ?? error);
    }
  }
}

test('transcript watermark write then read returns correct lineCount', async () => {
  await withTempStore('watermark-store-', async ({ store }) => {
    await store.setTranscriptWatermark('canonical:test:1', 'session:test:1', 123);
    await store.setTranscriptWatermark('canonical:test:1', 'session:test:1', 1234);
    const row = await store.getTranscriptWatermark('canonical:test:1');
    assert.ok(row);
    assert.equal(row.canonicalKey, 'canonical:test:1');
    assert.equal(row.sessionId, 'session:test:1');
    assert.equal(row.lineCount, 1234);
    assert.equal(typeof row.updatedAt, 'number');
  });
});

test('watermark write failure only warns and archive still succeeds', async () => {
  const paths = makeTempPaths('watermark-archive-');
  const oldTranscriptPath = process.env.MEMORY_TRANSCRIPT_PATH;
  process.env.MEMORY_TRANSCRIPT_PATH = paths.transcripts;

  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));

  try {
    const { archiveSnapshot } = createTranscriptArchive(paths.transcripts);
    const result = archiveSnapshot(
      { canonicalKey: 'canonical:test:warn', sessionKey: 'session-test-warn', sessionId: 'sid' },
      [
        { role: 'user', content: 'hi', timestamp: 100 },
        { role: 'assistant', content: 'hello', timestamp: 101 },
      ],
    );
    assert.equal(result.ok, true);
    assert.equal(result.appendedEntries, 1);

    const filePath = path.join(paths.transcripts, 'session-test-warn.jsonl');
    assert.equal(fs.existsSync(filePath), true);

    await persistArchivedLineCount({
      async setTranscriptWatermark(canonicalKey, sessionId, lineCount) {
        assert.equal(canonicalKey, 'canonical:test:warn');
        assert.equal(sessionId, 'sid');
        assert.equal(lineCount, 2);
        throw new Error('boom');
      },
    }, 'canonical:test:warn', 'sid', 2);

    assert.ok(warns.some((line) => line.includes('Failed to write transcript watermark')));
    assert.ok(fs.readFileSync(filePath, 'utf-8').includes('"entryId"'));
  } finally {
    console.warn = originalWarn;
    if (oldTranscriptPath === undefined) delete process.env.MEMORY_TRANSCRIPT_PATH;
    else process.env.MEMORY_TRANSCRIPT_PATH = oldTranscriptPath;
    try {
      fs.rmSync(paths.root, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${paths.root}:`, error?.code ?? error);
    }
  }
});

test('cache miss reads transcript watermark from table, then subsequent read hits cache', async () => {
  await withTempStore('watermark-cache-', async ({ store }) => {
    const key = 'canonical:test:cache';
    const sessionId = 'session:test:cache';
    await store.setTranscriptWatermark(key, sessionId, 77);

    const first = await resolveArchivedLineCount(store, key, sessionId);
    assert.deepEqual(first, { sessionId, lineCount: 77 });

    const originalGetter = store.getTranscriptWatermark.bind(store);
    let invoked = 0;
    store.getTranscriptWatermark = async (...args) => {
      invoked += 1;
      return originalGetter(...args);
    };

    const second = await resolveArchivedLineCount(store, key, sessionId);
    assert.deepEqual(second, { sessionId, lineCount: 77 });
    assert.equal(invoked, 0);
  });
});

test('watermark cache is session-bound and session switch reads then overwrites row', async () => {
  await withTempStore('watermark-session-switch-', async ({ store }) => {
    const key = 'canonical:test:session-switch';
    await store.setTranscriptWatermark(key, 'S1', 100);

    const first = await resolveArchivedLineCount(store, key, 'S1');
    assert.deepEqual(first, { sessionId: 'S1', lineCount: 100 });

    const secondSessionRead = await resolveArchivedLineCount(store, key, 'S2');
    assert.deepEqual(secondSessionRead, { sessionId: 'S1', lineCount: 100 });

    await store.setTranscriptWatermark(key, 'S2', 50);
    const afterOverwrite = await resolveArchivedLineCount(store, key, 'S2');
    assert.deepEqual(afterOverwrite, { sessionId: 'S2', lineCount: 50 });
  });
});

test('watermark row supports null sessionId and does not satisfy non-null session cache lookups', async () => {
  await withTempStore('watermark-null-session-', async ({ store }) => {
    const key = 'canonical:test:null-session';
    await store.setTranscriptWatermark(key, null, 200);

    const nullSessionRead = await resolveArchivedLineCount(store, key, null);
    assert.deepEqual(nullSessionRead, { sessionId: null, lineCount: 200 });

    const originalGetter = store.getTranscriptWatermark.bind(store);
    let invoked = 0;
    store.getTranscriptWatermark = async (...args) => {
      invoked += 1;
      return originalGetter(...args);
    };

    const nonNullSessionRead = await resolveArchivedLineCount(store, key, 'SX');
    assert.deepEqual(nonNullSessionRead, { sessionId: null, lineCount: 200 });
    assert.equal(invoked, 1);
  });
});
