import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryRiverEngine } from '../dist/engine.js';
import { ConcentratorAdapter } from '../dist/distill/concentrator-adapter.js';
import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function makeEngine({ tokens = 1, concentrate = async messages => ({
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
  engine.activeConcentrator = {
    estimateTokens: () => tokens,
    estimateTokenBreakdown: () => ({ realTokens: tokens, toolTokens: 0, total: tokens }),
    concentrate,
  };
  engine.retrieverRef = {};
  return engine;
}

async function withProbePath(filePath, fn) {
  const previous = process.env.MEMORY_RIVER_COMPACTION_PROBE;
  process.env.MEMORY_RIVER_COMPACTION_PROBE = filePath;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MEMORY_RIVER_COMPACTION_PROBE;
    else process.env.MEMORY_RIVER_COMPACTION_PROBE = previous;
  }
}

function readProbe(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('compaction probe is silent when MEMORY_RIVER_COMPACTION_PROBE is unset', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-probe-off-'));
  const probePath = path.join(root, 'probe.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const previous = process.env.MEMORY_RIVER_COMPACTION_PROBE;
  delete process.env.MEMORY_RIVER_COMPACTION_PROBE;
  try {
    await makeEngine({ tokens: 1 }).assemble([{ role: 'user', content: 'probe off' }], { sessionKey: 'probe-off' });
    assert.equal(fs.existsSync(probePath), false);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_RIVER_COMPACTION_PROBE;
    else process.env.MEMORY_RIVER_COMPACTION_PROBE = previous;
  }
});

test('assemble probe records same-key in-flight concurrency', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-probe-concurrent-'));
  const probePath = path.join(root, 'probe.jsonl');
  const started = deferred();
  const release = deferred();
  let calls = 0;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const engine = makeEngine({
    tokens: 20001,
    concentrate: async messages => {
      calls += 1;
      if (calls === 2) started.resolve();
      await release.promise;
      return { messages, wasConcentrated: false, status: 'skipped' };
    },
  });

  await withProbePath(probePath, async () => {
    const first = engine.assemble([{ role: 'user', content: 'first' }], { sessionKey: 'same-key' });
    const second = engine.assemble([{ role: 'user', content: 'second' }], { sessionKey: 'same-key' });
    await started.promise;
    release.resolve();
    await Promise.all([first, second]);
  });

  const rows = readProbe(probePath).filter(row => row.kind === 'assemble_gate');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.inflightAtEntry).sort((a, b) => a - b), [0, 1]);
  assert.deepEqual(rows.map(row => row.inflightMaxDuring), [2, 2]);
  assert.ok(rows.every(row => row.evalId >= 1));
  assert.ok(rows.some(row => row.assembleWatermarkBeforeWrite !== row.assembleWatermarkAtEntry));
});

test('unwritable probe path does not change assemble result', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-probe-unwritable-'));
  const probePath = path.join(root, 'missing-parent', 'probe.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const expectedMessages = [{ role: 'assistant', content: 'compressed result' }];
  const result = await withProbePath(probePath, () => makeEngine({
    tokens: 20001,
    concentrate: async () => ({ messages: expectedMessages, wasConcentrated: true, status: 'complete' }),
  }).assemble([{ role: 'user', content: 'same behavior' }], { sessionKey: 'unwritable' }));

  assert.deepEqual(result, { messages: expectedMessages });
  assert.equal(fs.existsSync(probePath), false);
});

test('direct force concentration records a concentrate gate', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-probe-concentrate-'));
  const probePath = path.join(root, 'probe.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const adapter = new ConcentratorAdapter({
    apiKey: '',
    model: 'unused',
    inboxPath: path.join(root, 'inbox'),
    transcriptArchive: createTranscriptArchive(path.join(root, 'transcripts')),
    sessionSummaryDir: path.join(root, 'summaries'),
  });

  await withProbePath(probePath, async () => {
    await adapter.concentrate([{ role: 'user', content: 'direct force call' }], false, true);
  });

  const rows = readProbe(probePath).filter(row => row.kind === 'concentrate_gate');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].force, true);
  assert.equal(rows[0].evalId, null);
  assert.ok(rows[0].rawTokens >= rows[0].currentTokens);
});
