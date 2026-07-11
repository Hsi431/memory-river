import assert from 'node:assert/strict';
import test from 'node:test';

import { configFromEnv } from '../dist/config.js';

test('configured LLM request timeout aborts an endpoint that never responds', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = process.env.MEMORY_RIVER_LLM_TIMEOUT_MS;
  const originalBaseUrl = process.env.MEMORY_RIVER_LLM_BASE_URL;
  const originalModel = process.env.MEMORY_RIVER_LLM_MODEL;
  process.env.MEMORY_RIVER_LLM_TIMEOUT_MS = '20';
  process.env.MEMORY_RIVER_LLM_BASE_URL = 'http://never-responds.test';
  process.env.MEMORY_RIVER_LLM_MODEL = 'test-model';
  const keepAlive = setInterval(() => {}, 1000);
  globalThis.fetch = async (_url, init) => await new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  try {
    await assert.rejects(configFromEnv().llm.generate('timeout test'));
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.MEMORY_RIVER_LLM_TIMEOUT_MS; else process.env.MEMORY_RIVER_LLM_TIMEOUT_MS = originalTimeout;
    if (originalBaseUrl === undefined) delete process.env.MEMORY_RIVER_LLM_BASE_URL; else process.env.MEMORY_RIVER_LLM_BASE_URL = originalBaseUrl;
    if (originalModel === undefined) delete process.env.MEMORY_RIVER_LLM_MODEL; else process.env.MEMORY_RIVER_LLM_MODEL = originalModel;
  }
});
