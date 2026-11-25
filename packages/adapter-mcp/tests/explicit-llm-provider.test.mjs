import assert from 'node:assert/strict';
import test from 'node:test';

import { configFromEnv } from '../dist/config.js';

const ENV_NAMES = [
  'MEMORY_RIVER_LLM_PROVIDER',
  'MEMORY_RIVER_LLM_API_KEY',
  'MEMORY_RIVER_LLM_BASE_URL',
  'MEMORY_RIVER_LLM_MODEL',
  'MEMORY_RIVER_LLM_TIMEOUT_MS',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'MEMORY_RIVER_CONFIG',
];

function saveEnv() {
  return Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
}

function restoreEnv(previous) {
  for (const name of ENV_NAMES) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
}

function clearLlmEnv() {
  for (const name of ENV_NAMES) delete process.env[name];
}

test('OPENAI_API_KEY alone keeps distillation local, explicit provider opt-in enables it', async () => {
  const previous = saveEnv();
  const originalFetch = globalThis.fetch;
  try {
    clearLlmEnv();
    process.env.OPENAI_API_KEY = 'test-openai-key';
    assert.equal(configFromEnv().llm, undefined);

    process.env.MEMORY_RIVER_LLM_PROVIDER = 'openai';
    const config = configFromEnv();
    assert.ok(config.llm);
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url: String(url), init };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'local opt-in confirmed' } }] }),
      };
    };
    assert.equal(await config.llm.generate('test prompt'), 'local opt-in confirmed');
    assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(request.init.headers.authorization, 'Bearer test-openai-key');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(previous);
  }
});
