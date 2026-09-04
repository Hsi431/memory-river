import assert from 'node:assert/strict';
import test from 'node:test';

import { deepseekChatCompletion, extractContent } from '../dist/harness/deepseek-llm.js';

test('deepseekChatCompletion rejects truncated reasoning instead of returning it as an answer', async t => {
  const reasoning = 'chain-of-thought '.repeat(100);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: 'length',
      message: { role: 'assistant', content: '', reasoning_content: reasoning },
    }],
    usage: { prompt_tokens: 7, completion_tokens: 8192 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  await assert.rejects(
    deepseekChatCompletion({
      apiKey: 'test-key',
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    }),
    error => {
      assert.match(error.message, /finish_reason=length/);
      assert.match(error.message, /completion_tokens=8192/);
      assert.match(error.message, /content_length=0/);
      assert.match(error.message, new RegExp(`reasoning_content_length=${reasoning.length}`));
      return true;
    },
  );
});

test('extractContent only uses reasoning fallback after a normal completion', () => {
  const message = {
    role: 'assistant',
    content: '',
    reasoning_content: '{"capsule":"answer"}',
  };

  assert.equal(extractContent(message, 'stop'), '{"capsule":"answer"}');
  assert.equal(extractContent(message, 'length'), '');
});
