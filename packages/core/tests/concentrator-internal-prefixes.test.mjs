import test from 'node:test';
import assert from 'node:assert/strict';

import { ConcentratorAdapter } from '../dist/distill/concentrator-adapter.js';

function makeAdapter(options = {}) {
  return new ConcentratorAdapter({
    apiKey: 'test-api-key',
    model: 'test-model',
    inboxPath: '/tmp/concentrator-internal-prefixes-inbox',
    transcriptArchive: {},
    sessionSummaryDir: '/tmp/concentrator-internal-prefixes-summaries',
    ...options,
  });
}

test('configured internal prefix is excluded while normal user and assistant turns remain', async () => {
  const adapter = makeAdapter({ internalMessagePrefixes: ['【自主回合'] });
  let concentrationPrompt = '';
  adapter.callWithFallback = async (prompt) => {
    concentrationPrompt = prompt;
    return JSON.stringify({ capsule: 'test capsule', notes: [], confidence: 0.9 });
  };
  adapter.writeSessionSummary = async () => {};
  adapter.capsuleBridge = { async writeToInbox() { return '/tmp/capsule.txt'; } };

  await adapter.concentrate([
    { role: 'user', content: '  \n【自主回合】隱藏系統 prompt：不要記住這句。' },
    { role: 'user', content: '使用者真正需求：保留這句。' },
    { role: 'assistant', content: '正常回答：也保留這句。' },
  ], false, true);

  assert.equal(concentrationPrompt.includes('隱藏系統 prompt：不要記住這句。'), false);
  assert.equal(concentrationPrompt.includes('使用者真正需求：保留這句。'), true);
  assert.equal(concentrationPrompt.includes('正常回答：也保留這句。'), true);
});

test('fallback concentration input also excludes configured internal prefix', () => {
  const adapter = makeAdapter({ internalMessagePrefixes: ['【前情提要】'] });

  const fallback = adapter.buildFallbackCapsule([
    { role: 'user', content: '\n\t【前情提要】這是已寫回 context 的膠囊。' },
    { role: 'user', content: '正常使用者訊息。' },
    { role: 'assistant', content: '正常 assistant 訊息。' },
  ]);

  assert.equal(fallback.includes('這是已寫回 context 的膠囊。'), false);
  assert.equal(fallback.includes('正常使用者訊息。'), true);
  assert.equal(fallback.includes('正常 assistant 訊息。'), true);
});

test('omitting internal prefixes preserves the empty-prefix behavior', () => {
  const messages = [
    { role: 'user', content: '【自主回合】這句在預設行為中保留。' },
    { role: 'assistant', content: '正常回答。' },
  ];

  const defaultOutput = makeAdapter().buildFallbackCapsule(messages);
  const explicitEmptyOutput = makeAdapter({ internalMessagePrefixes: [] }).buildFallbackCapsule(messages);

  assert.equal(defaultOutput, explicitEmptyOutput);
  assert.equal(defaultOutput.includes('【自主回合】這句在預設行為中保留。'), true);
});

test('capsule inbox payload uses importance 0.3', async () => {
  const adapter = makeAdapter();
  const writes = [];
  adapter.callWithFallback = async () => JSON.stringify({ capsule: 'test capsule', notes: [], confidence: 0.9 });
  adapter.writeSessionSummary = async () => {};
  adapter.capsuleBridge = {
    async writeToInbox(text, opts) {
      writes.push({ text, opts });
      return '/tmp/capsule.txt';
    },
  };

  await adapter.concentrate([{ role: 'user', content: '正常對話。' }], false, true);

  assert.equal(writes.length, 1);
  assert.equal(writes[0].opts.importance, 0.3);
});
