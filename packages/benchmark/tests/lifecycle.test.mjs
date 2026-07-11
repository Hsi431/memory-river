import assert from 'node:assert/strict';
import test from 'node:test';

import { runLifecycleBenchmark } from '../dist/dimensions/lifecycle.js';

test('lifecycle benchmark reports mechanism-correct scores', async () => {
  const result = await runLifecycleBenchmark();
  assert.equal(result.dimension, 'lifecycle');
  assert.equal(result.metrics.retention_rate, 1);
  assert.equal(result.metrics.forget_rate, 1);
  assert.equal(result.metrics.supersession_correctness, 1);
  assert.equal(result.metrics.false_eviction_rate, 0);
  assert.ok(result.metrics.skill_vs_normal_survival_ratio >= 2);
});
