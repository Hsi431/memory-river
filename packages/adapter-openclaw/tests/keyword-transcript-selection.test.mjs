import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { selectTranscriptFilesForKeywordSearch } from '../dist/index.js';

function bestEffortRmSync(target, options) {
  try {
    fs.rmSync(target, options);
  } catch (error) {
    console.warn(`[test-teardown] best-effort rm failed for ${target}:`, error?.code ?? error);
  }
}

function writeTranscript(dir, name, mtimeMs) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, '{"entryId":1,"user":"u","assistant":"a","timestamp":1}\n', 'utf-8');
  const date = new Date(mtimeMs);
  fs.utimesSync(filePath, date, date);
}

test('keyword transcript selection sorts by mtime desc', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyword-transcripts-'));
  try {
    writeTranscript(dir, 'old.jsonl', 1000);
    writeTranscript(dir, 'new.jsonl', 3000);
    writeTranscript(dir, 'mid.jsonl', 2000);

    const files = selectTranscriptFilesForKeywordSearch(dir, 10).map((x) => x.file);
    assert.deepEqual(files, ['new.jsonl', 'mid.jsonl', 'old.jsonl']);
  } finally {
    bestEffortRmSync(dir, { recursive: true, force: true });
  }
});

test('keyword transcript selection returns empty for empty directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyword-transcripts-empty-'));
  try {
    assert.deepEqual(selectTranscriptFilesForKeywordSearch(dir, 10), []);
  } finally {
    bestEffortRmSync(dir, { recursive: true, force: true });
  }
});

test('keyword transcript selection caps at latest ten files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyword-transcripts-cap-'));
  try {
    for (let i = 0; i < 12; i++) {
      writeTranscript(dir, `f${i}.jsonl`, 1000 + i);
    }

    const files = selectTranscriptFilesForKeywordSearch(dir, 10).map((x) => x.file);
    assert.equal(files.length, 10);
    assert.equal(files[0], 'f11.jsonl');
    assert.equal(files.at(-1), 'f2.jsonl');
  } finally {
    bestEffortRmSync(dir, { recursive: true, force: true });
  }
});

test('keyword transcript selection includes latest base transcript file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyword-transcripts-base-'));
  try {
    writeTranscript(dir, 'agent:xiaxia:discord:direct:409637104998416384.1.jsonl', 1000);
    writeTranscript(dir, 'agent:xiaxia:discord:direct:409637104998416384.jsonl', 3000);
    fs.writeFileSync(path.join(dir, 'agent:xiaxia:discord:direct:409637104998416384.jsonl.idx'), '{}', 'utf-8');

    const files = selectTranscriptFilesForKeywordSearch(dir, 10).map((x) => x.file);
    assert.equal(files[0], 'agent:xiaxia:discord:direct:409637104998416384.jsonl');
    assert.equal(files.includes('agent:xiaxia:discord:direct:409637104998416384.jsonl'), true);
    assert.equal(files.includes('agent:xiaxia:discord:direct:409637104998416384.jsonl.idx'), false);
  } finally {
    bestEffortRmSync(dir, { recursive: true, force: true });
  }
});
