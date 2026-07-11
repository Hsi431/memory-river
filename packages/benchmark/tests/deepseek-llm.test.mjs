import assert from 'node:assert/strict';
import test from 'node:test';

import { deepseekChatCompletion } from '../dist/harness/deepseek-llm.js';

test('deepseekChatCompletion retries a thrown network error', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    if (attempts === 1) {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    }
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'recovered' },
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  t.mock.method(globalThis, 'setTimeout', callback => {
    callback();
    return 0;
  });

  const completion = await deepseekChatCompletion({
    apiKey: 'test-key',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(attempts, 2);
  assert.equal(completion.message.content, 'recovered');
  assert.deepEqual(completion.usage, {
    promptTokens: 12,
    completionTokens: 3,
  });
});
