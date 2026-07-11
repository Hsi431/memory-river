import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  aggregateConfusions,
  cragConfusion,
  scoreFromConfusion,
} from '../dist/harness/crag-metrics.js';

// The full crag dimension needs Ollama + a live store and the MiniLM reranker, so
// it is intentionally not run in CI. These tests cover the deterministic filter-
// metric layer and the integrity of the distractor fixture.

test('cragConfusion partitions kept ids against planted labels', () => {
  // relevant m1 kept, m2 dropped; distractor d1 kept (leaked), d2 dropped.
  const c = cragConfusion(['m1', 'd1', 'x'], ['m1', 'm2'], ['d1', 'd2']);
  assert.deepEqual(c, { tp: 1, fn: 1, fp: 1, tn: 1 });
});

test('cragConfusion ignores unlabeled filler and scores rejection over all distractors', () => {
  // A distractor that never reached the pool still counts as correctly rejected.
  const c = cragConfusion(['m1'], ['m1'], ['d1', 'd2', 'd3']);
  assert.deepEqual(c, { tp: 1, fn: 0, fp: 0, tn: 3 });
});

test('scoreFromConfusion derives recall / rejection / precision / f1', () => {
  const s = scoreFromConfusion({ tp: 1, fn: 1, fp: 1, tn: 1 });
  assert.equal(s.relevantRecall, 0.5);
  assert.equal(s.distractorRejection, 0.5);
  assert.equal(s.precision, 0.5);
  assert.equal(s.f1, 0.5);
});

test('perfect filter scores 1 on every axis; empty output scores 0', () => {
  const perfect = scoreFromConfusion(cragConfusion(['m1', 'm2'], ['m1', 'm2'], ['d1', 'd2']));
  assert.equal(perfect.relevantRecall, 1);
  assert.equal(perfect.distractorRejection, 1);
  assert.equal(perfect.precision, 1);
  assert.equal(perfect.f1, 1);

  const empty = scoreFromConfusion(cragConfusion([], ['m1'], ['d1']));
  assert.equal(empty.relevantRecall, 0);
  assert.equal(empty.distractorRejection, 1); // dropping everything rejects all noise
  assert.equal(empty.precision, 0);
  assert.equal(empty.f1, 0);
});

test('aggregateConfusions micro-averages over the summed counts', () => {
  const a = cragConfusion(['m1'], ['m1', 'm2'], ['d1']); // tp1 fn1 fp0 tn1
  const b = cragConfusion(['m3', 'd2'], ['m3'], ['d2']); // tp1 fn0 fp1 tn0
  const agg = aggregateConfusions([a, b]);
  assert.deepEqual({ tp: agg.tp, fn: agg.fn, fp: agg.fp, tn: agg.tn }, { tp: 2, fn: 1, fp: 1, tn: 1 });
  assert.equal(agg.relevantRecall, 2 / 3);
  assert.equal(agg.distractorRejection, 1 / 2);
  assert.equal(agg.precision, 2 / 3);
});

test('distractor fixture is internally consistent', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const datasetPath = path.join(here, '..', 'datasets', 'fixtures', 'crag-distractor.json');
  const data = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

  const ids = new Set();
  for (const mem of data.memories) {
    assert.ok(mem.id && mem.text, 'memory needs id and text');
    assert.ok(!ids.has(mem.id), `duplicate memory id ${mem.id}`);
    ids.add(mem.id);
  }

  const queryIds = new Set();
  for (const q of data.queries) {
    assert.ok(q.id && q.query && q.kind, 'query needs id, query, kind');
    assert.ok(!queryIds.has(q.id), `duplicate query id ${q.id}`);
    queryIds.add(q.id);
    assert.ok(q.relevantIds.length > 0, `query ${q.id} has no relevant ids`);
    assert.ok(q.distractorIds.length > 0, `query ${q.id} has no distractor ids`);

    const seen = new Set();
    for (const rid of [...q.relevantIds, ...q.distractorIds]) {
      assert.ok(ids.has(rid), `query ${q.id} references unknown memory ${rid}`);
      assert.ok(!seen.has(rid), `query ${q.id} labels ${rid} as both relevant and distractor`);
      seen.add(rid);
    }
  }
});
