import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DOCTOR_TEXT,
  runDoctor,
  runInit,
} from '../dist/index.js';
import {
  defaultOnboardingConfig,
  readOnboardingConfig,
  writeOnboardingConfig,
} from '@memory-river/adapter-mcp';

test('mr init --yes writes the current configuration without prompts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'memory-river-init-'));
  const configPath = path.join(dir, 'config.json');
  const current = {
    ...defaultOnboardingConfig(),
    dataDir: path.join(dir, 'existing-data'),
    storageMode: 'ssd',
  };
  writeOnboardingConfig(current, configPath);
  try {
    const written = await runInit({
      yes: true,
      configPath,
      prompt: async () => { throw new Error('non-interactive init must not prompt'); },
      write: () => {},
    });
    assert.deepEqual(written, current);
    assert.deepEqual(readOnboardingConfig(configPath), current);
    assert.match(await readFile(configPath, 'utf8'), /"storageMode": "ssd"/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function doctorConfig() {
  return {
    ...defaultOnboardingConfig(),
    dataDir: '/tmp/memory-river-doctor',
    storageMode: 'auto',
    concentration: { provider: 'degraded' },
  };
}

async function runMockDoctor(overrides = {}, config = doctorConfig()) {
  const lines = [];
  const code = await runDoctor({
    deps: {
      readConfig: () => config,
      probeEmbedding: async () => 1024,
      probeLlm: async () => {},
      getShmFreeBytes: () => 1024 * 1024 * 1024,
      checkPort: async () => true,
      checkDataDir: async () => true,
      checkWal: async () => true,
      write: line => lines.push(line),
      ...overrides,
    },
  });
  return { code, lines };
}

test('mr doctor reports each critical failure with a fix hint and exit code 1', async () => {
  const cases = [
    ['embedding', { probeEmbedding: async () => { throw new Error('offline'); } }, doctorConfig(), DOCTOR_TEXT.embedding],
    ['LLM key', { probeLlm: async () => { throw new Error('bad key'); } }, { ...doctorConfig(), concentration: { provider: 'gemini', apiKey: 'test' } }, DOCTOR_TEXT.llm],
    ['/dev/shm', { getShmFreeBytes: () => 0 }, { ...doctorConfig(), storageMode: 'ram' }, DOCTOR_TEXT.shm],
    ['service port', { checkPort: async () => false }, doctorConfig(), DOCTOR_TEXT.port],
    ['data directory', { checkDataDir: async () => false }, doctorConfig(), DOCTOR_TEXT.dataDir],
    ['WAL', { checkWal: async () => false }, doctorConfig(), DOCTOR_TEXT.wal],
  ];
  for (const [name, overrides, config, hint] of cases) {
    const { code, lines } = await runMockDoctor(overrides, config);
    assert.equal(code, 1, name);
    assert.match(lines.find(line => line.startsWith(`✗ ${name}:`)), new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('mr doctor reports a missing config with its fix hint and exit code 1', async () => {
  const lines = [];
  const code = await runDoctor({ deps: { readConfig: () => null, write: line => lines.push(line) } });
  assert.equal(code, 1);
  assert.match(lines[0], /Run "mr init"/);
});

test('mr doctor accepts degraded mode without an LLM key', async () => {
  const { code, lines } = await runMockDoctor();
  assert.equal(code, 0);
  assert.match(lines.find(line => line.startsWith('✓ LLM key:')), /degraded mode selected/);
});
