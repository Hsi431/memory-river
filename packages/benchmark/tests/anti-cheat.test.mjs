import assert from 'node:assert/strict';
import test from 'node:test';

import * as otter from '../dist/agent/otter.js';
import * as coverageAb from '../dist/harness/locomo-coverage-ab.js';
import * as crossEncoder from '../dist/harness/cross-encoder-reranker.js';
import * as deliveredContext from '../dist/harness/locomo-delivered-context.js';

const markers = ['GOLD_ANSWER_SECRET', 'GOLD_EVIDENCE_SECRET', 'GOLD_CATEGORY_SECRET'];

function fakeAnswerer(requests) {
  return async request => {
    requests.push(request.messages);
    return {
      message: { role: 'assistant', content: 'MOCK_ANSWER' },
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  };
}

test('Otter answer prompt contains only the question and retrieved context', async () => {
  const requests = [];
  const result = await otter.runOtter({
    llm: { apiKey: 'fake', model: 'fake' },
    river: { assembleContext: async () => ({ messages: [] }) },
    question: 'QUESTION_TEXT',
    sessionKeys: [],
    conversationKey: 'conv-test',
    rehydrateById: async () => [],
    complete: fakeAnswerer(requests),
  });
  const prompt = JSON.stringify(requests);

  assert.equal(result.answer, 'MOCK_ANSWER');
  assert.ok(prompt.includes('QUESTION_TEXT'));
  assert.ok(markers.every(marker => !prompt.includes(marker)));
});

test('fixed-context answer prompt contains no gold answer, evidence, or category', async () => {
  const requests = [];
  const result = await coverageAb.answerWithFixedContext({
    apiKey: 'fake',
    model: 'fake',
    context: 'MEMORY_TEXT',
    question: 'QUESTION_TEXT',
    complete: fakeAnswerer(requests),
  });
  const prompt = JSON.stringify(requests);

  assert.equal(result.answer, 'MOCK_ANSWER');
  assert.ok(prompt.includes('QUESTION_TEXT'));
  assert.ok(prompt.includes('MEMORY_TEXT'));
  assert.ok(markers.every(marker => !prompt.includes(marker)));
});

test('reranker receives only question and memory text, never gold metadata', async () => {
  assert.equal(typeof crossEncoder.scoreRerankPool, 'function');
  const received = [];
  const result = await crossEncoder.scoreRerankPool({
    async scorePairs(pairs) {
      received.push(...pairs);
      return { logits: [0.8], timing: { pairs: 1, batches: 1, timedMs: 1, perPairMs: 1 } };
    },
  }, 'QUESTION_TEXT', [{
    entry: {
      text: 'MEMORY_TEXT',
      metadata: {
        goldAnswer: markers[0],
        evidence: markers[1],
        category: markers[2],
      },
    },
  }]);

  assert.deepEqual(received, [{ query: 'QUESTION_TEXT', passage: 'MEMORY_TEXT' }]);
  assert.ok(markers.every(marker => !JSON.stringify(received).includes(marker)));
  assert.deepEqual(result.logits, [0.8]);
});

test('diagnostic dump writer waits for both answer and grade', async () => {
  assert.equal(typeof deliveredContext.writeDiagnosticDumpAfterScoring, 'function');
  const events = [];
  let resolveAnswer;
  let resolveGrade;
  let writtenLine;
  const answer = new Promise(resolve => {
    resolveAnswer = () => {
      events.push('answer');
      resolve({ answer: 'ANSWER_TEXT' });
    };
  });
  const grade = new Promise(resolve => {
    resolveGrade = () => {
      events.push('grade');
      resolve({ correct: true, parseFailure: false });
    };
  });

  const writing = deliveredContext.writeDiagnosticDumpAfterScoring(
    answer,
    grade,
    (result, score) => ({ answer: result.answer, correct: score.correct }),
    line => {
      events.push('dump');
      writtenLine = line;
    },
  );
  assert.deepEqual(events, []);
  resolveAnswer();
  await Promise.resolve();
  assert.deepEqual(events, ['answer']);
  resolveGrade();
  await writing;

  assert.deepEqual(events, ['answer', 'grade', 'dump']);
  assert.deepEqual(JSON.parse(writtenLine), { answer: 'ANSWER_TEXT', correct: true });
});
