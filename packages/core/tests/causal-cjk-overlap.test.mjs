import assert from 'node:assert/strict';
import test from 'node:test';

import { CausalEngine } from '../dist/cognition/causal-engine.js';

test('Chinese paraphrases with shared character bigrams can qualify for UPDATE', async () => {
  const candidate = {
    entry: {
      id: 'old-memory',
      text: '使用者不喜歡吃香菜',
      category: 'preference',
    },
    rawDistance: 0.1,
  };
  const engine = new CausalEngine(
    { vectorSearch: async () => [candidate] },
    { embed: async () => [1, 0] },
    { updateThreshold: 0.28, causalThreshold: 0.32, overlapThreshold: 0.3 },
  );

  const result = await engine.determineRelation('使用者不喜歡香菜', undefined, 'decision');

  assert.equal(result.action, 'UPDATE');
  assert.equal(result.parentId, 'old-memory');
});
