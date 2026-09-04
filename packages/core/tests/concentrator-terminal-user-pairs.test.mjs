import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryRiverEngine } from '../dist/engine.js';
import {
  applyBoundaryHeuristicForProbe,
  buildComparableTranscriptCandidates,
  buildComparableTranscriptPairs,
} from '../dist/distill/concentrator-adapter.js';

const BASE_TIMESTAMP = 1710000000000;

function pairTexts(pairs) {
  return pairs.map(({ user, assistant }) => ({ user, assistant }));
}

test('terminal orphan user is flushed symmetrically with its entryId', () => {
  const summarizePairs = buildComparableTranscriptPairs([
    { role: 'user', content: '第一個問題', timestamp: BASE_TIMESTAMP },
    { role: 'assistant', content: '第一個回答', timestamp: BASE_TIMESTAMP + 1 },
    { role: 'user', content: '結尾落單問題', timestamp: BASE_TIMESTAMP + 2 },
  ]);
  const candidatePairs = buildComparableTranscriptCandidates([
    {
      entryId: 101,
      timestamp: BASE_TIMESTAMP,
      user: '第一個問題',
      assistant: '第一個回答',
    },
    {
      entryId: 102,
      timestamp: BASE_TIMESTAMP + 2,
      user: '結尾落單問題',
      assistant: '',
    },
  ]);

  assert.equal(summarizePairs.length, 2);
  assert.equal(candidatePairs.length, 2);
  assert.deepEqual(pairTexts(candidatePairs), pairTexts(summarizePairs));
  assert.equal(summarizePairs.at(-1).assistant, '');
  assert.equal(candidatePairs.at(-1).assistant, '');
  assert.equal(candidatePairs.at(-1).entryId, 102);
});

test('consecutive users are merged identically on summarize and candidate sides', () => {
  const summarizePairs = buildComparableTranscriptPairs([
    { role: 'user', content: '第一段 user', timestamp: BASE_TIMESTAMP },
    { role: 'user', content: '第二段 user', timestamp: BASE_TIMESTAMP + 1 },
    { role: 'assistant', content: '合併後回答', timestamp: BASE_TIMESTAMP + 2 },
  ]);
  const candidatePairs = buildComparableTranscriptCandidates([
    {
      entryId: 201,
      timestamp: BASE_TIMESTAMP,
      user: '第一段 user',
      assistant: '',
    },
    {
      entryId: 202,
      timestamp: BASE_TIMESTAMP + 1,
      user: '第二段 user',
      assistant: '合併後回答',
    },
  ]);

  assert.deepEqual(pairTexts(candidatePairs), pairTexts(summarizePairs));
  assert.equal(candidatePairs[0].user, '第一段 user 第二段 user');
});

test('boundary heuristic realigns an active session terminal orphan', () => {
  const summarizePairs = buildComparableTranscriptPairs([
    { role: 'user', content: '已完成問題', timestamp: BASE_TIMESTAMP },
    { role: 'assistant', content: '已完成回答', timestamp: BASE_TIMESTAMP + 1 },
  ]);
  const candidatePairs = buildComparableTranscriptCandidates([
    {
      entryId: 301,
      timestamp: BASE_TIMESTAMP,
      user: '已完成問題',
      assistant: '已完成回答',
    },
    {
      entryId: 302,
      timestamp: BASE_TIMESTAMP + 2,
      user: '活 session 尾巴',
      assistant: '',
    },
  ]);

  const result = applyBoundaryHeuristicForProbe(candidatePairs, summarizePairs.length);

  assert.equal(result.triggered, true);
  assert.equal(result.droppedCandidate.entryId, 302);
  assert.deepEqual(pairTexts(result.candidateEntries), pairTexts(summarizePairs));
});

test('strictly alternating conversation keeps one pair per turn', () => {
  const messages = [
    { role: 'user', content: '問題一', timestamp: BASE_TIMESTAMP },
    { role: 'assistant', content: '回答一', timestamp: BASE_TIMESTAMP + 1 },
    { role: 'user', content: '問題二', timestamp: BASE_TIMESTAMP + 2 },
    { role: 'assistant', content: '回答二', timestamp: BASE_TIMESTAMP + 3 },
  ];
  const candidates = messages.reduce((entries, message, index) => {
    if (message.role === 'user') {
      entries.push({
        entryId: 401 + entries.length,
        timestamp: message.timestamp,
        user: message.content,
        assistant: messages[index + 1]?.content ?? '',
      });
    }
    return entries;
  }, []);

  const summarizePairs = buildComparableTranscriptPairs(messages);
  const candidatePairs = buildComparableTranscriptCandidates(candidates);

  assert.equal(summarizePairs.length, 2);
  assert.equal(candidatePairs.length, 2);
  assert.deepEqual(pairTexts(candidatePairs), pairTexts(summarizePairs));
});

test('compact passes exhaustive through to the concentrator context', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concentrator-exhaustive-context-'));
  const sessionFile = path.join(root, 'session.jsonl');
  const contexts = [];
  const engine = new MemoryRiverEngine({}, {
    paths: {},
    transcriptArchive: {
      archiveSnapshot() {
        return { ok: true };
      },
      clearTranscriptCache() {},
    },
    deriveSessionFile: () => null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  engine.activePluginConfig = { concentration: { asyncCompactRaceGuard: false } };
  engine.activeConcentrator = {
    async concentrate(messages, _dryRun, _force, context) {
      contexts.push(context);
      return { wasConcentrated: false, messages };
    },
  };
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', id: 'context-test' }),
    JSON.stringify({
      type: 'message',
      timestamp: new Date(BASE_TIMESTAMP).toISOString(),
      message: { role: 'user', content: '需要傳遞 exhaustive 的訊息' },
    }),
  ].join('\n') + '\n');

  await engine.compact({
    sessionId: 'context-test',
    sessionKey: 'context-test',
    sessionFile,
    force: true,
    exhaustive: true,
  });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].exhaustive, true);
});
