import test from 'node:test';
import assert from 'node:assert/strict';

import { ConflictDetector } from '../dist/cognition/conflict-detector.js';

// M4(REVIEW20260828_MERGED):conflict-detector 的候選選取這條路一直沒有測試,
// 而 0b579a9 同時改了排序與 query 表示法,兩者都會改變它拿到的候選集合。
// 這裡鎖住「拿到候選之後怎麼篩、送幾筆給 LLM」,讓表示法再變時退步看得見。

function makeCandidate(id, category, status = 'active') {
  return {
    entry: { id, text: `text of ${id}`, category, metadata: JSON.stringify({ status }) },
    rawDistance: 0.2,
  };
}

function makeDetector(candidates, judged) {
  const store = {
    hybridVectorSearch: async () => candidates,
    recordSubsystemEffectiveness: async () => {},
  };
  const llm = {
    generate: async (prompt) => {
      judged.push(prompt);
      return 'NO';
    },
  };
  return new ConflictDetector(store, { embed: async () => [0.1, 0.2] }, llm, {
    changeStatus: async () => {},
  });
}

test('conflict detector only judges same-category, non-deprecated, non-self candidates', async () => {
  const judged = [];
  const detector = makeDetector([
    makeCandidate('self', 'preference'),
    makeCandidate('other-category', 'fact'),
    makeCandidate('deprecated-one', 'preference', 'deprecated'),
    makeCandidate('init_seed', 'preference'),
    makeCandidate('keep-me', 'preference'),
  ], judged);

  const result = await detector.detectAndResolve('self', 'text of self', 'preference');

  assert.equal(judged.length, 1, '只有 keep-me 該被送去 LLM 判定');
  assert.ok(judged[0].includes('text of keep-me'));
  assert.equal(result.hasConflict, false);
});

test('conflict detector judges at most the top 3 candidates, in candidate order', async () => {
  const judged = [];
  const detector = makeDetector(
    ['c1', 'c2', 'c3', 'c4', 'c5'].map(id => makeCandidate(id, 'preference')),
    judged,
  );

  await detector.detectAndResolve('new-id', 'new text', 'preference');

  assert.equal(judged.length, 3, '只判前 3 筆');
  assert.ok(judged[0].includes('text of c1'));
  assert.ok(judged[2].includes('text of c3'));
});

test('conflict detector skips categories outside the high-risk set', async () => {
  const judged = [];
  const detector = makeDetector([makeCandidate('c1', 'fact')], judged);

  const result = await detector.detectAndResolve('new-id', 'new text', 'fact');

  assert.equal(result.resolution, 'skip');
  assert.equal(judged.length, 0);
});
