import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { Retriever } from '../dist/retrieval/retriever-v4.js';

const ID_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';

function makeMemory(id, text, parentId = null) {
  return {
    id,
    text,
    vector: [0, 0, 0, 0],
    importance: 0.5,
    category: 'fact',
    parentId,
    metadata: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeRetriever(memories) {
  const byId = new Map(memories.map(memory => [memory.id, memory]));
  const fakeStore = {
    getById: async (id) => byId.get(id) ?? null,
    query: async (predicate) => {
      const match = /^[`"]?parentId[`"]? = '([^']+)'$/.exec(predicate);
      if (!match) return [];
      const parentId = match[1];
      return memories.filter(memory => memory.parentId === parentId);
    },
    hybridVectorSearch: async () => [],
    recordMemoryRecalls: async () => {},
  };

  return new Retriever(
    fakeStore,
    { embed: async () => [0, 0, 0, 0] },
    { vectorWeight: 1, bm25Weight: 0, candidatePoolMultiplier: 2 },
    path.join(os.tmpdir(), 'memory-river-reranker-cache'),
  );
}

test('getCausalChain returns seed, parent, and child nodes', async () => {
  const memoryA = makeMemory(ID_A, 'seed memory A', ID_B);
  const memoryB = makeMemory(ID_B, 'parent memory B');
  const memoryC = makeMemory(ID_C, 'child memory C', ID_A);
  const retriever = makeRetriever([memoryA, memoryB, memoryC]);

  const chain = await retriever.getCausalChain(ID_A, 2);

  assert.equal(chain.length, 3);
  assert.deepEqual(
    chain.map(node => ({ id: node.entry.id, origin: node.origin })),
    [
      { id: ID_A, origin: 'seed' },
      { id: ID_B, origin: 'parent' },
      { id: ID_C, origin: 'child' },
    ],
  );
});

test('getCausalChain deduplicates cyclic parent references', async () => {
  const memoryA = makeMemory(ID_A, 'cycle memory A', ID_B);
  const memoryB = makeMemory(ID_B, 'cycle memory B', ID_A);
  const retriever = makeRetriever([memoryA, memoryB]);

  const depth = 2;
  const chain = await retriever.getCausalChain(ID_A, depth);
  const ids = chain.map(node => node.entry.id);

  assert.deepEqual(ids, [ID_A, ID_B]);
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(chain.every(node => node.hopFromSeed <= depth));
});

test('hybridSearch retains a high-BM25 FTS-only candidate before pool truncation', async () => {
  const vectorA = makeMemory(ID_A, 'vector result A');
  const vectorB = makeMemory(ID_B, 'vector result B');
  const ftsOnly = makeMemory(ID_C, 'high BM25 result');
  const fakeStore = {
    hybridVectorSearch: async () => [
      { entry: vectorA, vectorScore: 0.9, rankScore: 0.02, rawDistance: 0.1, bm25Score: 0, fusedScore: 0 },
      { entry: vectorB, vectorScore: 0.8, rankScore: 0.015, rawDistance: 0.2, bm25Score: 0, fusedScore: 0 },
      { entry: ftsOnly, vectorScore: 0, rankScore: 0, rawDistance: Number.POSITIVE_INFINITY, bm25Score: 1, fusedScore: 0 },
    ],
    recordMemoryRecalls: async () => {},
  };
  const retriever = new Retriever(
    fakeStore,
    { embed: async () => [0, 0, 0, 0] },
    { vectorWeight: 0.7, bm25Weight: 0.3, candidatePoolMultiplier: 2 },
    path.join(os.tmpdir(), 'memory-river-reranker-cache'),
  );
  retriever.cragEvaluate = async (_query, candidates) => candidates;
  retriever.getCausalChain = async (id) => [
    { entry: [vectorA, vectorB, ftsOnly].find(memory => memory.id === id), hopFromSeed: 0, origin: 'seed' },
  ];

  const response = await retriever.hybridSearchWithoutBoost('high BM25', 1);

  assert.equal(response.results[0].entry.id, ID_C);
});
