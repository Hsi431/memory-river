import assert from 'node:assert/strict';
import test from 'node:test';

import { runEvidenceBenchmark } from '../dist/dimensions/evidence.js';

test('evidence benchmark resolves and rehydrates every recalled fixture', async () => {
  const result = await runEvidenceBenchmark();
  assert.equal(result.dimension, 'evidence');
  assert.equal(result.metrics.evidence_resolvable_rate, 1);
  assert.equal(result.metrics.rehydrate_hit_rate, 1);
  assert.equal(result.metrics.content_consistency_rate, 1);
});
