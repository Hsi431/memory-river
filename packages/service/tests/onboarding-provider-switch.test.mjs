import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  defaultOnboardingConfig,
  writeOnboardingConfig,
} from '@memory-river/adapter-mcp';
import { runInit } from '../dist/index.js';

async function initializeWithEmbedding(t, existingEmbedding, answer) {
  const root = await mkdtemp(path.join(tmpdir(), 'mr-init-provider-'));
  const configPath = path.join(root, 'config.json');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  writeOnboardingConfig({
    ...defaultOnboardingConfig(),
    dataDir: path.join(root, 'data'),
    embedding: existingEmbedding,
  }, configPath);
  const answers = [answer, '', ''];
  return runInit({
    configPath,
    prompt: async () => answers.shift() ?? '',
    write: () => {},
  });
}

test('switching embedding provider resets stale model dimensions, API key, and endpoint', async t => {
  const config = await initializeWithEmbedding(t, {
    provider: 'openai',
    model: 'old-model',
    baseUrl: 'https://old-embedder.test/v1',
    apiKey: 'old-api-key',
    dimensions: 3072,
  }, 'ollama new-model');

  assert.deepEqual(config.embedding, {
    provider: 'ollama',
    model: 'new-model',
    baseUrl: 'http://localhost:11434',
    dimensions: 1024,
  });
});

test('switching embedding model clears the old model-specific API key and dimensions', async t => {
  const config = await initializeWithEmbedding(t, {
    provider: 'openai',
    model: 'old-model',
    baseUrl: 'https://embedder.test/v1',
    apiKey: 'old-api-key',
    dimensions: 3072,
  }, 'openai https://embedder.test/v1 new-model');

  assert.equal(config.embedding.provider, 'openai');
  assert.equal(config.embedding.model, 'new-model');
  assert.equal(config.embedding.dimensions, defaultOnboardingConfig().embedding.dimensions);
  assert.equal(Object.hasOwn(config.embedding, 'apiKey'), false);
});

test('changing the OpenAI embedding endpoint clears the old API key', async t => {
  const config = await initializeWithEmbedding(t, {
    provider: 'openai',
    model: 'same-model',
    baseUrl: 'https://old-embedder.test/v1',
    apiKey: 'old-api-key',
    dimensions: 3072,
  }, 'openai https://new-embedder.test/v1 same-model');

  assert.equal(config.embedding.baseUrl, 'https://new-embedder.test/v1');
  assert.equal(Object.hasOwn(config.embedding, 'apiKey'), false);
});

test('switching Ollama models keeps the custom endpoint', async t => {
  const config = await initializeWithEmbedding(t, {
    provider: 'ollama',
    model: 'old-model',
    baseUrl: 'http://ollama.internal:11434',
    dimensions: 1024,
  }, 'ollama new-model');

  assert.equal(config.embedding.model, 'new-model');
  assert.equal(config.embedding.baseUrl, 'http://ollama.internal:11434');
});
