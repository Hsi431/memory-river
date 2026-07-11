import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryRiver } from '../dist/api.js';

function deterministicVector(text) {
  const vector = [0, 0, 0, 0];
  for (let i = 0; i < text.length; i++) vector[i % vector.length] += text.charCodeAt(i) / 1000;
  return vector;
}

test('createMemoryRiver exposes the public API and round-trips one memory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-api-'));
  const river = createMemoryRiver({
    dataDir: path.join(root, 'data'),
    ramDir: path.join(root, 'ram'),
    autoRecall: false,
  }, {
    embedder: {
      embed: async text => deterministicVector(text),
      embedBatch: async texts => texts.map(deterministicVector),
      getDimensions: () => 4,
      healthCheck: async () => true,
    },
    llm: {
      generate: async () => JSON.stringify({ capsule: 'mock', notes: [] }),
    },
  });

  try {
    for (const method of [
      'start',
      'stop',
      'remember',
      'updateMemory',
      'setMemoryStatus',
      'recall',
      'enumerate',
      'rehydrate',
      'assembleContext',
      'archiveTranscript',
      'compactSessionFile',
    ]) {
      assert.equal(typeof river[method], 'function', `${method} should be a function`);
    }
    for (const method of ['on', 'off', 'status', 'update']) {
      assert.equal(typeof river.gwm[method], 'function', `gwm.${method} should be a function`);
    }
    for (const method of ['runCleanup', 'runNightConsolidation']) {
      assert.equal(typeof river.maintenance[method], 'function', `maintenance.${method} should be a function`);
    }

    await river.start();
    await river.remember('T8b API round trip memory', { category: 'fact', importance: 0.9 });
    const results = await river.recall('T8b API round trip memory', 5);
    assert.ok(results.some(result => result.entry.text === 'T8b API round trip memory'));
  } finally {
    await river.stop();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  }
});
