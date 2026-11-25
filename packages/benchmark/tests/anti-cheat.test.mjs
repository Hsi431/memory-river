import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import * as coverageAb from '../dist/harness/locomo-coverage-ab.js';
import * as crossEncoder from '../dist/harness/cross-encoder-reranker.js';
import * as deliveredContext from '../dist/harness/locomo-delivered-context.js';
import { gradeLocomoAnswer } from '../dist/dimensions/locomo.js';

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

function fakeDeliveredContextDependencies({
  conversationId = 'fixture-conversation',
  qa,
  fixture = { sampleId: conversationId, items: { '0': [] } },
  complete,
  judgePrompts = [],
} = {}) {
  return {
    deepseekApiKey: () => 'fake-key',
    geminiJudgeAvailable: () => true,
    loadLocomo: () => [{ sampleId: conversationId, sessions: [], qa: [qa] }],
    findSnapshotPath: () => '/tmp/h4-fixture-snapshot',
    createRealMemoryRiver: async () => ({
      river: {
        assembleContext: async () => ({ messages: [] }),
        searchMemory: async () => [],
      },
      dataDir: '/tmp/h4-fixture-snapshot/data',
      cleanup: async () => {},
    }),
    createGeminiJudge: () => ({
      generate: async prompt => {
        judgePrompts.push(prompt);
        return 'YES';
      },
    }),
    loadCat1GoldItems: () => fixture,
    complete,
  };
}

function qaWithGoldMarkers() {
  return {
    question: 'QUESTION_TEXT',
    answer: markers[0],
    evidence: [markers[1]],
    category: markers[2],
  };
}

test('delivered-context harness keeps real QA gold metadata out of the Otter prompt', async () => {
  const requests = [];
  const judgePrompts = [];
  const qa = qaWithGoldMarkers();
  const originalFanout = process.env.MR_CAT1_FANOUT;
  delete process.env.MR_CAT1_FANOUT;
  let result;
  try {
    result = await deliveredContext.runLocomoDeliveredContext({
      snapshotDir: '/tmp/h4-fixtures',
      conversation: 'fixture-conversation',
      category: qa.category,
    }, fakeDeliveredContextDependencies({
      qa,
      complete: fakeAnswerer(requests),
      judgePrompts,
    }));
  } finally {
    if (originalFanout === undefined) delete process.env.MR_CAT1_FANOUT;
    else process.env.MR_CAT1_FANOUT = originalFanout;
  }
  const prompt = JSON.stringify(requests);

  assert.equal(result.metrics.questions, 1);
  assert.ok(prompt.includes('QUESTION_TEXT'));
  assert.ok(markers.every(marker => !prompt.includes(marker)));
  assert.ok(judgePrompts[0].includes(qa.answer));
});

test('fixed-context prompt excludes QA gold while the judge receives the reference answer', async () => {
  const requests = [];
  const judgePrompts = [];
  const qa = qaWithGoldMarkers();
  const result = await coverageAb.answerWithFixedContext({
    apiKey: 'fake',
    model: 'fake',
    context: 'MEMORY_TEXT',
    question: qa.question,
    complete: fakeAnswerer(requests),
  });
  await gradeLocomoAnswer({
    async generate(prompt) {
      judgePrompts.push(prompt);
      return 'YES';
    },
  }, qa, result.answer);
  const prompt = JSON.stringify(requests);

  assert.equal(result.answer, 'MOCK_ANSWER');
  assert.ok(prompt.includes('QUESTION_TEXT'));
  assert.ok(prompt.includes('MEMORY_TEXT'));
  assert.ok(markers.every(marker => !prompt.includes(marker)));
  assert.ok(judgePrompts[0].includes(qa.answer));
});

