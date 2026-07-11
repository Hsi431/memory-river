import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemoryRiver } from '../dist/index.js';
import { ConcentratorAdapter } from '../dist/distill/concentrator-adapter.js';
import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';

async function bestEffortRm(target, options) {
  try {
    await rm(target, options);
  } catch (error) {
    console.warn(`[test-teardown] best-effort rm failed for ${target}:`, error?.code ?? error);
  }
}

class MockEmbedder {
  getDimensions() { return 8; }
  async embed(text) {
    const vector = new Array(8).fill(0);
    vector[String(text).length % vector.length] = 1;
    return vector;
  }
  async embedBatch(texts) { return Promise.all(texts.map(text => this.embed(text))); }
}

test('zero LLM keys keep transcript archiving, store, and recall available', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'memory-river-no-llm-'));
  const river = createMemoryRiver(
    { dataDir, ramDir: path.join(dataDir, 'ram'), storageMode: 'ssd' },
    { embedder: new MockEmbedder() },
  );
  try {
    await river.start();
    await river.remember('zero-key degraded memory amber-719');
    const recalled = await river.recall('amber-719');
    assert.match(JSON.stringify(recalled), /amber-719/);

    await river.archiveTranscript(
      { sessionKey: 'zero-key-session', sessionId: 'zero-key-session' },
      [{ role: 'user', content: 'archive this raw transcript' }, { role: 'assistant', content: 'archived' }],
    );
    const transcript = await readFile(path.join(dataDir, 'transcripts', 'zero-key-session.jsonl'), 'utf8');
    assert.match(transcript, /archive this raw transcript/);
  } finally {
    await river.stop().catch(() => {});
    await bestEffortRm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('zero LLM keys skip concentration without attempting a provider call', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'memory-river-no-llm-concentration-'));
  try {
    const adapter = new ConcentratorAdapter({
      apiKey: '',
      model: 'unused',
      inboxPath: path.join(dataDir, 'inbox'),
      transcriptArchive: createTranscriptArchive(path.join(dataDir, 'transcripts')),
      sessionSummaryDir: path.join(dataDir, 'summaries'),
    });
    const result = await adapter.concentrate([{ role: 'user', content: 'keep this raw' }], false, true);
    assert.equal(result.wasConcentrated, false);
    assert.equal(result.messages[0].content, 'keep this raw');
  } finally {
    await bestEffortRm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
