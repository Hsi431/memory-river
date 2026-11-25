import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryRiverEngine } from '../dist/engine.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

test('engine configures cleanup defaults when cleanupEngine is omitted', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cleanup-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const config = structuredClone(DEFAULT_CONFIG);
  delete config.cleanupEngine;
  config.dbPath = path.join(root, 'ssd');
  config.ramDbPath = path.join(root, 'ram');
  config.inboxPath = path.join(root, 'inbox');
  const deps = {
    paths: {
      rerankerCacheDir: root,
      consolidationLog: path.join(root, 'consolidation.jsonl'),
      stateDir: path.join(root, 'state'),
      walFile: path.join(root, 'wal.jsonl'),
      sessionSummaryDir: path.join(root, 'sessions'),
      trashDir: path.join(root, 'trash'),
      gwmStateFile: path.join(root, 'gwm.json'),
    },
    transcriptArchive: { archiveSnapshot() {}, clearTranscriptCache() {} },
    embedder: { embed: async () => [] },
    deriveSessionFile: () => null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  };
  const engine = new MemoryRiverEngine(config, deps);

  assert.doesNotThrow(() => engine.configure(config, deps));
  assert.deepEqual(engine.cleanupEngineRef.config.coreCategories, [
    'identity', 'preference', 'constraint', 'business', 'decision', 'core_rule',
  ]);
  assert.equal(engine.cleanupEngineRef.config.coreImportanceThreshold, 0.75);
  assert.equal(engine.cleanupEngineRef.config.skillCapsuleProtection, true);
  assert.equal(engine.cleanupEngineRef.config.useTrash, true);
  assert.equal(engine.cleanupEngineRef.config.dryRun, false);
});
