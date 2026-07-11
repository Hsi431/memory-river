import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyGoldAtoms,
  goldAtomFirstOffset,
} from '../../harness/locomo-delivered-context.js';

// ─── goldAtomFirstOffset ──────────────────────────────────────────────────────

test('goldAtomFirstOffset returns 0 when atom is at start of context', () => {
  const context = 'pottery and swimming';
  assert.equal(goldAtomFirstOffset(context, 'pottery'), 0);
});

test('goldAtomFirstOffset returns mid-string offset when atom is not at start', () => {
  const context = 'hello world pottery today';
  const offset = goldAtomFirstOffset(context, 'pottery');
  // "hello world " is 12 chars
  assert.equal(offset, 12);
});

test('goldAtomFirstOffset returns -1 when atom is absent', () => {
  const context = 'hello world today';
  assert.equal(goldAtomFirstOffset(context, 'pottery'), -1);
});

test('goldAtomFirstOffset respects word boundaries (no substring match inside word)', () => {
  const context = 'potterymatch is here';
  // "pottery" should NOT match inside "potterymatch"
  assert.equal(goldAtomFirstOffset(context, 'pottery'), -1);
});

// ─── classifyGoldAtoms ────────────────────────────────────────────────────────

test('classifyGoldAtoms: early+used → present_used with decile < 4', () => {
  // atom "pottery" at offset 0 in a 100-char context → decile 0
  const context = 'pottery' + ' '.repeat(93);
  const answer = 'she likes pottery and swimming';
  const result = classifyGoldAtoms({
    atoms: ['pottery'],
    contextNormalized: context,
    answerNormalized: answer,
  });
  assert.equal(result.atomBucketCounts.present_used, 1);
  assert.equal(result.atomBucketCounts.present_unused_early, 0);
  assert.equal(result.atomBucketCounts.present_unused_late, 0);
  assert.equal(result.atomBucketCounts.absent, 0);
  assert.equal(result.goldAtomsPresent, 1);
  assert.equal(result.goldAtomsPresentAndUsed, 1);
  assert.equal(result.goldAtomsPresentNotUsed, 0);
  assert.equal(result.utilizationRate, 1);
  // decile 0 → hist[0] === 1
  assert.equal(result.goldAtomPositionDecileHist[0], 1);
  assert.notEqual(result.meanGoldAtomDecile, null);
  assert.equal(result.meanGoldAtomDecile, 0);
});

test('classifyGoldAtoms: early+present-unused → present_unused_early', () => {
  // atom "pottery" at offset 0 → decile 0; NOT in answer
  const context = 'pottery' + ' '.repeat(93);
  const answer = 'she likes swimming and camping';
  const result = classifyGoldAtoms({
    atoms: ['pottery'],
    contextNormalized: context,
    answerNormalized: answer,
  });
  assert.equal(result.atomBucketCounts.present_used, 0);
  assert.equal(result.atomBucketCounts.present_unused_early, 1);
  assert.equal(result.atomBucketCounts.present_unused_late, 0);
  assert.equal(result.atomBucketCounts.absent, 0);
  assert.equal(result.goldAtomsPresent, 1);
  assert.equal(result.goldAtomsPresentAndUsed, 0);
  assert.equal(result.goldAtomsPresentNotUsed, 1);
  assert.equal(result.utilizationRate, 0);
});

test('classifyGoldAtoms: late+present-unused → present_unused_late', () => {
  // Build a 100-char context where "pottery" starts at offset 50 → decile 5 (≥ 4)
  const context = 'x'.repeat(50) + ' pottery ' + 'x'.repeat(41);
  const answer = 'she likes swimming';
  const result = classifyGoldAtoms({
    atoms: ['pottery'],
    contextNormalized: context,
    answerNormalized: answer,
  });
  assert.equal(result.atomBucketCounts.present_used, 0);
  assert.equal(result.atomBucketCounts.present_unused_early, 0);
  assert.equal(result.atomBucketCounts.present_unused_late, 1);
  assert.equal(result.atomBucketCounts.absent, 0);
  assert.equal(result.goldAtomsPresent, 1);
  assert.equal(result.goldAtomsPresentNotUsed, 1);
  // decile should be ≥ 4
  const decile = result.buckets[0].decile ?? -1;
  assert.ok(decile >= 4, `expected decile >= 4, got ${decile}`);
});

