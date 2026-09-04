import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConcentratorAdapter } from '../dist/distill/concentrator-adapter.js';

function makeAdapter(root, writes, summaries) {
  const adapter = new ConcentratorAdapter({
    apiKey: '',
    model: 'unused-gemini-model',
    provider: 'deepseek',
    deepseekApiKey: 'test-deepseek-key',
    deepseekModel: 'deepseek-v4-flash',
    inboxPath: path.join(root, 'inbox'),
    transcriptArchive: {},
    sessionSummaryDir: path.join(root, 'session-summaries'),
    concentrationTarget: 1,
  });
  adapter.capsuleBridge = {
    async writeToInbox(text, opts) {
      writes.push({ text, opts });
      return path.join(root, 'captured.txt');
    },
  };
  adapter.writeSessionSummary = async summary => {
    summaries.push(summary);
  };
  return adapter;
}

async function withAdapter(t, responseBody, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concentrator-deepseek-'));
  const writes = [];
  const summaries = [];
  let requestBody;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  try {
    await fn(makeAdapter(root, writes, summaries), { writes, summaries, get requestBody() { return requestBody; } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const messages = [
  { role: 'user', content: '請整理這段對話。' },
  { role: 'assistant', content: '收到。' },
];

test('truncated DeepSeek reasoning uses fallback without recording an empty success', async t => {
  const reasoning = 'chain-of-thought '.repeat(1700);
  await withAdapter(t, {
    choices: [{
      finish_reason: 'length',
      message: { role: 'assistant', content: '', reasoning_content: reasoning },
    }],
    usage: { completion_tokens: 8192 },
  }, async (adapter, captured) => {
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => {
      warnings.push(args.map(String).join(' '));
    });

    const result = await adapter.concentrate(messages, false, true);

    assert.equal(captured.requestBody.max_tokens, 32768);
    assert.equal(result.wasConcentrated, true);
    assert.ok(result.summary.trim().length > 0);
    assert.equal(captured.writes.length, 1);
    assert.ok(captured.writes[0].text.trim().length > 0);
    assert.equal(captured.summaries.length, 1);
    assert.ok(captured.summaries[0].capsule.trim().length > 0);
    assert.ok(warnings.some(message => message.includes('DeepSeek response truncated: finish_reason=length')));
    assert.ok(warnings.some(message => message.includes(`completion_tokens=8192`)));
    assert.ok(warnings.some(message => message.includes(`content_length=0`)));
    assert.ok(warnings.some(message => message.includes(`reasoning_content_length=${reasoning.length}`)));
  });
});

test('normal DeepSeek completion still falls back to valid reasoning JSON', async t => {
  const reasoning = JSON.stringify({ capsule: 'reasoning capsule', notes: [], confidence: 0.9 });
  await withAdapter(t, {
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content: '', reasoning_content: reasoning },
    }],
    usage: { completion_tokens: 12 },
  }, async (adapter, captured) => {
    const result = await adapter.concentrate(messages, false, true);

    assert.equal(result.wasConcentrated, true);
    assert.equal(result.summary, 'reasoning capsule');
    assert.equal(captured.writes.length, 1);
    assert.equal(captured.writes[0].text, '【前情提要】\nreasoning capsule');
    assert.equal(captured.summaries.length, 1);
  });
});

test('empty parsed concentration output is not recorded as a successful shell', async t => {
  await withAdapter(t, {
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify({ capsule: '', notes: [] }) },
    }],
    usage: { completion_tokens: 5 },
  }, async (adapter, captured) => {
    const result = await adapter.concentrate(messages, false, true);

    assert.equal(result.wasConcentrated, false);
    assert.equal(result.summary, undefined);
    assert.equal(result.processedThroughIndex, 0);
    assert.deepEqual(result.messages, messages);
    assert.deepEqual(captured.writes, []);
    assert.deepEqual(captured.summaries, []);
  });
});
