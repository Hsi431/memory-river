import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryRiverEngine } from '../dist/engine.js';
import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('compact preserves a line appended while concentration is in progress', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-compact-race-'));
  const transcripts = path.join(root, 'transcripts');
  const sessionFile = path.join(root, 'session.jsonl');
  const identity = { sessionId: 'compact-race-id', sessionKey: 'compact-race-key' };
  const concentrateStarted = deferred();
  const releaseConcentrator = deferred();
  const archive = createTranscriptArchive(transcripts);
  const engine = new MemoryRiverEngine({}, {
    paths: {},
    transcriptArchive: archive,
    deriveSessionFile: () => null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  });
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  });

  engine.activePluginConfig = { concentration: { asyncCompactRaceGuard: false } };
  engine.activeConcentrator = {
    async concentrate() {
      concentrateStarted.resolve();
      await releaseConcentrator.promise;
      return {
        wasConcentrated: true,
        messages: [{ role: 'assistant', content: 'compacted summary' }],
      };
    },
    estimateTokens() {
      return 1;
    },
  };

  const originalLines = [
    JSON.stringify({ type: 'session', id: identity.sessionId }),
    JSON.stringify({ type: 'message', timestamp: new Date(1_710_000_000_000).toISOString(), message: { role: 'user', content: 'before compact' } }),
    JSON.stringify({ type: 'message', timestamp: new Date(1_710_000_001_000).toISOString(), message: { role: 'assistant', content: 'before response' } }),
  ];
  fs.writeFileSync(sessionFile, `${originalLines.join('\n')}\n`);

  const compacting = engine.compact({ ...identity, sessionFile, force: true });
  await concentrateStarted.promise;
  fs.appendFileSync(sessionFile, `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'appended during compaction' } })}\n`);
  releaseConcentrator.resolve();

  const result = await compacting;
  assert.deepEqual(result, { ok: true, compacted: false });
  assert.match(fs.readFileSync(sessionFile, 'utf8'), /appended during compaction/);
});

test('compact preserves a line appended after reading messages but before concentration', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-compact-read-race-'));
  const transcripts = path.join(root, 'transcripts');
  const sessionFile = path.join(root, 'session.jsonl');
  const identity = { sessionId: 'compact-read-race-id', sessionKey: 'compact-read-race-key' };
  const archive = createTranscriptArchive(transcripts);
  const engine = new MemoryRiverEngine({}, {
    paths: {},
    transcriptArchive: archive,
    deriveSessionFile: () => null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  });
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  });

  engine.activePluginConfig = { concentration: { asyncCompactRaceGuard: false } };
  engine.activeConcentrator = {
    async concentrate() {
      return {
        wasConcentrated: true,
        messages: [{ role: 'assistant', content: 'compacted summary' }],
      };
    },
    estimateTokens() {
      return 1;
    },
  };

  const originalArchiveTail = engine.archiveSessionFileTail.bind(engine);
  engine.archiveSessionFileTail = async (...args) => {
    fs.appendFileSync(sessionFile, `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'appended after read' } })}\n`);
    return await originalArchiveTail(...args);
  };
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', id: identity.sessionId }),
    JSON.stringify({ type: 'message', timestamp: new Date(1_710_000_000_000).toISOString(), message: { role: 'user', content: 'before compact' } }),
    JSON.stringify({ type: 'message', timestamp: new Date(1_710_000_001_000).toISOString(), message: { role: 'assistant', content: 'before response' } }),
  ].join('\n') + '\n');

  const result = await engine.compact({ ...identity, sessionFile, force: true });
  assert.deepEqual(result, { ok: true, compacted: false });
  assert.match(fs.readFileSync(sessionFile, 'utf8'), /appended after read/);
});
