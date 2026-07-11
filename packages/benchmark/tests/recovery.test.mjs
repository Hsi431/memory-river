import assert from 'node:assert/strict';
import test from 'node:test';

import { runRecoveryBenchmark } from '../dist/dimensions/recovery.js';

test('recovery benchmark reports no loss, phantoms, or divergence', async () => {
  const result = await runRecoveryBenchmark();
  assert.equal(result.dimension, 'recovery');
  assert.equal(result.metrics.no_loss_rate, 1);
  assert.equal(result.metrics.no_phantom_rate, 1);
  assert.equal(result.metrics.checkpoint_monotonic, 1);
  assert.equal(result.metrics.ram_ssd_consistency_rate, 1);
});
