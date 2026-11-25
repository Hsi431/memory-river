import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  configFromEnv,
  defaultOnboardingConfig,
  writeOnboardingConfig,
} from '@memory-river/adapter-mcp';
import { runDoctor } from '../dist/index.js';

const ENV_NAMES = [
  'MEMORY_RIVER_CONFIG',
  'MEMORY_RIVER_EMBEDDING_MODEL',
  'OLLAMA_EMBEDDING_MODEL',
  'MEMORY_RIVER_OLLAMA_URL',
  'OLLAMA_URL',
  'OLLAMA_BASE_URL',
  'MEMORY_RIVER_STORAGE_MODE',
  'MEMORY_RIVER_DATA_DIR',
  'DATA_DIR',
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

test('mr doctor and service resolve the same embedding environment overrides', async () => {
  const previous = saveEnv();
  const root = await mkdtemp(path.join(tmpdir(), 'mr-doctor-config-'));
  const configPath = path.join(root, 'config.json');
  try {
    for (const name of ENV_NAMES) delete process.env[name];
    writeOnboardingConfig({
      ...defaultOnboardingConfig(),
      dataDir: path.join(root, 'data'),
      embedding: {
        provider: 'ollama',
        model: 'file-model',
        baseUrl: 'http://file-embedder.test:11434',
        dimensions: 1024,
      },
    }, configPath);
    process.env.MEMORY_RIVER_CONFIG = configPath;
    process.env.MEMORY_RIVER_EMBEDDING_MODEL = 'env-model';
    process.env.MEMORY_RIVER_OLLAMA_URL = 'http://env-embedder.test:11434';

    let probedEmbedding;
    const lines = [];
    const code = await runDoctor({
      configPath,
      deps: {
        probeEmbedding: async config => { probedEmbedding = config.embedding; return 1024; },
        getShmFreeBytes: () => 1024 * 1024 * 1024,
        checkPort: async () => true,
        checkDataDir: async () => true,
        checkWal: async () => true,
        write: line => lines.push(line),
      },
    });
    const serviceConfig = configFromEnv();

    assert.equal(code, 0);
    assert.equal(probedEmbedding.model, serviceConfig.embeddingModel);
    assert.equal(probedEmbedding.baseUrl, serviceConfig.ollamaUrl);
    assert.equal(probedEmbedding.provider, serviceConfig.embeddingProvider);
    assert.equal(probedEmbedding.model, 'env-model');
    assert.equal(probedEmbedding.baseUrl, 'http://env-embedder.test:11434');
  } finally {
    restoreEnv(previous);
    await rm(root, { recursive: true, force: true });
  }
});