test('reranker receives only question and memory text, never gold metadata', async () => {
  assert.equal(typeof crossEncoder.scoreRerankPool, 'function');
  const received = [];
  const candidate = {
    entry: {
      text: 'MEMORY_TEXT',
      metadata: {
        goldAnswer: markers[0],
        evidence: markers[1],
        category: markers[2],
      },
    },
  };
  assert.ok(markers.every(marker => JSON.stringify(candidate).includes(marker)));
  const result = await crossEncoder.scoreRerankPool({
    async scorePairs(pairs) {
      received.push(...pairs);
      return { logits: [0.8], timing: { pairs: 1, batches: 1, timedMs: 1, perPairMs: 1 } };
    },
  }, 'QUESTION_TEXT', [candidate]);

  assert.deepEqual(received, [{ query: 'QUESTION_TEXT', passage: 'MEMORY_TEXT' }]);
  assert.ok(markers.every(marker => !JSON.stringify(received).includes(marker)));
  assert.deepEqual(result.logits, [0.8]);
});

test('answerer failure is recorded without an unhandled gradePromise rejection', async () => {
  const moduleUrl = new URL('../dist/harness/locomo-delivered-context.js', import.meta.url).href;
  const script = [
    `import * as deliveredContext from ${JSON.stringify(moduleUrl)};`,
    "delete process.env.MR_CAT1_FANOUT;",
    "const qa = { question: 'QUESTION_TEXT', answer: 'ANSWER_TEXT', evidence: [], category: 1 };",
    'const unhandled = [];',
    "process.on('unhandledRejection', reason => unhandled.push(String(reason?.message ?? reason)));",
    'const dependencies = {',
    "  deepseekApiKey: () => 'fake-key',",
    '  geminiJudgeAvailable: () => true,',
    "  loadLocomo: () => [{ sampleId: 'fixture-conversation', sessions: [], qa: [qa] }],",
    "  findSnapshotPath: () => '/tmp/h4-fixtures',",
    '  createRealMemoryRiver: async () => ({',
    '    river: { assembleContext: async () => ({ messages: [] }), searchMemory: async () => [] },',
    "    dataDir: '/tmp/h4-fixtures/data', cleanup: async () => {},",
    '  }),',
    "  createGeminiJudge: () => ({ generate: async () => 'YES' }),",
    "  loadCat1GoldItems: () => ({ sampleId: 'fixture-conversation', items: { '0': [] } }),",
    "  complete: async () => { throw new Error('FAKE_ANSWERER_FAILURE'); },",
    '};',
    'const outcome = await deliveredContext.runLocomoDeliveredContext({',
    "  snapshotDir: '/tmp/h4-fixtures', conversation: 'fixture-conversation', category: 1,",
    '}, dependencies).then(',
    '  result => ({ warnings: result.warnings }),',
    '  error => ({ error: String(error?.message ?? error) }),',
    ');',
    'await new Promise(resolve => setImmediate(resolve));',
    'process.stdout.write(JSON.stringify({ ...outcome, unhandled }));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.trim(), JSON.stringify({ stderr: child.stderr, error: child.error }));
  const outcome = JSON.parse(child.stdout);
  assert.equal(outcome.error, undefined, 'answerer failures should be recorded for the question');
  assert.ok(outcome.warnings.some(warning => warning.includes('FAKE_ANSWERER_FAILURE')));
  assert.deepEqual(outcome.unhandled, []);
});

test('gold fixture mismatch fails before the answerer is called', async () => {
  const qa = { question: 'QUESTION_TEXT', answer: 'ANSWER_TEXT', evidence: [], category: 1 };
  let answerCalls = 0;
  await assert.rejects(
    deliveredContext.runLocomoDeliveredContext({
      snapshotDir: '/tmp/h4-fixtures',
      conversation: 'fixture-conversation',
      category: 1,
    }, fakeDeliveredContextDependencies({
      qa,
      fixture: { sampleId: 'fixture-other', items: {} },
      complete: async () => {
        answerCalls++;
        return {
          message: { role: 'assistant', content: 'MOCK_ANSWER' },
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    })),
    /fixture-other does not match conversation fixture-conversation/,
  );
  assert.equal(answerCalls, 0);
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
