import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';

let archiveSnapshot;
let clearTranscriptCache;
let getTranscriptPath;

function makeIdentity(sessionKey) {
  return {
    canonicalKey: sessionKey,
    sessionKey,
    sessionId: sessionKey,
  };
}

function makeMessages(user, assistant, timestamp) {
  return [
    { role: 'user', content: user, timestamp },
    { role: 'assistant', content: assistant, timestamp: timestamp + 1 },
  ];
}

function readTranscriptRows(sessionKey) {
  const filePath = getTranscriptPath(sessionKey);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test.beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-transcript-archive-'));
  process.env.MEMORY_TRANSCRIPT_PATH = tmpDir;
  ({ archiveSnapshot, clearTranscriptCache, getTranscriptPath } = createTranscriptArchive(tmpDir));
  clearTranscriptCache();
});

test.afterEach(() => {
  const dir = process.env.MEMORY_TRANSCRIPT_PATH;
  if (dir && fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${dir}:`, error?.code ?? error);
    }
  }
  delete process.env.MEMORY_TRANSCRIPT_PATH;
  clearTranscriptCache();
});

test('same user/assistant/timestamp appended twice skips second write', () => {
  const identity = makeIdentity('dedup-same-ts');
  const messages = makeMessages('same user', 'same assistant', 1710000000000);

  archiveSnapshot(identity, messages);
  archiveSnapshot(identity, messages);

  const rows = readTranscriptRows(identity.sessionKey);
  assert.equal(rows.length, 1);
});

test('same user/assistant but different timestamp writes both rows', () => {
  const identity = makeIdentity('dedup-different-ts');

  archiveSnapshot(identity, makeMessages('same user', 'same assistant', 1710000000000));
  archiveSnapshot(identity, makeMessages('same user', 'same assistant', 1710000005000));

  const rows = readTranscriptRows(identity.sessionKey);
  assert.equal(rows.length, 2);
});

test('normalized whitespace collision skips duplicate row', () => {
  const identity = makeIdentity('dedup-normalized-space');

  archiveSnapshot(identity, makeMessages('  same\u3000user  text ', 'answer   block', 1710000000000));
  archiveSnapshot(identity, makeMessages('same user text', 'answer block', 1710000000000));

  const rows = readTranscriptRows(identity.sessionKey);
  assert.equal(rows.length, 1);
});

test('getTranscriptPath rejects traversal and path separators', () => {
  assert.throws(() => getTranscriptPath('../../etc/x'), /invalid sessionKey/);
  assert.throws(() => getTranscriptPath('a/b'), /invalid sessionKey/);
  assert.throws(() => getTranscriptPath('a\\b'), /invalid sessionKey/);
});

test('getTranscriptPath keeps canonical agent keys under the transcript directory', () => {
  const transcriptDir = path.resolve(process.env.MEMORY_TRANSCRIPT_PATH);
  const transcriptPath = getTranscriptPath('agent:foo:bar');

  assert.equal(transcriptPath, path.join(transcriptDir, 'agent:foo:bar.jsonl'));
  assert.equal(path.dirname(transcriptPath), transcriptDir);
});
