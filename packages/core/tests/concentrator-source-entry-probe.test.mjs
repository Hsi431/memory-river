import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyBoundaryHeuristicForProbe,
  buildComparableTranscriptCandidates,
  ConcentratorAdapter,
  findProbeTextMismatchDetail,
  logProbeTextMismatchDetail,
} from '../dist/distill/concentrator-adapter.js';
import {
  createTranscriptArchive,
} from '../dist/transcript/transcript-archive.js';
import { MemoryRiverEngine } from '../dist/engine.js';

let transcriptArchive;
let archiveSnapshot;
let clearTranscriptCache;
let getRawTranscript;

function makeIdentity(name) {
  return {
    canonicalKey: `canonical:${name}`,
    sessionKey: `session-${name}`,
    sessionId: `sid-${name}`,
  };
}

function makeCaptureAdapter(tempDir, writes) {
  const adapter = new ConcentratorAdapter({
    apiKey: 'test-api-key',
    model: 'test-model',
    inboxPath: path.join(tempDir, 'inbox'),
    concentrationTarget: 1,
    transcriptArchive,
    sessionSummaryDir: path.join(tempDir, 'session-summaries'),
  });

  adapter.callWithFallback = async () => JSON.stringify({
    capsule: 'test capsule',
    notes: [],
    confidence: 0.9,
  });
  adapter.writeSessionSummary = async () => {};
  adapter.capsuleBridge = {
    async writeToInbox(text, opts) {
      writes.push({ text, opts });
      return path.join(tempDir, 'captured-capsule.txt');
    },
  };

  return adapter;
}

async function withTempTranscript(prefix, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const oldTranscriptPath = process.env.MEMORY_TRANSCRIPT_PATH;
  process.env.MEMORY_TRANSCRIPT_PATH = path.join(root, 'transcripts');
  fs.mkdirSync(process.env.MEMORY_TRANSCRIPT_PATH, { recursive: true });
  transcriptArchive = createTranscriptArchive(process.env.MEMORY_TRANSCRIPT_PATH);
  ({ archiveSnapshot, clearTranscriptCache, getRawTranscript } = transcriptArchive);
  clearTranscriptCache();

  try {
    await fn({ root });
  } finally {
    if (oldTranscriptPath === undefined) delete process.env.MEMORY_TRANSCRIPT_PATH;
    else process.env.MEMORY_TRANSCRIPT_PATH = oldTranscriptPath;
    clearTranscriptCache();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  }
}

async function concentrateAndCapture(identity, messages, root) {
  const writes = [];
  const adapter = makeCaptureAdapter(root, writes);
  await adapter.concentrate(messages, false, true, { sessionIdentity: identity });
  assert.equal(writes.length, 1);
  return writes[0];
}

function makeCompactEngine(root, writes) {
  const adapter = makeCaptureAdapter(root, writes);
  const engine = new MemoryRiverEngine({}, {
    paths: {},
    transcriptArchive,
    deriveSessionFile: () => null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  });
  engine.activeConcentrator = adapter;
  engine.activePluginConfig = {
    concentration: {
      asyncCompactRaceGuard: false,
    },
  };
  return engine;
}

function writeSessionFile(sessionFile, identity, messages) {
  const lines = [
    JSON.stringify({
      type: 'session',
      id: identity.sessionId,
      timestamp: new Date(messages[0].timestamp).toISOString(),
    }),
    ...messages.map((message) => JSON.stringify({
      type: 'message',
      timestamp: new Date(message.timestamp).toISOString(),
      message: {
        role: message.role,
        content: message.content,
      },
    })),
  ];
  fs.writeFileSync(sessionFile, `${lines.join('\n')}\n`, 'utf8');
}

