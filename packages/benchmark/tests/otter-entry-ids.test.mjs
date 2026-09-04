import assert from 'node:assert/strict';
import test from 'node:test';

import { OTTER_TOOLS, runOtter } from '../dist/agent/otter.js';

const ids = Array.from({ length: 18 }, (_, index) => 336 + index);

function rehydrateToolSchema() {
  return OTTER_TOOLS.find(tool => tool.function.name === 'memory_rehydrate')
    .function.parameters.properties.entryIds;
}

async function runRehydrate(entryIds) {
  const originalFetch = globalThis.fetch;
  let completionCount = 0;
  let requestedIds;
  globalThis.fetch = async () => {
    completionCount++;
    if (completionCount % 2 === 1) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: `rehydrate-${completionCount}`,
                  type: 'function',
                  function: {
                    name: 'memory_rehydrate',
                    arguments: JSON.stringify({ mode: 'entry_ids', entryIds, limit: 200 }),
                  },
                }],
              },
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'done' },
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        };
      },
    };
  };

  try {
    const river = {
      async assembleContext() {
        return { messages: [{ role: 'user', content: 'question' }] };
      },
    };
    await runOtter({
      llm: { apiKey: 'test', model: 'mock' },
      river,
      question: 'question',
      sessionKeys: [],
      conversationKey: 'otter-entry-ids-test',
      rehydrateById: async receivedIds => {
        requestedIds = receivedIds;
        return receivedIds.map(entryId => ({
          entryId,
          user: `user ${entryId}`,
          assistant: `assistant ${entryId}`,
          timestamp: entryId,
        }));
      },
    });
    return requestedIds;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('benchmark Otter accepts equivalent range and number-array entryIds', async () => {
  assert.deepEqual(rehydrateToolSchema().anyOf.map(schema => schema.type), ['string', 'array']);

  const fromRange = await runRehydrate('336-353');
  const fromArray = await runRehydrate(ids);
  const fromMultipleRanges = await runRehydrate('336-340,348-353');

  assert.deepEqual(fromRange, fromArray);
  assert.deepEqual(fromMultipleRanges, [
    336, 337, 338, 339, 340, 348, 349, 350, 351, 352, 353,
  ]);
});

test('benchmark Otter treats invalid range strings as empty results without throwing', async () => {
  for (const value of ['', 'abc', '5-3']) {
    let result;
    await assert.doesNotReject(async () => {
      result = await runRehydrate(value);
    });
    assert.deepEqual(result, []);
  }
});
