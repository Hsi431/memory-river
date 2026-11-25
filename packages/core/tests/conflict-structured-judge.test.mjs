import test from 'node:test';
import assert from 'node:assert/strict';

import { ConflictDetector } from '../dist/cognition/conflict-detector.js';

function makeDetector(answer) {
  const statuses = [];
  const candidate = {
    entry: {
      id: 'old-preference',
      text: 'old preference memory',
      vector: [0, 0],
      importance: 0.8,
      category: 'preference',
      parentId: null,
      metadata: '{}',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    vectorScore: 0.9,
    rankScore: 0.9,
    rawDistance: 0.1,
    bm25Score: 0,
    fusedScore: 0.9,
  };
  const store = {
    hybridVectorSearch: async () => [candidate],
    getById: async () => ({ metadata: '{}' }),
    recordSubsystemEffectiveness: async () => {},
  };
  const detector = new ConflictDetector(
    store,
    { embed: async () => [0, 0] },
    { generate: async () => answer },
    { changeStatus: async request => { statuses.push(request); return { ok: true }; } },
  );
  return { detector, statuses };
}

test('unstructured negative and coexistence answers never deprecate a memory', async () => {
  for (const answer of ['無衝突', '沒有衝突', '不衝突', '共存', 'NO']) {
    const { detector, statuses } = makeDetector(answer);
    const result = await detector.detectAndResolve(`new-${answer}`, 'new preference', 'preference');

    assert.equal(result.hasConflict, false, `${answer} must be treated as no conflict`);
    assert.deepEqual(statuses, [], `${answer} must not deprecate the old memory`);
  }
});

test('a structured conflict true answer deprecates the old memory', async () => {
  const { detector, statuses } = makeDetector('{"conflict":true}');
  const result = await detector.detectAndResolve('new-structured-conflict', 'new preference', 'preference');

  assert.equal(result.hasConflict, true);
  assert.deepEqual(statuses.map(status => status.memoryId), ['old-preference']);
});