test('buildComparableTranscriptCandidates filters System: [..] Exec transcript rows', () => {
  const candidates = buildComparableTranscriptCandidates([
    {
      entryId: 1,
      timestamp: 1710000000000,
      user: 'Conversation info (untrusted metadata): ```json {"sender":"alice"}```\n\n正常問題',
      assistant: '正常回答',
    },
    {
      entryId: 2,
      timestamp: 1710000001000,
      user: 'System: [2026-04-27 20:39:42 GMT+8] Exec completed (delta-wh, code 0) :: /home/user/.npm-global/bin/openclaw',
      assistant: '整理如下：Read-only tools...',
    },
    {
      entryId: 3,
      timestamp: 1710000002000,
      user: 'System: [2026-04-26 00:20:15 GMT+8] Exec failed (clear-ot, signal SIGTERM) :: graphify timeout',
      assistant: '[[reply_to_current]] 了解，先查不動 🦐',
    },
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].entryId, 1);
  assert.equal(candidates[0].user, '正常問題');
  assert.equal(candidates[0].assistant, '正常回答');
});

test('buildComparableTranscriptCandidates keeps normal rows including orphan pairs', () => {
  const candidates = buildComparableTranscriptCandidates([
    {
      entryId: 11,
      timestamp: 1710000003000,
      user: '一般對話',
      assistant: '有回覆',
    },
    {
      entryId: 12,
      timestamp: 1710000004000,
      user: '先做調查跟建議 先不動code',
      assistant: '',
    },
  ]);

  assert.deepEqual(
    candidates.map((entry) => ({ entryId: entry.entryId, user: entry.user, assistant: entry.assistant })),
    [{ entryId: 11, user: '一般對話', assistant: '有回覆' }]
  );
});

test('buildComparableTranscriptCandidates merges one orphan into next terminator', () => {
  const candidates = buildComparableTranscriptCandidates([
    {
      entryId: 21,
      timestamp: 1710000100000,
      user: '先做調查跟建議 先不動code',
      assistant: '',
    },
    {
      entryId: 22,
      timestamp: 1710000101000,
      user: '[media attached: file.pdf]',
      assistant: '後續回覆',
    },
  ]);

  assert.deepEqual(candidates, [
    {
      entryId: 22,
      timestamp: 1710000101000,
      user: '先做調查跟建議 先不動code [media attached: file.pdf]',
      assistant: '後續回覆',
      mergedFromEntryIds: [21, 22],
    },
  ]);
});

test('buildComparableTranscriptCandidates merges two consecutive orphans into next terminator', () => {
  const candidates = buildComparableTranscriptCandidates([
    {
      entryId: 31,
      timestamp: 1710000200000,
      user: '第一段 orphan',
      assistant: '',
    },
    {
      entryId: 32,
      timestamp: 1710000200100,
      user: '第二段 orphan',
      assistant: '',
    },
    {
      entryId: 33,
      timestamp: 1710000201000,
      user: '真正 user',
      assistant: '真正 assistant',
    },
  ]);

  assert.deepEqual(candidates, [
    {
      entryId: 33,
      timestamp: 1710000201000,
      user: '第一段 orphan 第二段 orphan 真正 user',
      assistant: '真正 assistant',
      mergedFromEntryIds: [31, 32, 33],
    },
  ]);
});

test('buildComparableTranscriptCandidates filters system exec before merging orphan into terminator', () => {
  const candidates = buildComparableTranscriptCandidates([
    {
      entryId: 41,
      timestamp: 1710000300000,
      user: 'orphan user',
      assistant: '',
    },
    {
      entryId: 42,
      timestamp: 1710000300100,
      user: 'System: [2026-04-27 20:39:42 GMT+8] Exec completed (delta-wh, code 0) :: tool output',
      assistant: '這筆應被過濾',
    },
    {
      entryId: 43,
      timestamp: 1710000301000,
      user: 'terminator user',
      assistant: 'terminator assistant',
    },
  ]);

  assert.deepEqual(candidates, [
    {
      entryId: 43,
      timestamp: 1710000301000,
      user: 'orphan user terminator user',
      assistant: 'terminator assistant',
      mergedFromEntryIds: [41, 43],
    },
  ]);
});

