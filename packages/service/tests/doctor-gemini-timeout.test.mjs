import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  defaultOnboardingConfig,
  writeOnboardingConfig,
} from '@memory-river/adapter-mcp';
import { runDoctor } from '../dist/index.js';

test('doctor keeps Gemini keys out of URLs and gives each fetch an abort timeout', async () => {
  const previousConfig = process.env.MEMORY_RIVER_CONFIG;
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const timeouts = [];
  const calls = [];
  const root = await mkdtemp(path.join(tmpdir(), 'mr-doctor-gemini-'));
  const configPath = path.join(root, 'config.json');
  try {
    writeOnboardingConfig({
      ...defaultOnboardingConfig(),
      dataDir: path.join(root, 'data'),
      storageMode: 'ssd',
      embedding: {
        provider: 'openai',
        model: 'embed-model',
        baseUrl: 'https://embedder.test/v1',
        apiKey: 'embedding-key',
        dimensions: 1024,
      },
      concentration: {
        provider: 'gemini',
        model: 'gemini-test-model',
        apiKey: 'gemini-secret-key',
        baseUrl: 'https://generativelanguage.test/v1beta',
      },
    }, configPath);
    process.env.MEMORY_RIVER_CONFIG = configPath;
    AbortSignal.timeout = milliseconds => {
      timeouts.push(milliseconds);
      return originalTimeout.call(AbortSignal, milliseconds);
    };
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/embeddings')) {
        return { ok: true, json: async () => ({ data: [{ embedding: [0, 1, 2] }] }) };
      }
      return { ok: true };
    };

    const code = await runDoctor({
      configPath,
      deps: {
        getShmFreeBytes: () => 1024 * 1024 * 1024,
        checkPort: async () => true,
        checkDataDir: async () => true,
        checkWal: async () => true,
        write: () => {},
      },
    });

    assert.equal(code, 0);
    assert.equal(calls.length, 2);
    assert.equal(timeouts.length, 2);
    assert.ok(timeouts.every(milliseconds => milliseconds > 0));
    assert.ok(calls.every(call => call.init.signal instanceof AbortSignal));
    const gemini = calls.find(call => call.url.includes('generateContent'));
    assert.ok(gemini);
    assert.doesNotMatch(gemini.url, /gemini-secret-key/);
    assert.equal(gemini.init.headers['x-goog-api-key'], 'gemini-secret-key');
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    if (previousConfig === undefined) delete process.env.MEMORY_RIVER_CONFIG;
    else process.env.MEMORY_RIVER_CONFIG = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
});
