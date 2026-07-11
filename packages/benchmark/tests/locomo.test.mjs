import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  createIdxRehydrator,
  isAbstention,
  sampleLocomo,
} from '../dist/dimensions/locomo.js';
import { loadLocomo, parseLocomo } from '../dist/harness/locomo.js';

const fixture = [{
  sample_id: 'fixture-1',
  conversation: {
    speaker_a: 'Alex',
    speaker_b: 'Blair',
    session_2_date_time: '2 January 2024',
    session_2: [
      { speaker: 'Alex', dia_id: 'D2:1', text: 'The launch is Friday.' },
    ],
    session_1_date_time: '1 January 2024',
    session_1: [
      { speaker: 'Alex', dia_id: 'D1:1', text: 'My favorite color is blue.' },
      { speaker: 'Blair', dia_id: 'D1:2', text: 'I will remember that.' },
    ],
  },
  qa: [
    {
      question: 'What is Alex’s favorite color?',
      answer: 'Blue',
      evidence: ['D1:1'],
      category: 4,
    },
    {
      question: 'What is Alex’s favorite animal?',
      evidence: [],
      category: 5,
    },
  ],
}];

test('parseLocomo orders sessions and maps speakers to ContextMessages', () => {
  const [conversation] = parseLocomo(fixture);
  assert.equal(conversation.sampleId, 'fixture-1');
  assert.deepEqual(conversation.sessions.map(session => session.index), [1, 2]);
  assert.equal(conversation.sessions[0].dateTime, '1 January 2024');
  assert.deepEqual(
    conversation.sessions[0].messages.map(({ role, content }) => ({ role, content })),
    [
      { role: 'user', content: 'Alex: My favorite color is blue.' },
      { role: 'assistant', content: 'Blair: I will remember that.' },
    ],
  );
  assert.ok(conversation.sessions[0].messages.every(message => Number.isFinite(message.timestamp)));
  assert.equal(
    conversation.sessions[0].messages[0].timestamp,
    Date.parse('2024-01-01T00:00:00Z'),
  );
  assert.deepEqual(conversation.sessions[0].messages[0].metadata, {
    locomo: {
      sessionDateTime: '1 January 2024',
      speaker: 'Alex',
      diaId: 'D1:1',
    },
  });
  assert.equal(conversation.qa[1].answer, undefined);
  assert.deepEqual(conversation.qa[0].evidence, ['D1:1']);
});

test('category-5 grading recognizes abstentions without accepting guesses', () => {
  assert.equal(isAbstention("I don't know."), true);
  assert.equal(isAbstention('That is not mentioned in the conversation.'), true);
  assert.equal(isAbstention('The available context cannot determine the answer.'), true);
  assert.equal(isAbstention('Alex prefers dogs.'), false);
});

test('LoCoMo sampling is deterministic and balanced by conversation and category', (t) => {
  let conversations;
  try {
    conversations = loadLocomo();
  } catch (err) {
    // 外部資料集不隨 repo 散布(授權),clean checkout / CI 上不存在時跳過
    if (err?.code === 'ENOENT') return t.skip('locomo10.json not present (external dataset, not tracked)');
    throw err;
  }
  const first = sampleLocomo(conversations, 20, 7);
  const repeated = sampleLocomo(conversations, 20, 7);
  const differentSeed = sampleLocomo(conversations, 20, 8);

  assert.deepEqual(first, repeated);
  assert.equal(first.reduce((sum, conversation) => sum + conversation.qa.length, 0), 20);
  assert.ok(first.every(conversation => conversation.qa.length === 2));
  assert.notDeepEqual(
    first.flatMap(conversation => conversation.qa.map(qa => qa.sourceIndex)),
    differentSeed.flatMap(conversation => conversation.qa.map(qa => qa.sourceIndex)),
  );

  const categoryCounts = new Map();
  for (const qa of first.flatMap(conversation => conversation.qa)) {
    categoryCounts.set(qa.category, (categoryCounts.get(qa.category) ?? 0) + 1);
  }
  const counts = [...categoryCounts.values()];
  assert.equal(categoryCounts.size, 5);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 2);
});

test('entry-id rehydrate reads only files whose sidecar contains the id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otter-idx-'));
  try {
    const indexedPath = path.join(dir, 'locomo-0-s1.jsonl');
    const sourceTimestamp = Date.parse('2023-05-07T00:00:00Z');
    const indexedEntry = {
      entryId: 42,
      user: 'Exact question',
      assistant: 'Exact answer',
      timestamp: sourceTimestamp,
    };
    fs.writeFileSync(indexedPath, `${JSON.stringify(indexedEntry)}\n`);
    fs.writeFileSync(`${indexedPath}.idx`, JSON.stringify({ 42: 0 }));

    const unindexedPath = path.join(dir, 'locomo-0-s2.jsonl');
    fs.writeFileSync(unindexedPath, `${JSON.stringify({
      entryId: 99,
      user: 'Must not be scanned',
      assistant: 'False evidence',
      timestamp: 456,
    })}\n`);

    const rehydrate = createIdxRehydrator(dir, ['locomo-0-s1', 'locomo-0-s2']);
    assert.deepEqual(await rehydrate([42, 99], 8), [indexedEntry]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