test('buildComparableTranscriptCandidates keeps non-orphan rows unchanged', () => {
  const candidates = buildComparableTranscriptCandidates([
    {
      entryId: 51,
      timestamp: 1710000400000,
      user: '一般 user',
      assistant: '一般 assistant',
    },
  ]);

  assert.deepEqual(candidates, [
    {
      entryId: 51,
      timestamp: 1710000400000,
      user: '一般 user',
      assistant: '一般 assistant',
      mergedFromEntryIds: undefined,
    },
  ]);
});

test('buildComparableTranscriptPairs drops trailing summarize-only user without assistant', async () => {
  const { buildComparableTranscriptPairs } = await import('../dist/distill/concentrator-adapter.js');

  const pairs = buildComparableTranscriptPairs([
    { role: 'user', content: '第一句', timestamp: 1710000010000 },
    { role: 'assistant', content: '第一句回覆', timestamp: 1710000010100 },
    { role: 'user', content: '第二句只有 user', timestamp: 1710000010200 },
  ]);

  assert.deepEqual(pairs, [
    {
      user: '第一句',
      assistant: '第一句回覆',
      timestamp: 1710000010000,
    },
  ]);
});

test('applyBoundaryHeuristicForProbe triggers on exact +1 candidate and drops last row', () => {
  const summarizePairs = [
    { entryId: 1, user: 'u1', assistant: 'a1', timestamp: 1 },
    { entryId: 2, user: 'u2', assistant: 'a2', timestamp: 2 },
  ];
  const candidateEntries = [
    { entryId: 1, user: 'u1', assistant: 'a1', timestamp: 1 },
    { entryId: 2, user: 'u2', assistant: 'a2', timestamp: 2 },
    { entryId: 3, user: 'u3', assistant: 'a3', timestamp: 3 },
  ];

  const result = applyBoundaryHeuristicForProbe(candidateEntries, summarizePairs.length);

  assert.equal(result.triggered, true);
  assert.equal(result.originalCandidateCount, 3);
  assert.equal(result.droppedCandidate?.entryId, 3);
  assert.deepEqual(result.candidateEntries, summarizePairs);
});

test('applyBoundaryHeuristicForProbe does not trigger when counts already match', () => {
  const candidateEntries = [
    { entryId: 1, user: 'u1', assistant: 'a1', timestamp: 1 },
    { entryId: 2, user: 'u2', assistant: 'a2', timestamp: 2 },
  ];

  const result = applyBoundaryHeuristicForProbe(candidateEntries, 2);

  assert.equal(result.triggered, false);
  assert.equal(result.originalCandidateCount, 2);
  assert.deepEqual(result.candidateEntries, candidateEntries);
});

test('applyBoundaryHeuristicForProbe does not trigger when candidate exceeds summarize by 2', () => {
  const candidateEntries = [
    { entryId: 1, user: 'u1', assistant: 'a1', timestamp: 1 },
    { entryId: 2, user: 'u2', assistant: 'a2', timestamp: 2 },
    { entryId: 3, user: 'u3', assistant: 'a3', timestamp: 3 },
    { entryId: 4, user: 'u4', assistant: 'a4', timestamp: 4 },
  ];

  const result = applyBoundaryHeuristicForProbe(candidateEntries, 2);

  assert.equal(result.triggered, false);
  assert.equal(result.originalCandidateCount, 4);
  assert.deepEqual(result.candidateEntries, candidateEntries);
});

test('applyBoundaryHeuristicForProbe does not trigger when candidate is fewer than summarize', () => {
  const candidateEntries = [
    { entryId: 1, user: 'u1', assistant: 'a1', timestamp: 1 },
  ];

  const result = applyBoundaryHeuristicForProbe(candidateEntries, 2);

  assert.equal(result.triggered, false);
  assert.equal(result.originalCandidateCount, 1);
  assert.deepEqual(result.candidateEntries, candidateEntries);
});

