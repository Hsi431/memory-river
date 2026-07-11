import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildKeywordSearchTerms,
  matchesKeywordSearch,
  rankKeywordMatches,
  selectTranscriptFilesForKeywordSearch,
  selectTranscriptFilesForSessionKeywordSearch,
} from '../dist/index.js';

function bestEffortRmSync(target, options) {
  try {
    fs.rmSync(target, options);
  } catch (error) {
    console.warn(`[test-teardown] best-effort rm failed for ${target}:`, error?.code ?? error);
  }
}

function writeTranscript(dir, name, rows, mtimeMs) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8');
  const date = new Date(mtimeMs);
  fs.utimesSync(filePath, date, date);
  return filePath;
}

function scanKeywordFiles(files, keyword) {
  const candidates = [];
  for (const { file } of files) {
    const filePath = files.find((x) => x.file === file)?.filePath;
    const raw = fs.readFileSync(filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      const text = `${entry.user || ''} ${entry.assistant || ''}`.toLowerCase();
      candidates.push({
        value: { file, entryId: entry.entryId, text },
        text,
        timestamp: entry.timestamp,
      });
    }
  }
  return rankKeywordMatches(candidates, keyword, 50);
}

test('tokenize: foo bar accepts partial matches', () => {
  assert.deepEqual(buildKeywordSearchTerms('foo bar'), ['foo', 'bar']);
  assert.equal(matchesKeywordSearch('contains foo and bar together', 'foo bar'), true);
  assert.equal(matchesKeywordSearch('contains only foo here', 'foo bar'), true);
});

test('tokenize: multiple spaces collapse to same token set', () => {
  assert.deepEqual(buildKeywordSearchTerms('foo   bar'), ['foo', 'bar']);
  assert.equal(matchesKeywordSearch('foo then something then bar', 'foo   bar'), true);
});

test('tokenize: single token stays backward compatible substring match', () => {
  assert.equal(matchesKeywordSearch('alphabet soup', 'pha'), true);
  assert.equal(matchesKeywordSearch('alphabet soup', 'zzz'), false);
});

test('tokenize: common single-character tokens are ignored', () => {
  assert.deepEqual(buildKeywordSearchTerms('的 了 a'), []);
  assert.equal(matchesKeywordSearch('他的資料在這裡了', '的 了'), false);
});

test('sessionKey: specified session scans only base plus rotate files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyword-session-specified-'));
  try {
    writeTranscript(dir, 'sessA.jsonl', [
      { entryId: 1, user: 'foo only', assistant: 'base row', timestamp: 1000 },
    ], 4000);
    writeTranscript(dir, 'sessA.1.jsonl', [
      { entryId: 2, user: 'foo middle', assistant: 'still no baz', timestamp: 2000 },
      { entryId: 3, user: 'minimax 到期 配額', assistant: '額度 期限 幾號', timestamp: 3000 },
    ], 3000);
    writeTranscript(dir, 'sessB.jsonl', [
      { entryId: 4, user: 'foo bar from other session', assistant: 'should not scan', timestamp: 5000 },
    ], 5000);

    const files = selectTranscriptFilesForSessionKeywordSearch(dir, 'sessA').map((x) => x.file);
    assert.deepEqual(files, ['sessA.jsonl', 'sessA.1.jsonl']);

    const hits = scanKeywordFiles(selectTranscriptFilesForSessionKeywordSearch(dir, 'sessA'), 'foo bar');
    assert.deepEqual(hits.map((x) => x.entryId), [2, 1]);

    const xiaxiaHits = scanKeywordFiles(
      selectTranscriptFilesForSessionKeywordSearch(dir, 'sessA'),
      'minimax 到期 配額 額度 期限 幾號',
    );
    assert.deepEqual(xiaxiaHits.map((x) => x.entryId), [3]);
  } finally {
    bestEffortRmSync(dir, { recursive: true, force: true });
  }
});

test('sessionKey: unspecified scan keeps latest ten files behavior', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyword-session-unspecified-'));
  try {
    for (let i = 0; i < 11; i++) {
      writeTranscript(dir, `f${i}.jsonl`, [
        { entryId: i + 1, user: `foo row ${i}`, assistant: i === 0 ? 'bar oldest only' : 'no match', timestamp: i + 1 },
      ], 1000 + i);
    }

    const files = selectTranscriptFilesForKeywordSearch(dir, 10);
    assert.equal(files.length, 10);
    assert.equal(files.some((x) => x.file === 'f0.jsonl'), false);

    const hits = scanKeywordFiles(files, 'foo bar');
    assert.equal(hits.length, 10);
    assert.equal(hits.some((x) => x.entryId === 1), false);
  } finally {
    bestEffortRmSync(dir, { recursive: true, force: true });
  }
});
