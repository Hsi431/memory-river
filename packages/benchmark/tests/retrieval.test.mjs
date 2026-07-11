import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  meanScores,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  scoreQuery,
} from '../dist/harness/retrieval-metrics.js';

// The full retrieval dimension needs Ollama + a live store and is intentionally
// not run in CI. These tests cover the deterministic, pure metric layer and the
// integrity of the synthetic fixture.

test('recallAtK counts relevant ids within the top k', () => {
  const ranked = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(recallAtK(ranked, new Set(['c']), 5), 1);
  assert.equal(recallAtK(ranked, new Set(['c']), 2), 0);
  assert.equal(recallAtK(ranked, new Set(['a', 'x']), 5), 0.5);
  assert.equal(recallAtK(ranked, new Set(), 5), 0);
});

test('reciprocalRank uses the first relevant position', () => {
  assert.equal(reciprocalRank(['a', 'b', 'c'], new Set(['a'])), 1);
  assert.equal(reciprocalRank(['a', 'b', 'c'], new Set(['b'])), 1 / 2);
  assert.equal(reciprocalRank(['a', 'b', 'c'], new Set(['z'])), 0);
});

test('ndcgAtK is 1 for an ideal ranking and discounts late hits', () => {
  assert.equal(ndcgAtK(['a', 'b'], new Set(['a']), 5), 1);
  const late = ndcgAtK(['x', 'y', 'a'], new Set(['a']), 5);
  assert.ok(late > 0 && late < 1);
  // two relevant, both in ideal order -> 1
  assert.equal(ndcgAtK(['a', 'b', 'c'], new Set(['a', 'b']), 5), 1);
});

test('scoreQuery and meanScores aggregate the standard metric set', () => {
  const s1 = scoreQuery(['a', 'b', 'c', 'd', 'e'], new Set(['a']));
  const s2 = scoreQuery(['x', 'a', 'b', 'c', 'd'], new Set(['a']));
  assert.equal(s1['recall@1'], 1);
  assert.equal(s2['recall@1'], 0);
  const mean = meanScores([s1, s2]);
  assert.equal(mean['recall@1'], 0.5);
  assert.equal(mean.mrr, (1 + 1 / 2) / 2);
});

test('synthetic fixture is internally consistent', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const datasetPath = path.join(here, '..', 'datasets', 'fixtures', 'retrieval.json');
  const data = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

  const ids = new Set();
  for (const mem of data.memories) {
    assert.ok(mem.id && mem.text, 'memory needs id and text');
    assert.ok(!ids.has(mem.id), `duplicate memory id ${mem.id}`);
    ids.add(mem.id);
  }

  const queryIds = new Set();
  for (const q of data.queries) {
    assert.ok(q.id && q.query && q.expectedAnswer, 'query needs id, query, expectedAnswer');
    assert.ok(!queryIds.has(q.id), `duplicate query id ${q.id}`);
    queryIds.add(q.id);
    assert.ok(q.relevantIds.length > 0, `query ${q.id} has no relevant ids`);
    for (const rid of q.relevantIds) {
      assert.ok(ids.has(rid), `query ${q.id} references unknown memory ${rid}`);
    }
  }
});
