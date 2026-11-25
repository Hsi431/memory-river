import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';

function createArchive(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'F3-transcript-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = createTranscriptArchive(root);
  return {
    archive,
    identity: { canonicalKey: 'lossless-session', sessionKey: 'lossless-session', sessionId: 'lossless-session' },
  };
}

test('re-archiving a growing snapshot does not duplicate turns that gained more assistant messages', (t) => {
  const { archive, identity } = createArchive(t);
  const turn = [
    { role: 'user', content: 'question', timestamp: 1710000000000 },
    { role: 'assistant', content: 'first response' },
  ];

  archive.archiveSnapshot(identity, turn);
  archive.archiveSnapshot(identity, [...turn, { role: 'assistant', content: 'follow-up response' }]);

  const entries = archive.getRawTranscript(identity);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].assistant, 'first response');
});

test('archiveSnapshot keeps consecutive user messages as separate entries', (t) => {
  const { archive, identity } = createArchive(t);

  archive.archiveSnapshot(identity, [
    { role: 'user', content: 'first question', timestamp: 1710000000000 },
    { role: 'user', content: 'second question', timestamp: 1710000001000 },
    { role: 'assistant', content: 'second answer' },
  ]);

  const entries = archive.getRawTranscript(identity);
  assert.deepEqual(entries.map(({ user, assistant }) => ({ user, assistant })), [
    { user: 'first question', assistant: '' },
    { user: 'second question', assistant: 'second answer' },
  ]);
});

test('getRawTranscript logs and skips malformed lines while reading later entries', (t) => {
  const { archive, identity } = createArchive(t);
  const filePath = archive.getTranscriptPath(identity.sessionKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    JSON.stringify({ entryId: 1, user: 'before', assistant: '', timestamp: 1710000000000 }),
    '{malformed json',
    JSON.stringify({ entryId: 2, user: 'after', assistant: 'still read', timestamp: 1710000001000 }),
  ].join('\n') + '\n');
  archive.clearTranscriptCache();

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const entries = archive.getRawTranscript(identity);
    assert.deepEqual(entries.map(({ entryId, user }) => ({ entryId, user })), [
      { entryId: 1, user: 'before' },
      { entryId: 2, user: 'after' },
    ]);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join(' '), /malformed/i);
});
