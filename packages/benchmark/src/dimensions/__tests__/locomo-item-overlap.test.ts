import assert from 'node:assert/strict';
import test from 'node:test';

import {
  exactSubstringPrepass,
  extractGoldItems,
  scoreLocomoItemOverlap,
  type ItemMatcher,
} from '../locomo-item-overlap.js';

test('extractGoldItems splits comma and semicolon lists', () => {
  assert.deepEqual(extractGoldItems('pottery, camping, painting, swimming'), [
    'pottery',
    'camping',
    'painting',
    'swimming',
  ]);
  assert.deepEqual(extractGoldItems('beach; mountains; forest'), [
    'beach',
    'mountains',
    'forest',
  ]);
});

test('extractGoldItems keeps quoted titles and phrase-internal or together', () => {
  assert.deepEqual(extractGoldItems('"Nothing is Impossible", "Charlotte\'s Web"'), [
    'Nothing is Impossible',
    "Charlotte's Web",
  ]);
  assert.deepEqual(extractGoldItems('counseling or mental health for transgender people'), [
    'counseling or mental health for transgender people',
  ]);
});

test('substring pre-pass uses boundaries and excludes numeric, short, and common-token items', () => {
  assert.equal(exactSubstringPrepass('single', 'She is not singlehandedly doing this.'), false);
  assert.equal(exactSubstringPrepass('single', 'She is single.'), true);
  assert.equal(exactSubstringPrepass('3', 'Melanie has 3 children.'), false);
  assert.equal(exactSubstringPrepass('cup', 'They made a cup.'), false);
  assert.equal(exactSubstringPrepass('the', 'the answer says it'), false);
});

test('scoreLocomoItemOverlap computes recall, precision, and F1 with reproducible extras', async () => {
  const matcher: ItemMatcher = async ({ goldItem, answer }) => ({
    present: answer.toLocaleLowerCase().includes(goldItem.toLocaleLowerCase()),
    span: answer,
    parse_failure: false,
  });
  const result = await scoreLocomoItemOverlap(
    'What does Melanie do to destress?',
    'Running, pottery',
    'running, reading, pottery',
    { matcher },
  );

  assert.deepEqual(result.goldItems, ['Running', 'pottery']);
  assert.deepEqual(result.hitItems, ['Running', 'pottery']);
  assert.deepEqual(result.extras, ['reading']);
  assert.equal(result.itemRecall, 1);
  assert.equal(result.itemPrecision, 2 / 3);
  assert.equal(result.itemF1, 0.8);
});

test('parse failures are isolated as uncertain and counted as neither hit nor miss', async () => {
  const matcher: ItemMatcher = async ({ goldItem }) => {
    if (goldItem === 'pottery') {
      return { present: true, span: '', parse_failure: true };
    }
    return { present: true, span: 'running', parse_failure: false };
  };
  const result = await scoreLocomoItemOverlap(
    'What does Melanie do to destress?',
    'Running, pottery',
    'running',
    { matcher },
  );

  assert.deepEqual(result.hitItems, ['Running']);
  assert.deepEqual(result.uncertainItems, ['pottery']);
  assert.deepEqual(result.matcher_uncertain_items, ['pottery']);
  assert.equal(result.itemRecall, 1);
});
