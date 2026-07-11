import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyAtomWaterfall } from '../../harness/locomo-cat1-waterfall.js';

// Helper: build normalised text containing a specific atom.
function textWith(atom: string): string {
  return atom.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

// Helper: empty normalised text (atom absent).
const EMPTY = '';

// ── store_missing ─────────────────────────────────────────────────────────────

test('classifyAtomWaterfall: atom not in store → store_missing', () => {
  const results = classifyAtomWaterfall({
    atoms: ['pottery'],
    storeText: 'some unrelated content about bicycles',
    recall50Text: EMPTY,
    recall100Text: EMPTY,
    injectedText: EMPTY,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].classification, 'store_missing');
  assert.equal(results[0].inStore, false);
  assert.equal(results[0].inRecall50, false);
  assert.equal(results[0].inRecall100, false);
  assert.equal(results[0].inAutoRecall, false);
});

// ── retrieval_missing ─────────────────────────────────────────────────────────

test('classifyAtomWaterfall: atom in store but not recall@50 → retrieval_missing', () => {
  const results = classifyAtomWaterfall({
    atoms: ['pottery'],
    storeText: textWith('pottery'),
    recall50Text: 'swimming camping hiking',
    recall100Text: 'swimming camping hiking',
    injectedText: EMPTY,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].classification, 'retrieval_missing');
  assert.equal(results[0].inStore, true);
  assert.equal(results[0].inRecall50, false);
  assert.equal(results[0].inRecall100, false);
  assert.equal(results[0].inAutoRecall, false);
});

// ── selection_missing ─────────────────────────────────────────────────────────

test('classifyAtomWaterfall: atom in recall@50 but not in autoRecall → selection_missing', () => {
  const results = classifyAtomWaterfall({
    atoms: ['pottery'],
    storeText: textWith('pottery'),
    recall50Text: textWith('pottery'),
    recall100Text: textWith('pottery'),
    injectedText: 'swimming and camping',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].classification, 'selection_missing');
  assert.equal(results[0].inStore, true);
  assert.equal(results[0].inRecall50, true);
  assert.equal(results[0].inRecall100, true);
  assert.equal(results[0].inAutoRecall, false);
});

// ── delivered ─────────────────────────────────────────────────────────────────

test('classifyAtomWaterfall: atom in autoRecall → delivered', () => {
  const results = classifyAtomWaterfall({
    atoms: ['pottery'],
    storeText: textWith('pottery'),
    recall50Text: textWith('pottery'),
    recall100Text: textWith('pottery'),
    injectedText: textWith('pottery'),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].classification, 'delivered');
  assert.equal(results[0].inStore, true);
  assert.equal(results[0].inRecall50, true);
  assert.equal(results[0].inRecall100, true);
  assert.equal(results[0].inAutoRecall, true);
});

// ── recall@100 additional hit field ──────────────────────────────────────────

test('classifyAtomWaterfall: atom in recall@100 but not @50 → retrieval_missing + inRecall100=true', () => {
  // Classification gate is recall@50: not in @50 → retrieval_missing.
  // But inRecall100 should still be true (useful extra signal).
  const results = classifyAtomWaterfall({
    atoms: ['pottery'],
    storeText: textWith('pottery'),
    recall50Text: 'unrelated text about bicycles',
    recall100Text: textWith('pottery'),
    injectedText: EMPTY,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].classification, 'retrieval_missing');
  assert.equal(results[0].inStore, true);
  assert.equal(results[0].inRecall50, false);
  assert.equal(results[0].inRecall100, true);   // in @100 even though @50 missed it
  assert.equal(results[0].inAutoRecall, false);
});

// ── excluded atoms ────────────────────────────────────────────────────────────

test('classifyAtomWaterfall: short (≤3) and numeric atoms are excluded', () => {
  const results = classifyAtomWaterfall({
    atoms: ['do', '42', 'hi'],
    storeText: 'do 42 hi something else',
    recall50Text: 'do 42 hi',
    recall100Text: 'do 42 hi',
    injectedText: 'do 42 hi',
  });
  // All three atoms excluded → empty results
  assert.equal(results.length, 0);
});

// ── multi-atom mixed classes ──────────────────────────────────────────────────

test('classifyAtomWaterfall: four atoms covering all four classes', () => {
  // "archery"  → store present, recall50 present, autoRecall present → delivered
  // "pottery"  → store present, recall50 present, autoRecall absent  → selection_missing
  // "swimming" → store present, recall50 absent, recall100 absent    → retrieval_missing
  // "camping"  → store absent                                        → store_missing
  const archery = 'archery';
  const pottery = 'pottery';
  const swimming = 'swimming';

  const results = classifyAtomWaterfall({
    atoms: ['archery', 'pottery', 'swimming', 'camping'],
    storeText: `${archery} ${pottery} ${swimming} unrelated`,
    recall50Text: `${archery} ${pottery} unrelated`,
    recall100Text: `${archery} ${pottery} unrelated`,
    injectedText: `${archery} unrelated`,
  });

  assert.equal(results.length, 4);

  const byAtom = Object.fromEntries(results.map(r => [r.atom, r]));

  assert.equal(byAtom.archery.classification, 'delivered');
  assert.equal(byAtom.pottery.classification, 'selection_missing');
  assert.equal(byAtom.swimming.classification, 'retrieval_missing');
  assert.equal(byAtom.camping.classification, 'store_missing');
});
