import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryRiver } from '../dist/api.js';
import { parseEntryIds } from '../dist/index.js';
import { resolvePaths } from '../dist/paths.js';

function createRiver(root) {
  return createMemoryRiver({
    dataDir: path.join(root, 'data'),
    ramDir: path.join(root, 'ram'),
    autoRecall: false,
  }, {
    embedder: {
      embed: async () => [0, 0, 0, 0],
      embedBatch: async texts => texts.map(() => [0, 0, 0, 0]),
      getDimensions: () => 4,
      healthCheck: async () => true,
    },
  });
}

test('core rehydrate expands range strings exactly like number arrays', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-ids-range-'));
  const river = createRiver(root);
  const sessionKey = 'range-session';
  const ids = Array.from({ length: 18 }, (_, index) => 336 + index);
  const transcriptsDir = resolvePaths({
    dataDir: path.join(root, 'data'),
    ramDir: path.join(root, 'ram'),
  }).transcriptsDir;
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptsDir, `${sessionKey}.jsonl`), ids.map(entryId => JSON.stringify({
    entryId,
    sessionId: sessionKey,
    user: `user ${entryId}`,
    assistant: `assistant ${entryId}`,
    timestamp: entryId,
  })).join('\n') + '\n');

  try {
    const fromRange = await river.rehydrate({ mode: 'entry_ids', sessionKey, entryIds: '336-353', bleed: 0 });
    const fromArray = await river.rehydrate({ mode: 'entry_ids', sessionKey, entryIds: ids, bleed: 0 });
    const fromMultipleRanges = await river.rehydrate({ mode: 'entry_ids', sessionKey, entryIds: '336-340,348-353', bleed: 0 });

    assert.deepEqual(fromRange, fromArray);
    assert.deepEqual(fromMultipleRanges.map(entry => entry.entryId), [336, 337, 338, 339, 340, 348, 349, 350, 351, 352, 353]);

    for (const entryIds of ['', 'abc', '5-3']) {
      await assert.doesNotReject(async () => {
        const entries = await river.rehydrate({ mode: 'entry_ids', sessionKey, entryIds, bleed: 0 });
        assert.deepEqual(entries, []);
      });
    }
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  }
});

test('parseEntryIds is exported with the existing range parsing behavior', () => {
  assert.deepEqual(parseEntryIds('336-340,348-353'), [
    336, 337, 338, 339, 340, 348, 349, 350, 351, 352, 353,
  ]);
  for (const value of ['', 'abc', '5-3']) {
    assert.deepEqual(parseEntryIds(value), []);
  }
});
