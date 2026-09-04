import assert from 'node:assert/strict';
import test from 'node:test';

import { createToolExecutor, TOOL_SCHEMAS } from '../dist/tools.js';

const ids = Array.from({ length: 18 }, (_, index) => 336 + index);

function makeExecutor() {
  const calls = [];
  const river = {
    async rehydrate(request) {
      calls.push(request);
      return request.entryIds.map(entryId => ({ entryId }));
    },
  };
  return { calls, executor: createToolExecutor(river, 'mcp-entry-ids-test') };
}

function entryIds(value) {
  return TOOL_SCHEMAS.memory_rehydrate.parse({
    mode: 'entry_ids',
    entryIds: value,
    bleed: 0,
  });
}

test('MCP rehydrate accepts equivalent range and number-array entryIds', async () => {
  const { calls, executor } = makeExecutor();
  const fromRange = await executor.memory_rehydrate(entryIds('336-353'));
  const fromArray = await executor.memory_rehydrate(entryIds(ids));
  const fromMultipleRanges = await executor.memory_rehydrate(entryIds('336-340,348-353'));

  assert.deepEqual(fromRange, fromArray);
  assert.deepEqual(fromMultipleRanges.map(entry => entry.entryId), [
    336, 337, 338, 339, 340, 348, 349, 350, 351, 352, 353,
  ]);
  assert.deepEqual(calls.map(call => call.entryIds), [ids, ids, [
    336, 337, 338, 339, 340, 348, 349, 350, 351, 352, 353,
  ]]);
});

test('MCP rehydrate treats invalid range strings as empty results without throwing', async () => {
  const { executor } = makeExecutor();
  for (const value of ['', 'abc', '5-3']) {
    let result;
    await assert.doesNotReject(async () => {
      result = await executor.memory_rehydrate(entryIds(value));
    });
    assert.deepEqual(result, []);
  }
});
