import test from 'node:test';
import assert from 'node:assert/strict';

import { ConflictDetector } from '../dist/cognition/conflict-detector.js';

// M4(REVIEW20260828_MERGED):conflict-detector 的候選選取這條路一直沒有測試,
// 而 0b579a9 同時改了排序與 query 表示法,兩者都會改變它拿到的候選集合。
// 這裡鎖住「拿到候選之後怎麼篩、送幾筆給 LLM」,讓表示法再變時退步看得見。

function makeCandidate(id, category, status = 'active', slotSubject, slotCardinality, metadataOverride) {
  return {
    entry: {
      id,
      text: `text of ${id}`,
      category,
      metadata: metadataOverride ?? JSON.stringify({
        status,
        ...(slotSubject === undefined ? {} : { slotSubject }),
        ...(slotCardinality === undefined ? {} : { slotCardinality }),
      }),
    },
    rawDistance: 0.2,
  };
}

function makeDetector(candidates, judged, newSubject = null, answer = 'NO', statusChanges = [], newCardinality = null, options = {}) {
  const store = {
    hybridVectorSearch: async () => candidates,
    getById: async () => {
      if (options.getByIdError) throw new Error('getById failed');
      return options.newMetadata ?? {
        metadata: JSON.stringify({ slotSubject: newSubject, slotCardinality: newCardinality }),
      };
    },
    recordSubsystemEffectiveness: async () => {},
  };
  const llm = {
    generate: async (prompt) => {
      judged.push(prompt);
      return answer;
    },
  };
  return new ConflictDetector(store, { embed: async () => [0.1, 0.2] }, llm, {
    changeStatus: async change => {
      statusChanges.push(change);
      return { ok: true };
    },
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

test('conflict detector excludes candidates with a different slot subject before judging', async () => {
  const judged = [];
  const statusChanges = [];
  const detector = makeDetector(
    [makeCandidate('john-memory', 'preference', 'active', 'John')],
    judged,
    'James',
    '衝突',
    statusChanges,
  );

  const result = await detector.detectAndResolve('james-memory', 'James favorite game', 'preference');

  assert.equal(judged.length, 0);
  assert.equal(statusChanges.length, 0);
  assert.equal(result.resolution, 'no_candidates');
});

test('conflict detector suppresses a candidate with the same slot subject', async () => {
  const judged = [];
  const statusChanges = [];
  const detector = makeDetector(
    [makeCandidate('james-old', 'preference', 'active', ' james ')],
    judged,
    'JAMES',
    '衝突',
    statusChanges,
  );

  const result = await detector.detectAndResolve('james-new', 'James favorite game', 'preference');

  assert.equal(judged.length, 1);
  assert.equal(statusChanges.length, 1);
  assert.equal(statusChanges[0].memoryId, 'james-old');
  assert.equal(statusChanges[0].reason, 'conflict_detected');
  assert.equal(result.hasConflict, true);
});

test('conflict detector preserves null-subject conflict behavior', async () => {
  const judged = [];
  const statusChanges = [];
  const detector = makeDetector(
    [makeCandidate('unknown-old', 'preference', 'active', null)],
    judged,
    null,
    '衝突',
    statusChanges,
  );

  const result = await detector.detectAndResolve('unknown-new', 'favorite game', 'preference');

  assert.equal(judged.length, 1);
  assert.equal(statusChanges.length, 1);
  assert.equal(statusChanges[0].memoryId, 'unknown-old');
  assert.equal(result.hasConflict, true);
});

test('conflict detector excludes a subjectless candidate for a new subject', async () => {
  const judged = [];
  const statusChanges = [];
  const detector = makeDetector(
    [makeCandidate('unknown-old', 'preference')],
    judged,
    'James',
    '衝突',
    statusChanges,
  );

  const result = await detector.detectAndResolve('james-new', 'James favorite game', 'preference');

  assert.equal(judged.length, 0);
  assert.equal(statusChanges.length, 0);
  assert.equal(result.resolution, 'no_candidates');
});

test('conflict detector does not judge a same-subject multi cardinality new memory', async () => {
  const judged = [];
  const statusChanges = [];
  const detector = makeDetector(
    [makeCandidate('james-old', 'preference', 'active', 'James', 'single')],
    judged,
    'James',
    '衝突',
    statusChanges,
    'multi',
  );

  const result = await detector.detectAndResolve('james-new', 'James visited country', 'preference');

  assert.equal(judged.length, 0);
  assert.equal(statusChanges.length, 0);
  assert.equal(result.resolution, 'no_candidates');
});

test('conflict detector does not judge a same-subject multi cardinality candidate', async () => {
  const judged = [];
  const statusChanges = [];
  const detector = makeDetector(
    [makeCandidate('james-old', 'preference', 'active', 'James', 'multi')],
    judged,
    'James',
    '衝突',
    statusChanges,
    'single',
  );

  const result = await detector.detectAndResolve('james-new', 'James favorite game', 'preference');

  assert.equal(judged.length, 0);
  assert.equal(statusChanges.length, 0);
  assert.equal(result.resolution, 'no_candidates');
});

test('conflict detector judges and suppresses same-subject single cardinality memories', async () => {
  const judged = [];
  const statusChanges = [];
  const detector = makeDetector(
    [makeCandidate('james-old', 'preference', 'active', 'James', 'single')],
    judged,
    'James',
    '衝突',
    statusChanges,
    'single',
  );

  const result = await detector.detectAndResolve('james-new', 'James favorite game', 'preference');

  assert.equal(judged.length, 1);
  assert.equal(statusChanges.length, 1);
  assert.equal(statusChanges[0].memoryId, 'james-old');
  assert.equal(result.hasConflict, true);
});

test('conflict detector excludes candidates with malformed metadata', async () => {
  const judged = [];
  const detector = makeDetector([
    makeCandidate('bad-metadata', 'preference', 'active', 'James', 'single', '{bad'),
    makeCandidate('good-candidate', 'preference', 'active', 'James', 'single'),
  ], judged, 'James');

  const result = await detector.detectAndResolve('james-new', 'James favorite game', 'preference');

  assert.equal(judged.length, 1);
  assert.ok(judged[0].includes('text of good-candidate'));
  assert.equal(result.resolution, 'no_conflict');
});

test('conflict detector returns no candidates when new metadata is malformed', async () => {
  const judged = [];
  const statusChanges = [];
  const detector = makeDetector([
    makeCandidate('james-old', 'preference', 'active', 'James', 'single'),
  ], judged, 'James', '衝突', statusChanges, 'single', {
    newMetadata: { metadata: '{bad' },
  });

  const result = await detector.detectAndResolve('james-new', 'James favorite game', 'preference');

  assert.deepEqual(result, { hasConflict: false, conflictingIds: [], resolution: 'no_candidates' });
  assert.equal(judged.length, 0);
  assert.equal(statusChanges.length, 0);
});

test('conflict detector returns no candidates when getById throws', async () => {
  const judged = [];
  const statusChanges = [];
  const detector = makeDetector([
    makeCandidate('james-old', 'preference', 'active', 'James', 'single'),
  ], judged, 'James', '衝突', statusChanges, 'single', { getByIdError: true });

  const result = await detector.detectAndResolve('james-new', 'James favorite game', 'preference');

  assert.deepEqual(result, { hasConflict: false, conflictingIds: [], resolution: 'no_candidates' });
  assert.equal(judged.length, 0);
  assert.equal(statusChanges.length, 0);
});
