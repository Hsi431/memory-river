import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  __resetCragCrossEncoderForTests,
  __setCragCrossEncoderScorerForTests,
  applyCragCrossEncoderGate,
  scoreCandidates,
} from '../dist/retrieval/cross-encoder-gate.js';
import { Retriever } from '../dist/retrieval/retriever-v4.js';

const OLD_ENV = {
  MR_CRAG_CROSS_ENCODER: process.env.MR_CRAG_CROSS_ENCODER,
  ENABLE_CRAG_GATE: process.env.ENABLE_CRAG_GATE,
  MR_CRAG_GATE_TOPK: process.env.MR_CRAG_GATE_TOPK,
  MR_CRAG_GATE_ZH_LOGIT: process.env.MR_CRAG_GATE_ZH_LOGIT,
  MR_CRAG_GATE_EN_LOGIT: process.env.MR_CRAG_GATE_EN_LOGIT,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(OLD_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function enableGate(topK) {
  process.env.MR_CRAG_CROSS_ENCODER = '1';
  delete process.env.ENABLE_CRAG_GATE;
  if (topK === undefined) delete process.env.MR_CRAG_GATE_TOPK;
  else process.env.MR_CRAG_GATE_TOPK = String(topK);
  delete process.env.MR_CRAG_GATE_ZH_LOGIT;
  delete process.env.MR_CRAG_GATE_EN_LOGIT;
}

function candidate(id, text, finalScore) {
  return {
    entry: {
      id,
      text,
      vector: [0, 0, 0, 0],
      importance: 0.5,
      category: 'fact',
      parentId: null,
      metadata: '{}',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    vectorScore: 0,
    rankScore: 0,
    rawDistance: Number.POSITIVE_INFINITY,
    bm25Score: 0,
    fusedScore: finalScore,
    finalScore,
  };
}

test.afterEach(() => {
  __resetCragCrossEncoderForTests();
  restoreEnv();
});

test('scoreCandidates returns injected logits for the top-K shortlist', async () => {
  enableGate(3);
  const logits = [42.5, -99.0, 7.0];
  __setCragCrossEncoderScorerForTests({
    async scorePairs() {
      return { logits };
    },
  });

  const first = candidate('first', 'first english memory', 1);
  const second = candidate('second', 'second english memory', 10);
  const third = candidate('third', 'third english memory', 5);
  const fourth = candidate('fourth', 'fourth english memory', 4);
  const result = await scoreCandidates('english query', [first, second, third, fourth]);

  assert.ok(result);
  assert.equal(result.scored.length, Math.min(3, 4));
  assert.deepEqual(result.scored.map(item => item.candidate.entry.id), ['second', 'third', 'fourth']);
  assert.deepEqual(result.scored.map(item => item.logit), logits);
  assert.equal(Number.isFinite(result.timingMs), true);
  assert.equal(result.timingMs >= 0, true);
});

test('applyCragCrossEncoderGate filters candidates below real language thresholds', async () => {
  enableGate(4);
  __setCragCrossEncoderScorerForTests({
    async scorePairs() {
      return { logits: [3.47, 3.46, -7.0, -7.1] };
    },
  });

  const enKeep = candidate('en-keep', 'english memory at the default threshold', 10);
  const enDrop = candidate('en-drop', 'english memory below the default threshold', 9);
  const zhKeep = candidate('zh-keep', '中文記憶剛好在預設門檻', 8);
  const zhDrop = candidate('zh-drop', '中文記憶低於預設門檻', 7);
  const gated = await applyCragCrossEncoderGate('english query', [enKeep, enDrop, zhKeep, zhDrop]);

  assert.deepEqual(gated.map(item => item.entry.id), ['en-keep', 'zh-keep']);
});

test('cross-encoder gate scores only the configured top-K shortlist', async () => {
  enableGate(2);
  const scoredPassages = [];
  __setCragCrossEncoderScorerForTests({
    async scorePairs(pairs) {
      scoredPassages.push(...pairs.map(pair => pair.passage));
      return { logits: [4.0, 0.0] };
    },
  });

  const lowOutsideShortlist = candidate('low', 'outside shortlist', 1);
  const highPass = candidate('high-pass', 'relevant english memory', 10);
  const highDrop = candidate('high-drop', 'irrelevant english memory', 9);
  const gated = await applyCragCrossEncoderGate('english query', [
    lowOutsideShortlist,
    highPass,
    highDrop,
  ]);

  assert.deepEqual(scoredPassages, ['relevant english memory', 'irrelevant english memory']);
  assert.deepEqual(gated.map(item => item.entry.id), ['low', 'high-pass']);
});

test('cross-encoder gate uses CJK and English thresholds separately', async () => {
  enableGate(2);
  __setCragCrossEncoderScorerForTests({
    async scorePairs() {
      return { logits: [-6.9, 3.0] };
    },
  });

  const zhPass = candidate('zh-pass', '這是一段相關的中文記憶', 10);
  const enDrop = candidate('en-drop', 'related but below the english logit threshold', 9);
  const gated = await applyCragCrossEncoderGate('what should be remembered?', [zhPass, enDrop]);

  assert.deepEqual(gated.map(item => item.entry.id), ['zh-pass']);
});

test('cross-encoder gate keeps candidates with non-finite logits', async () => {
  enableGate(3);
  __setCragCrossEncoderScorerForTests({
    async scorePairs() {
      return { logits: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY] };
    },
  });

  const nanPass = candidate('nan', 'nan scored english memory', 10);
  const infPass = candidate('inf', 'infinite scored english memory', 9);
  const negInfPass = candidate('neg-inf', 'negative infinite scored english memory', 8);
  const gated = await applyCragCrossEncoderGate('english query', [nanPass, infPass, negInfPass]);

  assert.deepEqual(gated.map(item => item.entry.id), ['nan', 'inf', 'neg-inf']);
});

test('disabled cross-encoder gate is pass-through and does not score', async () => {
  // Gate is enabled by default now; disable explicitly with the opt-out value.
  process.env.MR_CRAG_CROSS_ENCODER = '0';
  delete process.env.ENABLE_CRAG_GATE;
  let calls = 0;
  __setCragCrossEncoderScorerForTests({
    async scorePairs() {
      calls += 1;
      throw new Error('disabled gate should not score');
    },
  });

  const candidates = [candidate('a', 'memory A', 1)];
  const gated = await applyCragCrossEncoderGate('query', candidates);

  assert.equal(calls, 0);
  assert.equal(gated, candidates);
});

test('missing cross-encoder model warns and passes candidates through', async () => {
  enableGate(5);
  const missingModelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-crag-model-'));
  const warnings = [];
  const candidates = [candidate('a', 'memory A', 1), candidate('b', 'memory B', 0.5)];

  try {
    const gated = await applyCragCrossEncoderGate('query', candidates, {
      modelDir: missingModelDir,
      cacheDir: missingModelDir,
      logger: { warn: (...args) => warnings.push(args.join(' ')), log: () => {} },
    });

    assert.equal(gated, candidates);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cross-encoder gate unavailable/);
  } finally {
    try {
      fs.rmSync(missingModelDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${missingModelDir}:`, error?.code ?? error);
    }
  }
});

test('Retriever runs legacy CRAG and then applies cross-encoder gate as post-filter', async () => {
  enableGate(5);
  const partialVector = [0.4, Math.sqrt(1 - 0.4 ** 2)];
  const partialA = candidate(
    '33333333-3333-4333-8333-333333333333',
    'Alice met ProjectOrion in Taipei on 2026-06-01. Detail one.',
    0.9,
  );
  const partialB = candidate(
    '44444444-4444-4444-8444-444444444444',
    'Alice discussed ProjectOrion in Taipei on 2026-06-01. Detail two.',
    0.8,
  );
  partialA.entry.vector = partialVector;
  partialB.entry.vector = partialVector;

  const scoredPassages = [];
  __setCragCrossEncoderScorerForTests({
    async scorePairs(pairs) {
      scoredPassages.push(...pairs.map(pair => pair.passage));
      return { logits: pairs.map(() => 0.0) };
    },
  });

  const embedCalls = [];
  const retriever = new Retriever(
    {
      boostHealth: async () => {},
      recordSubsystemEffectiveness: async () => {},
    },
    {
      embed: async (text, mode) => {
        embedCalls.push({ text, mode });
        return [1, 0];
      },
    },
    { vectorWeight: 1, bm25Weight: 0, candidatePoolMultiplier: 2 },
    path.join(os.tmpdir(), 'memory-river-reranker-cache'),
  );

  const gated = await retriever.cragEvaluate('ProjectOrion query', [partialA, partialB], false);

  assert.deepEqual(gated, []);
  assert.deepEqual(embedCalls.map(call => call.mode), ['query', 'store']);
  assert.equal(scoredPassages.length, 1);
  assert.match(scoredPassages[0], /ProjectOrion/);
});

test('Retriever gates causal-chain bypass candidates before final merge', async () => {
  enableGate(5);
  const seed = candidate('11111111-1111-4111-8111-111111111111', 'direct relevant seed', 1);
  const child = candidate('22222222-2222-4222-8222-222222222222', 'causal child should be gated', 0.7);
  child.entry.parentId = seed.entry.id;
  const scoredPassages = [];
  __setCragCrossEncoderScorerForTests({
    async scorePairs(pairs) {
      scoredPassages.push(...pairs.map(pair => pair.passage));
      return { logits: pairs.map(pair => pair.passage === child.entry.text ? 0.0 : 4.0) };
    },
  });

  const memories = [seed.entry, child.entry];
  const fakeStore = {
    hybridVectorSearch: async () => [seed],
    getById: async (id) => memories.find(memory => memory.id === id) ?? null,
    query: async (predicate) => {
      const match = /^[`"]?parentId[`"]? = '([^']+)'$/.exec(predicate);
      if (!match) return [];
      return memories.filter(memory => memory.parentId === match[1]);
    },
    recordMemoryRecalls: async () => {},
  };
  const retriever = new Retriever(
    fakeStore,
    { embed: async () => [1, 0, 0, 0] },
    { vectorWeight: 1, bm25Weight: 0, candidatePoolMultiplier: 2 },
    path.join(os.tmpdir(), 'memory-river-reranker-cache'),
  );

  const response = await retriever.hybridSearchWithoutBoost('english query', 5);

  assert.deepEqual(scoredPassages, ['direct relevant seed', 'causal child should be gated']);
  assert.deepEqual(response.results.map(result => result.entry.id), [seed.entry.id]);
});
