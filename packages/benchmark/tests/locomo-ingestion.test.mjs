import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  ConcentratorAdapter,
  buildComparableTranscriptPairs,
} from '../../core/dist/distill/concentrator-adapter.js';
import { createMemoryRiver } from '../../core/dist/api.js';
import { turnText } from '../dist/agent/otter.js';
import { createIdxRehydrator } from '../dist/dimensions/locomo.js';
import { FakeEmbeddingProvider } from '../dist/harness/fake-embedder.js';
import { parseLocomo } from '../dist/harness/locomo.js';
import {
  assertNoConcentrationPlaceholders,
} from '../dist/harness/real-river.js';

const fixture = [{
  sample_id: 'ingestion-repro',
  conversation: {
    speaker_a: 'Caroline',
    speaker_b: 'Melanie',
    session_1_date_time: '1:56 pm on 8 May, 2023',
    session_1: [
      {
        speaker: 'Caroline',
        dia_id: 'D1:1',
        text: 'I joined the support group yesterday.',
      },
      {
        speaker: 'Melanie',
        dia_id: 'D1:2',
        text: 'That sounds helpful.',
      },
      {
        speaker: 'Caroline',
        dia_id: 'D1:3',
        text: 'The meeting was welcoming.',
      },
      {
        speaker: 'Melanie',
        dia_id: 'D1:4',
        text: 'I am glad.',
      },
    ],
  },
  qa: [],
}];

function makeAdapter() {
  return new ConcentratorAdapter({
    apiKey: 'unit-test',
    model: 'unit-test',
    inboxPath: '/tmp/locomo-ingestion-repro',
    concentrationTarget: 1,
  });
}

test('LoCoMo harness content survives concentration filtering and transcript pairing', () => {
  const legacyMessages = [
    {
      role: 'user',
      content: '[1:56 pm on 8 May, 2023] Caroline: I joined the support group yesterday.',
      timestamp: 1,
    },
    {
      role: 'assistant',
      content: '[1:57 pm on 8 May, 2023] Melanie: That sounds helpful.',
      timestamp: 2,
    },
    {
      role: 'user',
      content: '[1:58 pm on 8 May, 2023] Caroline: The meeting was welcoming.',
      timestamp: 3,
    },
    {
      role: 'assistant',
      content: '[1:59 pm on 8 May, 2023] Melanie: I am glad.',
      timestamp: 4,
    },
  ];

  assert.equal(buildComparableTranscriptPairs(legacyMessages).length, 2);
  const legacyFallback = makeAdapter().buildFallbackCapsule(legacyMessages);
  assert.match(legacyFallback, /Primary Request and Intent\n無/);
  assert.doesNotMatch(legacyFallback, /support group|meeting was welcoming/);

  const [conversation] = parseLocomo(fixture);
  const messages = conversation.sessions[0].messages;
  assert.deepEqual(messages.map(message => message.content), [
    'Caroline: I joined the support group yesterday.',
    'Melanie: That sounds helpful.',
    'Caroline: The meeting was welcoming.',
    'Melanie: I am glad.',
  ]);
  assert.equal(buildComparableTranscriptPairs(messages).length, 2);

  const fallback = makeAdapter().buildFallbackCapsule(messages);
  assert.match(fallback, /Caroline: The meeting was welcoming\./);
  assert.match(fallback, /Melanie: I am glad\./);
});

test('benchmark ingestion guard rejects empty-conversation placeholder memories', () => {
  assert.doesNotThrow(() => assertNoConcentrationPlaceholders([
    '【前情提要】 Caroline joined a support group.',
    'Melanie encouraged Caroline.',
  ]));

  assert.throws(
    () => assertNoConcentrationPlaceholders([
      '【前情提要】 由於對話內容為空，目前沒有任何可供參考的前情提要',
      'A valid memory',
      '無法生成前情提要，因為沒有任何對話內容。',
    ]),
    /BenchmarkIngestionError: concentration produced empty-conversation placeholder\(s\) — 2 of 3 memories are placeholders/,
  );
});

test('LoCoMo archive entry_ids rehydrate returns the original dated turns', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locomo-entry-ids-'));
  const dataDir = path.join(root, 'data');
  const river = createMemoryRiver(
    { dataDir, ramDir: path.join(root, 'ram') },
    {
      embedder: new FakeEmbeddingProvider(),
      llm: { async generate() { return ''; } },
      logger: { info() {}, warn() {}, error() {} },
    },
  );
  try {
    await river.start();
    const transcriptsDir = path.join(dataDir, 'transcripts');
    const sessionKey = 'locomo-0-s1';
    const [conversation] = parseLocomo(fixture);
    const messages = conversation.sessions[0].messages;
    await river.archiveTranscript({ sessionKey, sessionId: sessionKey }, messages);
    const entryIds = fs.readFileSync(path.join(transcriptsDir, `${sessionKey}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line).entryId);

    const rehydrate = createIdxRehydrator(transcriptsDir, [sessionKey]);
    const turns = await rehydrate(entryIds, 10);

    assert.equal(turns.length, 2);
    assert.match(turnText(turns), /^\[T1\]\n\[2023-05-08\] user: Caroline:/);
  } finally {
    await river.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