test('logProbeTextMismatchDetail emits mismatch diagnostics for first differing assistant char', () => {
  const detail = findProbeTextMismatchDetail(
    [
      { user: 'same user', assistant: 'answer A', timestamp: 1 },
    ],
    [
      { entryId: 42, user: 'same user', assistant: 'answer B', timestamp: 1 },
    ],
  );

  assert.ok(detail);

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    logProbeTextMismatchDetail(detail);
  } finally {
    console.log = originalLog;
  }

  assert.equal(logs.length, 8);
  assert.match(logs[0], /text_mismatch detail: index=0 entryId=42/);
  assert.match(logs[1], /summarize\.user\[0\.\.200\]/);
  assert.match(logs[2], /candidate\.user\[0\.\.200\]/);
  assert.match(logs[4], /summarize\.assistant\[0\.\.200\]/);
  assert.match(logs[5], /candidate\.assistant\[0\.\.200\]/);
  assert.match(logs[7], /first diff at assistant index 7: summarize="A"\(65\) candidate="B"\(66\)/);
});

test('concentrate writes matched sourceEntryIds into capsule metadata', async () => {
  await withTempTranscript('source-entry-ids-', async ({ root }) => {
    const identity = makeIdentity('matched');
    const messages = [
      { role: 'user', content: '第一個問題', timestamp: 1710001000000 },
      { role: 'assistant', content: '第一個回答', timestamp: 1710001000001 },
      { role: 'user', content: '第二個問題', timestamp: 1710001001000 },
      { role: 'assistant', content: '第二個回答', timestamp: 1710001001001 },
    ];

    archiveSnapshot(identity, messages);
    const expectedIds = getRawTranscript(identity).map((entry) => entry.entryId);
    assert.equal(expectedIds.length, 2);

    const write = await concentrateAndCapture(identity, messages, root);

    assert.deepEqual(write.opts.metadata.sourceEntryIds, expectedIds);
    assert.deepEqual(write.opts.metadata.sourceEntryRange, {
      firstEntryId: expectedIds[0],
      lastEntryId: expectedIds[expectedIds.length - 1],
      count: expectedIds.length,
    });
  });
});

test('LoCoMo-shaped concentration keeps exact provenance on capsule and notes', async () => {
  await withTempTranscript('source-entry-ids-locomo-', async ({ root }) => {
    const identity = makeIdentity('locomo');
    const messages = [
      { role: 'user', content: 'Caroline: I joined the support group yesterday.', timestamp: Date.parse('2023-05-08T13:56:00Z') },
      { role: 'assistant', content: 'Melanie: That sounds helpful.', timestamp: Date.parse('2023-05-08T13:57:00Z') },
      { role: 'user', content: 'Caroline: The meeting was welcoming.', timestamp: Date.parse('2023-05-08T13:58:00Z') },
      { role: 'assistant', content: 'Melanie: I am glad.', timestamp: Date.parse('2023-05-08T13:59:00Z') },
    ];

    archiveSnapshot(identity, messages);
    const expectedIds = getRawTranscript(identity).map((entry) => entry.entryId);
    const writes = [];
    const adapter = makeCaptureAdapter(root, writes);
    adapter.callWithFallback = async () => JSON.stringify({
      capsule: 'Caroline 參加了互助團體。',
      notes: [{
        text: 'Caroline 參加了互助團體。',
        category: 'fact',
        importance: 0.8,
        tags: ['Caroline'],
      }],
      confidence: 0.5,
    });

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      await adapter.concentrate(messages, false, true, { sessionIdentity: identity });
    } finally {
      console.log = originalLog;
    }

    const probeLog = logs.find(line => line.includes('[ConcentratorAdapter][P0-1 probe]'));
    assert.match(probeLog, /matched=true reason=ok/);
    console.log(`[locomo-probe-repro] ${probeLog}`);
    assert.equal(writes.length, 2);
    for (const write of writes) {
      assert.deepEqual(write.opts.metadata.sourceEntryIds, expectedIds);
      assert.deepEqual(write.opts.metadata.sourceEntryRange, {
        firstEntryId: expectedIds[0],
        lastEntryId: expectedIds.at(-1),
        count: expectedIds.length,
      });
      assert.equal(write.opts.metadata.confidence, 0.5);
    }
  });
});

