import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { mmrOrder } from '../dist/retrieval/coverage-selection.js';
import {
  __resetCragCrossEncoderForTests,
  __setCragCrossEncoderScorerForTests,
} from '../dist/retrieval/cross-encoder-gate.js';
import { Retriever } from '../dist/retrieval/retriever-v4.js';

const OLD_ENV = {
  MR_COVERAGE_SELECTION: process.env.MR_COVERAGE_SELECTION,
  MR_COVERAGE_LAMBDA: process.env.MR_COVERAGE_LAMBDA,
  MR_CRAG_CROSS_ENCODER: process.env.MR_CRAG_CROSS_ENCODER,
  ENABLE_CRAG_GATE: process.env.ENABLE_CRAG_GATE,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(OLD_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function candidate(id, text, finalScore, vector) {
  return {
    entry: {
      id,
      text,
      vector,
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

function makeRetrieverWithSurvivors(survivors) {
  const fakeStore = {
    hybridVectorSearch: async () => [],
    recordMemoryRecalls: async () => {},
  };
  const retriever = new Retriever(
    fakeStore,
    { embed: async () => [0, 0] },
    { vectorWeight: 1, bm25Weight: 0, candidatePoolMultiplier: 3 },
    path.join(os.tmpdir(), 'memory-river-reranker-cache'),
  );
  retriever.cragEvaluate = async () => survivors;
  retriever.getCausalChain = async (id) => [
    { entry: survivors.find(result => result.entry.id === id)?.entry, hopFromSeed: 0, origin: 'seed' },
  ];
  return retriever;
}

test.afterEach(() => {
  __resetCragCrossEncoderForTests();
  restoreEnv();
});

test('mmrOrder with lambda=1 degenerates to pure relevance order', () => {
  const order = mmrOrder(
    [0.2, 1.0, 0.7],
    [[1, 0], [0.99, 0.01], [0, 1]],
    1,
  );

  assert.deepEqual(order, [1, 2, 0]);
});

test('mmrOrder ranks an orthogonal lower-relevance vector before redundant near-parallel vector', () => {
  const order = mmrOrder(
    [10, 9.9, 9],
    [[1, 0], [0.999, 0.0447], [0, 1]],
    0.5,
  );

  assert.deepEqual(order, [0, 2, 1]);
});

test('mmrOrder accepts null vectors and returns a complete index array', () => {
  const order = mmrOrder(
    [3, 2, 1],
    [[1, 0], null, [0, 1]],
    0.5,
  );

  assert.equal(order.length, 3);
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2]);
});

test('hybridSearchInternal leaves result order unchanged when coverage selection is unset', async () => {
  delete process.env.MR_COVERAGE_SELECTION;
  process.env.MR_CRAG_CROSS_ENCODER = '1';
  let scoreCalls = 0;
  __setCragCrossEncoderScorerForTests({
    async scorePairs() {
      scoreCalls += 1;
      return { logits: [10, 9.9, 9] };
    },
  });

  const survivors = [
    candidate('a', 'memory A', 3, [1, 0]),
    candidate('b', 'memory B', 2, [0.999, 0.0447]),
    candidate('c', 'memory C', 1, [0, 1]),
  ];
  const retriever = makeRetrieverWithSurvivors(survivors);

  const response = await retriever.hybridSearchWithoutBoost('coverage query', 2);

  assert.deepEqual(response.results.map(result => result.entry.id), ['a', 'b']);
  assert.equal(scoreCalls, 0);
});

test('hybridSearchInternal coverage selection swaps in a diverse survivor when enabled', async () => {
  const survivors = [
    candidate('a', 'memory A', 3, [1, 0]),
    candidate('b', 'memory B', 2, [0.999, 0.0447]),
    candidate('c', 'memory C', 1, [0, 1]),
  ];
  delete process.env.MR_COVERAGE_SELECTION;
  const offRetriever = makeRetrieverWithSurvivors(survivors);
  const offResponse = await offRetriever.hybridSearchWithoutBoost('coverage query', 2);

  process.env.MR_COVERAGE_SELECTION = '1';
  process.env.MR_COVERAGE_LAMBDA = '0.5';
  process.env.MR_CRAG_CROSS_ENCODER = '1';
  const logitsByPassage = new Map([
    ['memory A', 10],
    ['memory B', 9.9],
    ['memory C', 9],
  ]);
  __setCragCrossEncoderScorerForTests({
    async scorePairs(pairs) {
      return { logits: pairs.map(pair => logitsByPassage.get(pair.passage) ?? 0) };
    },
  });

  const onRetriever = makeRetrieverWithSurvivors(survivors);
  const onResponse = await onRetriever.hybridSearchWithoutBoost('coverage query', 2);

  const offIds = offResponse.results.map(result => result.entry.id);
  const onIds = onResponse.results.map(result => result.entry.id);
  assert.deepEqual(offIds, ['a', 'b']);
  assert.deepEqual(onIds, ['a', 'c']);
  assert.notDeepEqual(onIds, offIds);
});
