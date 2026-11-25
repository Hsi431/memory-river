import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryRiverEngine } from '../dist/engine.js';
import { ConcentratorAdapter } from '../dist/distill/concentrator-adapter.js';
import { DEFAULT_CONFIG } from '../dist/types.js';
import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';

function makeEngine({ tokens = 20001, assembleConcentration = DEFAULT_CONFIG.concentration.assembleConcentration, concentrate = async messages => ({
  messages,
  wasConcentrated: false,
  status: 'skipped',
}) } = {}) {
  const engine = new MemoryRiverEngine({}, {
    paths: {},
    transcriptArchive: {},
    deriveSessionFile: () => null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  });
  engine.activePluginConfig = { concentration: { assembleConcentration } };
  engine.activeConcentrator = {
    estimateTokens: () => tokens,
    estimateTokenBreakdown: () => ({ realTokens: tokens, toolTokens: 0, total: tokens }),
    concentrate,
  };
  engine.retrieverRef = {};
  return engine;
}

function withProbePath(filePath, fn) {
  const previous = process.env.MEMORY_RIVER_COMPACTION_PROBE;
  process.env.MEMORY_RIVER_COMPACTION_PROBE = filePath;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.MEMORY_RIVER_COMPACTION_PROBE;
      else process.env.MEMORY_RIVER_COMPACTION_PROBE = previous;
    });
}

function readProbe(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('DEFAULT_CONFIG keeps assemble concentration enabled and the assemble gate concentrates', async () => {
  assert.equal(DEFAULT_CONFIG.concentration.assembleConcentration, true);
  let calls = 0;
  const compressedMessages = [{ role: 'assistant', content: 'compressed' }];
  const engine = makeEngine({
    concentrate: async () => {
      calls += 1;
      return { messages: compressedMessages, wasConcentrated: true, status: 'complete' };
    },
  });

  const result = await engine.assemble([{ role: 'user', content: 'original' }], { sessionKey: 'flag-default' });

  assert.equal(calls, 1);
  assert.deepEqual(result.messages, compressedMessages);
  assert.equal(engine.sessionTokenWatermark.size, 1);
});

test('assembleConcentration false skips concentration, watermark writes, and message replacement', async () => {
  let calls = 0;
  const originalMessages = [{ role: 'user', content: 'original' }];
  const engine = makeEngine({
    assembleConcentration: false,
    concentrate: async () => {
      calls += 1;
      return { messages: [{ role: 'assistant', content: 'compressed' }], wasConcentrated: true, status: 'complete' };
    },
  });

  const result = await engine.assemble(originalMessages, { sessionKey: 'flag-disabled' });

  assert.equal(calls, 0);
  assert.deepEqual(result.messages, originalMessages);
  assert.equal(engine.sessionTokenWatermark.size, 0);
});

test('assembleConcentration false records a disabled assemble probe decision', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-assemble-flag-'));
  const probePath = path.join(root, 'probe.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withProbePath(probePath, () => makeEngine({ assembleConcentration: false })
    .assemble([{ role: 'user', content: 'probe disabled' }], { sessionKey: 'flag-probe' }));

  const rows = readProbe(probePath).filter(row => row.kind === 'assemble_gate');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'disabled');
  assert.equal(rows[0].watermarkWritten, null);
});

test('direct concentrate remains available when assemble concentration is disabled', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-direct-concentrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let llmCalls = 0;
  const adapter = new ConcentratorAdapter({
    apiKey: '',
    model: 'unused',
    inboxPath: path.join(root, 'inbox'),
    transcriptArchive: createTranscriptArchive(path.join(root, 'transcripts')),
    sessionSummaryDir: path.join(root, 'summaries'),
    llm: {
      async generate() {
        llmCalls += 1;
        return JSON.stringify({ capsule: 'direct summary', notes: [] });
      },
    },
  });

  const engine = makeEngine({ assembleConcentration: false });
  engine.activeConcentrator = adapter;
  const result = await engine.activeConcentrator.concentrate([
    { role: 'user', content: 'direct concentration input' },
    { role: 'assistant', content: 'direct concentration response' },
  ], false, true);

  assert.equal(llmCalls, 1);
  assert.equal(result.wasConcentrated, true);
  assert.equal(result.status, 'complete');
});