test('concentrate flattens mergedFromEntryIds into sourceEntryIds in candidate order', async () => {
  await withTempTranscript('source-entry-ids-merged-', async ({ root }) => {
    const identity = makeIdentity('merged');
    archiveSnapshot(identity, [
      { role: 'user', content: 'orphan user', timestamp: 1710002000000 },
    ]);
    archiveSnapshot(identity, [
      { role: 'user', content: 'terminator user', timestamp: 1710002001000 },
      { role: 'assistant', content: 'terminator assistant', timestamp: 1710002001001 },
    ]);
    const expectedIds = getRawTranscript(identity).map((entry) => entry.entryId);
    assert.equal(expectedIds.length, 2);

    const summarizeMessages = [
      { role: 'user', content: 'orphan user terminator user', timestamp: 1710002000000 },
      { role: 'assistant', content: 'terminator assistant', timestamp: 1710002001001 },
    ];

    const write = await concentrateAndCapture(identity, summarizeMessages, root);

    assert.deepEqual(write.opts.metadata.sourceEntryIds, expectedIds);
    assert.deepEqual(new Set(write.opts.metadata.sourceEntryIds).size, expectedIds.length);
    assert.deepEqual(write.opts.metadata.sourceEntryRange, {
      firstEntryId: expectedIds[0],
      lastEntryId: expectedIds[expectedIds.length - 1],
      count: expectedIds.length,
    });
  });
});

test('compact archives timestamp-threaded session entries before probing sourceEntryIds', async () => {
  await withTempTranscript('source-entry-ids-archive-lag-', async ({ root }) => {
    const identity = makeIdentity('archive-lag');
    const messages = [
      { role: 'user', content: '尚未歸檔的問題', timestamp: 1710003000000 },
      { role: 'assistant', content: '尚未歸檔的回答', timestamp: 1710003000001 },
    ];
    const sessionFile = path.join(root, 'session.jsonl');
    const writes = [];
    const engine = makeCompactEngine(root, writes);
    writeSessionFile(sessionFile, identity, messages);

    const result = await engine.compact({
      sessionId: identity.sessionId,
      sessionKey: identity.sessionKey,
      sessionFile,
      force: true,
    });
    const expectedIds = getRawTranscript(identity).map((entry) => entry.entryId);

    assert.deepEqual(result, { ok: true, compacted: true });
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].opts.metadata.sourceEntryIds, expectedIds);
    assert.deepEqual(writes[0].opts.metadata.sourceEntryRange, {
      firstEntryId: expectedIds[0],
      lastEntryId: expectedIds.at(-1),
      count: expectedIds.length,
    });
  });
});

test('compact archive-before-probe is idempotent across repeated calls', async () => {
  await withTempTranscript('source-entry-ids-compact-idempotent-', async ({ root }) => {
    const identity = makeIdentity('compact-idempotent');
    const messages = [
      { role: 'user', content: '只應歸檔一次的問題', timestamp: 1710004000000 },
      { role: 'assistant', content: '只應歸檔一次的回答', timestamp: 1710004000001 },
    ];
    const sessionFile = path.join(root, 'session.jsonl');
    const writes = [];
    const engine = makeCompactEngine(root, writes);
    writeSessionFile(sessionFile, identity, messages);

    const first = await engine.compact({
      sessionId: identity.sessionId,
      sessionKey: identity.sessionKey,
      sessionFile,
      force: true,
    });
    const firstSessionFile = fs.readFileSync(sessionFile, 'utf8');
    const firstTranscript = getRawTranscript(identity);

    const second = await engine.compact({
      sessionId: identity.sessionId,
      sessionKey: identity.sessionKey,
      sessionFile,
      force: true,
    });

    assert.deepEqual(first, { ok: true, compacted: true });
    assert.deepEqual(second, { ok: true, compacted: false, deduped: true });
    assert.equal(fs.readFileSync(sessionFile, 'utf8'), firstSessionFile);
    assert.deepEqual(getRawTranscript(identity), firstTranscript);
    assert.equal(writes.length, 1);
  });
});