test('classifyGoldAtoms: absent atom → absent bucket', () => {
  const context = 'nothing relevant here at all and more text to fill space';
  const answer = 'some answer text';
  const result = classifyGoldAtoms({
    atoms: ['pottery'],
    contextNormalized: context,
    answerNormalized: answer,
  });
  assert.equal(result.atomBucketCounts.absent, 1);
  assert.equal(result.atomBucketCounts.present_used, 0);
  assert.equal(result.atomBucketCounts.present_unused_early, 0);
  assert.equal(result.atomBucketCounts.present_unused_late, 0);
  assert.equal(result.goldAtomsPresent, 0);
  assert.equal(result.utilizationRate, null);
  assert.equal(result.meanGoldAtomDecile, null);
});

test('classifyGoldAtoms: four-atom cross-tab with all four buckets', () => {
  // Construct a 200-char context so deciles are easy to reason about.
  // Position 0:   "pottery"    → offset 0   → decile 0 (early) — also in answer → present_used
  // Position 20:  "swimming"   → offset 20  → decile 1 (early) — NOT in answer  → present_unused_early
  // Position 120: "camping"    → offset 120 → decile 6 (late)  — NOT in answer  → present_unused_late
  // "pottery" matches → offset 0 in 200 → decile 0
  // "swimming" matches → offset 20 in 200 → decile 1
  // "camping" at offset 120 → decile 6
  // "archery" is absent
  const context =
    'pottery xxxxxxxxxx swimming ' + // 0..27
    'x'.repeat(92) +                  // 28..119
    ' camping ' +                     // 120..128
    'x'.repeat(71);                   // 129..199
  // total length = 200
  assert.equal(context.length, 200);

  const answer = 'she likes pottery and archery';
  const result = classifyGoldAtoms({
    atoms: ['pottery', 'swimming', 'camping', 'archery'],
    contextNormalized: context,
    answerNormalized: answer,
  });

  assert.equal(result.atomBucketCounts.present_used, 1,      'pottery should be present_used');
  assert.equal(result.atomBucketCounts.present_unused_early, 1, 'swimming should be present_unused_early');
  assert.equal(result.atomBucketCounts.present_unused_late, 1,  'camping should be present_unused_late');
  assert.equal(result.atomBucketCounts.absent, 1,            'archery should be absent');

  assert.equal(result.goldAtomsPresent, 3);
  assert.equal(result.goldAtomsPresentAndUsed, 1);
  assert.equal(result.goldAtomsPresentNotUsed, 2);
  assert.ok(Math.abs((result.utilizationRate ?? 0) - 1 / 3) < 1e-9);

  // Position deciles:
  //   pottery  → offset 0   in 200-char context → decile floor(0/200*10)  = 0
  //   swimming → offset 19  in 200-char context → decile floor(19/200*10) = floor(0.95) = 0
  //   camping  → offset 121 in 200-char context → decile floor(121/200*10) = floor(6.05) = 6
  // So hist[0]=2, hist[6]=1, all others=0
  assert.equal(result.goldAtomPositionDecileHist[0], 2);
  assert.equal(result.goldAtomPositionDecileHist[6], 1);
  for (let d = 0; d < 10; d++) {
    if (d !== 0 && d !== 6) {
      assert.equal(result.goldAtomPositionDecileHist[d], 0, `hist[${d}] should be 0`);
    }
  }

  assert.ok(result.meanGoldAtomDecile !== null);
  // mean decile = (0 + 0 + 6) / 3 = 2
  assert.ok(Math.abs((result.meanGoldAtomDecile ?? 0) - 2) < 1e-9);
});

test('classifyGoldAtoms: short and numeric atoms are excluded (isExcludedAtom)', () => {
  // "do" (len=2) and "42" (pure digits) should be skipped → all absent counts stay 0
  const context = 'hello world';
  const answer = 'hello world 42 do';
  const result = classifyGoldAtoms({
    atoms: ['do', '42'],
    contextNormalized: context,
    answerNormalized: answer,
  });
  // Both excluded → zero buckets
  assert.equal(result.goldAtomsPresent, 0);
  assert.equal(result.atomBucketCounts.absent, 0);
  assert.equal(result.atomBucketCounts.present_used, 0);
  assert.equal(result.goldAtomPositionDecileHist.reduce((a, b) => a + b, 0), 0);
  assert.equal(result.meanGoldAtomDecile, null);
  assert.equal(result.utilizationRate, null);
});
