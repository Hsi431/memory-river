import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryRiverEngine } from '../dist/engine.js';
import { ConcentratorAdapter } from '../dist/distill/concentrator-adapter.js';
import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';

function makeMessages(count = 6) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index % 2 === 0 ? 'user' : 'assistant'} turn ${index} ${'context '.repeat(120)}`,
    timestamp: Date.now() + index,
  }));
}

function makeAdapter(root, llm) {
  return new ConcentratorAdapter({
    apiKey: '',
    model: 'unused',
    concentrationTarget: 1,
    inboxPath: path.join(root, 'inbox'),
    transcriptArchive: createTranscriptArchive(path.join(root, 'transcripts')),
    sessionSummaryDir: path.join(root, 'session-summaries'),
    llm,
  });
}

function writeSessionFile(sessionFile, sessionId, messages) {
  const lines = [
    JSON.stringify({ type: 'session', id: sessionId }),
    ...messages.map((message) => JSON.stringify({
      type: 'message',
      timestamp: new Date(message.timestamp).toISOString(),
      message,
    })),
  ];
  fs.writeFileSync(sessionFile, `${lines.join('\n')}\n`, 'utf8');
}

test('concentrate reports degraded fallback and complete LLM output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-failclosed-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const failedAdapter = makeAdapter(root, {
    async generate() {
      throw new Error('test LLM failure');
    },
  });
  const degraded = await failedAdapter.concentrate(makeMessages(), false, true);
  assert.equal(degraded.status, 'degraded');

  const completeAdapter = makeAdapter(root, {
    async generate() {
      return JSON.stringify({ capsule: '正常 LLM capsule', notes: [], confidence: 0.9 });
    },
  });
  const complete = await completeAdapter.concentrate(makeMessages(), false, true);
  assert.equal(complete.status, 'complete');
});

test('compact refuses degraded concentration without changing the session file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-failclosed-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sessionId = 'failclosed-session';
  const sessionFile = path.join(root, 'session.jsonl');
  const messages = makeMessages(40);
  writeSessionFile(sessionFile, sessionId, messages);
  const before = fs.readFileSync(sessionFile);
  const transcriptArchive = createTranscriptArchive(path.join(root, 'transcripts'));
  const engine = new MemoryRiverEngine({}, {
    paths: {},
    transcriptArchive,
    deriveSessionFile: () => null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  });
  engine.activePluginConfig = { concentration: { asyncCompactRaceGuard: false } };
  engine.activeConcentrator = makeAdapter(root, {
    async generate() {
      throw new Error('test LLM failure');
    },
  });

  const result = await engine.compact({
    sessionId,
    sessionKey: sessionId,
    sessionFile,
    force: true,
  });

  assert.deepEqual(result, { ok: true, compacted: false, reason: 'degraded' });
  assert.deepEqual(fs.readFileSync(sessionFile), before);
});
