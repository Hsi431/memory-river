import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDualTrackPrompt,
  buildGeneralConversationPrompt,
  ConcentratorAdapter,
} from '../dist/distill/concentrator-adapter.js';

const notes = [
  { text: '長期偏好：使用繁體中文。', category: 'fact', tags: [] },
  { text: '一次性天氣狀態：今天下午可能下雨。', category: 'fact', tags: [] },
];

async function runConcentration(importanceScorer, distilledNotes = notes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concentrator-importance-'));
  const writes = [];
  let sessionSummary;
  let scoringPrompt = '';

  try {
    const adapter = new ConcentratorAdapter({
      apiKey: 'test-api-key',
      model: 'test-model',
      inboxPath: path.join(root, 'inbox'),
      concentrationTarget: 1,
      transcriptArchive: {},
      sessionSummaryDir: path.join(root, 'session-summaries'),
      llm: {
        async generate() {
          return JSON.stringify({ capsule: 'capsule', notes: distilledNotes, confidence: 0.9 });
        },
      },
      importanceScorer: async (prompt) => {
        scoringPrompt = prompt;
        return importanceScorer(prompt);
      },
    });

    adapter.capsuleBridge = {
      async writeToInbox(text, opts) {
        writes.push({ text, opts });
        return path.join(root, 'captured.txt');
      },
    };
    adapter.writeSessionSummary = async (summary) => {
      sessionSummary = summary;
    };

    await adapter.concentrate([
      { role: 'user', content: '原始對話不應送進第二階段。' },
    ], false, true);

    return { writes, scoringPrompt, sessionSummary };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function noteWrites(writes) {
  return writes.filter(({ text }) => text !== '【前情提要】\ncapsule');
}

test('第一階段 prompt 不再要求 importance 且保留 category、不要收錄與 notes 上限', () => {
  for (const prompt of [
    buildDualTrackPrompt('USER: test'),
    buildDualTrackPrompt('USER: test', 'source'),
    buildGeneralConversationPrompt('USER: test'),
    buildGeneralConversationPrompt('USER: test', 'source'),
  ]) {
    assert.equal(prompt.includes('importance 依'), false);
    assert.match(prompt, /不要收錄/);
    assert.match(prompt, /category/);
    assert.match(prompt, /notes 筆數上限/);
  }
});

test('兩階段串接：評分結果按 note 順序寫入', async () => {
  const result = await runConcentration(async () => '{"r":[{"n":1,"i":0.9},{"n":2,"i":0.1}]}');

  assert.deepEqual(result.sessionSummary.notes.map(({ text }) => text), [notes[0].text, notes[1].text]);
  assert.deepEqual(result.sessionSummary.notes.map(({ importance }) => importance), [0.9, 0.1]);
  assert.match(result.scoringPrompt, new RegExp(notes[0].text));
  assert.match(result.scoringPrompt, new RegExp(notes[1].text));
  assert.equal(result.scoringPrompt.includes('原始對話不應送進第二階段。'), false);
});

test('入庫門檻仍以 category 與第二階段 importance 判定', async () => {
  const result = await runConcentration(async () => '{"r":[{"n":1,"i":0.9},{"n":2,"i":0.1}]}');
  const written = noteWrites(result.writes);

  assert.deepEqual(written.map(({ text }) => text), [notes[0].text]);
  assert.equal(written[0].opts.importance, 0.9);
});

test('評分器整個失敗時所有 notes 都使用 0.5 fallback 且不丟棄', async () => {
  const result = await runConcentration(async () => {
    throw new Error('scorer timeout');
  });
  const written = noteWrites(result.writes);

  assert.equal(written.length, 2);
  assert.deepEqual(written.map(({ opts }) => opts.importance), [0.5, 0.5]);
  assert.deepEqual(written.map(({ opts }) => opts.metadata.importanceFallback), [true, true]);
});

test('評分結果部分缺漏時缺漏 note 使用 0.5 fallback', async () => {
  const result = await runConcentration(async () => 'progress\n{"r":[{"n":1,"i":0.9}]}');
  const written = noteWrites(result.writes);

  assert.equal(written.length, 2);
  assert.deepEqual(written.map(({ opts }) => opts.importance), [0.9, 0.5]);
  assert.equal(written[0].opts.metadata.importanceFallback, undefined);
  assert.equal(written[1].opts.metadata.importanceFallback, true);
});
