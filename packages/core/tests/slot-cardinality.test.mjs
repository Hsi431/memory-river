import assert from 'node:assert/strict';
import test from 'node:test';

import { mayCardinalitySupersede } from '../dist/util/slot-subject.js';

test('mayCardinalitySupersede blocks multi on either side and allows unknown values', () => {
  const cases = [
    ['multi', 'single', false],
    ['single', 'multi', false],
    ['multi', 'multi', false],
    ['single', 'single', true],
    [null, null, true],
    [undefined, undefined, true],
    ['not-a-cardinality', 'single', true],
    [' MULTI ', 'single', false],
  ];

  for (const [newCardinality, oldCardinality, expected] of cases) {
    assert.equal(
      mayCardinalitySupersede(newCardinality, oldCardinality),
      expected,
      `${String(newCardinality)} / ${String(oldCardinality)}`,
    );
  }
});
