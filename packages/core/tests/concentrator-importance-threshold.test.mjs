import test from 'node:test';
import assert from 'node:assert/strict';

import { passesConcentratorNoteImportanceFilter } from '../dist/distill/concentrator-adapter.js';

test('concentrator note importance filter applies the relaxed fact threshold', () => {
  assert.equal(
    passesConcentratorNoteImportanceFilter({ category: 'fact', importance: 0.25 }),
    true
  );
  assert.equal(
    passesConcentratorNoteImportanceFilter({ category: 'fact', importance: 0.1 }),
    false
  );
  assert.equal(
    passesConcentratorNoteImportanceFilter({ category: 'general', importance: 0.3 }),
    false
  );
});
