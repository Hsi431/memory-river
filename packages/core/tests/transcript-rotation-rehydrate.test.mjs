import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';
import { rehydrate, rehydrateByTime } from '../dist/transcript/rehydrate.js';

function messages(user, assistant, timestamp) {
  return [
    { role: 'user', content: user, timestamp },
    { role: 'assistant', content: assistant, timestamp: timestamp + 1 },
  ];
}

test('rehydrates IDs and time ranges across a real transcript rotation', async (t) => {
  const transcriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-transcript-rotation-'));
  const archive = createTranscriptArchive(transcriptsDir);
  const identity = { canonicalKey: 'rotation-session', sessionKey: 'rotation-session', sessionId: 'rotation-session' };
  const firstTimestamp = 1_710_000_000_000;
  const largeText = 'x'.repeat(5_300_000);
  t.after(() => fs.rmSync(transcriptsDir, { recursive: true, force: true }));

  archive.archiveSnapshot(identity, messages('old user', 'old assistant', firstTimestamp));
  archive.archiveSnapshot(identity, messages('filler user', largeText, firstTimestamp + 1_000));
  archive.archiveSnapshot(identity, messages('new user', 'new assistant', firstTimestamp + 2_000));

  const transcriptPath = archive.getTranscriptPath(identity.sessionKey);
  assert.equal(fs.existsSync(transcriptPath.replace(/\.jsonl$/, '.1.jsonl')), true);

  const entriesById = await rehydrate(transcriptPath, [1, 3], 0);
  assert.deepEqual(entriesById.map((entry) => entry.entryId), [1, 3]);

  const byTime = await rehydrateByTime(transcriptPath, String(firstTimestamp + 1_000), 1);
  assert.deepEqual(byTime.map((entry) => entry.entryId), [1, 2, 3]);

  const fromCacheWithOldSince = archive.getRawTranscript(identity, firstTimestamp);
  assert.deepEqual(fromCacheWithOldSince.map((entry) => entry.entryId), [1, 2, 3]);
});

test('reads surviving rotations when the primary file is absent and skips an unreadable generation', async (t) => {
  const transcriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-transcript-rotation-gap-'));
  const archive = createTranscriptArchive(transcriptsDir);
  const identity = { canonicalKey: 'rotation-gap', sessionKey: 'rotation-gap', sessionId: 'rotation-gap' };
  const transcriptPath = archive.getTranscriptPath(identity.sessionKey);
  const rotatedPath = transcriptPath.replace(/\.jsonl$/, '.1.jsonl');
  const entry = { entryId: 7, user: 'surviving user', assistant: 'surviving assistant', timestamp: 1_710_000_000_000 };
  t.after(() => fs.rmSync(transcriptsDir, { recursive: true, force: true }));

  fs.writeFileSync(rotatedPath, `${JSON.stringify(entry)}\n`);
  fs.writeFileSync(`${rotatedPath}.idx`, JSON.stringify({ 7: 0 }));
  fs.mkdirSync(transcriptPath.replace(/\.jsonl$/, '.2.jsonl'));

  assert.deepEqual((await rehydrate(transcriptPath, [7], 0)).map((row) => row.entryId), [7]);
  assert.deepEqual((await rehydrateByTime(transcriptPath, String(entry.timestamp), 1)).map((row) => row.entryId), [7]);
  assert.deepEqual(archive.getRawTranscript(identity, entry.timestamp).map((row) => row.entryId), [7]);
});

test('limits cache after merging rotated transcript files from disk', (t) => {
  const transcriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-transcript-cache-limit-'));
  const archive = createTranscriptArchive(transcriptsDir);
  const identity = { canonicalKey: 'cache-limit', sessionKey: 'cache-limit', sessionId: 'cache-limit' };
  const transcriptPath = archive.getTranscriptPath(identity.sessionKey);
  const rotatedPath = transcriptPath.replace(/\.jsonl$/, '.1.jsonl');
  const timestamp = 1_710_000_000_000;
  const largeText = 'x'.repeat(1_100_000);
  const entries = Array.from({ length: 5 }, (_, index) => ({
    entryId: index + 1,
    user: largeText,
    assistant: 'answer',
    timestamp: timestamp + index,
  }));
  t.after(() => fs.rmSync(transcriptsDir, { recursive: true, force: true }));

  fs.writeFileSync(rotatedPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  assert.equal(archive.getRawTranscript(identity).length, 5);
  fs.rmSync(rotatedPath);
  assert.deepEqual(archive.getRawTranscript(identity, timestamp + 1).map((entry) => entry.entryId), [2, 3, 4, 5]);
});
