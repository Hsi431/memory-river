import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemoryRiver } from '../dist/api.js';

const ENV_KEYS = [
  'MR_CROSS_ENCODER_RERANK',
  'MR_CRAG_CROSS_ENCODER',
  'ENABLE_CRAG_GATE',
  'MR_OTTER_READONLY',
];
const OLD_ENV = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = OLD_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeEmbedder() {
  function vectorFor(text) {
    const suffix = /candidate ([A-I])$/.exec(text)?.[1];
    const offset = suffix ? suffix.charCodeAt(0) - 'A'.charCodeAt(0) : 0;
    const angle = offset * 0.08;
    return [Math.cos(angle), Math.sin(angle), 0, 0];
  }
  return {
    embed: async text => vectorFor(text),
    embedBatch: async texts => texts.map(vectorFor),
    getDimensions: () => 4,
  };
}

async function withRiver({ reranker, retrieval = {}, logger }, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-rerank-'));
  const river = createMemoryRiver({
    dataDir: path.join(root, 'data'),
    ramDir: path.join(root, 'ram'),
    autoRecall: false,
    retrieval: {
      candidatePoolMultiplier: 1,
      ...retrieval,
      reranker,
    },
  }, {
    embedder: makeEmbedder(),
    llm: { generate: async () => JSON.stringify({ capsule: 'mock', notes: [] }) },
    logger,
  });

  try {
    await river.start();
    for (const suffix of 'ABCDEFGHI'.split('')) {
      await river.remember(`rerank fixture query candidate ${suffix}`, {
        category: 'fact',
        importance: 0.5,
      });
    }
    return await fn(river);
  } finally {
    await river.stop();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  }
}

test.beforeEach(() => {
  process.env.MR_CRAG_CROSS_ENCODER = '0';
  process.env.ENABLE_CRAG_GATE = '0';
  process.env.MR_OTTER_READONLY = '1';
  delete process.env.MR_CROSS_ENCODER_RERANK;
});

test.afterEach(restoreEnv);

test('rerank disabled preserves search order and emits no rerank log', async () => {
  const info = [];
  const warnings = [];
  let calls = 0;
  const reranker = {
    async rerank(_query, candidates) {
      calls += 1;
      return candidates.slice().reverse();
    },
  };
  const logger = {
    info: message => info.push(String(message)),
    warn: message => warnings.push(String(message)),
    error: () => {},
  };

  await withRiver({ reranker, logger }, async river => {
    const first = await river.searchMemory('rerank fixture query', 3);
    const second = await river.searchMemory('rerank fixture query', 3);

    assert.deepEqual(
      second.map(result => result.entry.id),
      first.map(result => result.entry.id),
    );
    assert.equal(calls, 0);
    assert.equal(info.some(message => message.includes('cross-encoder rerank')), false);
    assert.equal(warnings.some(message => message.includes('cross-encoder rerank')), false);
  });
});

test('enabled rerank reverses product recall and searchMemory order with overfetch', async () => {
  const info = [];
  const seenCandidates = [];
  const reranker = {
    async rerank(_query, candidates) {
      seenCandidates.push(candidates.map(result => result.entry.id));
      return candidates.slice().reverse();
    },
  };
  const logger = {
    info: message => info.push(String(message)),
    warn: () => {},
    error: () => {},
  };

  await withRiver({ reranker, logger }, async river => {
    await river.searchMemory('rerank fixture query', 3);
    await river.recall('rerank fixture query', 3);

    process.env.MR_CROSS_ENCODER_RERANK = '1';
    const onSearch = await river.searchMemory('rerank fixture query', 3);
    const onRecall = await river.recall('rerank fixture query', 3);

    assert.deepEqual(
      onSearch.map(result => result.entry.id),
      seenCandidates[0].slice().reverse().slice(0, 3),
    );
    assert.deepEqual(
      onRecall.map(result => result.entry.id),
      seenCandidates[1].slice().reverse().slice(0, 3),
    );
    assert.deepEqual(seenCandidates.map(candidates => candidates.length), [9, 9]);
    assert.equal(info.filter(message => message.includes('cross-encoder rerank')).length, 2);
    assert.ok(info.every(message => /candidates=9 returned=3 rerankMs=\d+ top3Changed=true/.test(message)));
  });
});

test('rerank failure warns and returns the original product order', async () => {
  const info = [];
  const warnings = [];
  let failureCandidates = [];
  const reranker = {
    async rerank(_query, candidates) {
      failureCandidates = candidates.map(result => result.entry.id);
      throw new Error('synthetic reranker failure');
    },
  };
  const logger = {
    info: message => info.push(String(message)),
    warn: message => warnings.push(String(message)),
    error: () => {},
  };

  await withRiver({
    reranker,
    retrieval: { rerank: { enabled: true, overfetch: 3 } },
    logger,
  }, async river => {
    process.env.MR_CROSS_ENCODER_RERANK = '0';
    await river.searchMemory('rerank fixture query', 3);
    delete process.env.MR_CROSS_ENCODER_RERANK;
    const recovered = await river.searchMemory('rerank fixture query', 3);

    assert.deepEqual(
      recovered.map(result => result.entry.id),
      failureCandidates.slice(0, 3),
    );
    assert.equal(info.some(message => message.includes('cross-encoder rerank')), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cross-encoder rerank warning/);
    assert.match(warnings[0], /returning original order/);
  });
});
