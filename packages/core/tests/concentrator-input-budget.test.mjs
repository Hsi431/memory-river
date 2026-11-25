import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ConcentratorAdapter,
  estimatePromptTokens,
  MAX_DISTILLATION_INPUT_TOKENS,
} from '../dist/distill/concentrator-adapter.js';

test('concentrator sends oversized conversation content in multiple requests', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mr-concentrator-budget-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const prompts = [];
  const adapter = new ConcentratorAdapter({
    apiKey: '',
    model: 'unused-model',
    provider: 'codex',
    inboxPath: path.join(root, 'inbox'),
    transcriptArchive: {},
    sessionSummaryDir: path.join(root, 'session-summaries'),
    llm: {
      async generate(prompt) {
        prompts.push(prompt);
        return JSON.stringify({ capsule: `segment ${prompts.length}`, notes: [], confidence: 0.9 });
      },
    },
  });
  adapter.capsuleBridge = { async writeToInbox() { return path.join(root, 'capsule.json'); } };
  adapter.writeSessionSummary = async () => {};
  const marker = '🧬';
  const messages = Array.from({ length: 800 }, (_, index) => {
    let content = `Preserve complete conversation item ${index}; exact value ${index}. `;
    let detail = 0;
    while (content.length < 2400) {
      content += `Record ${index}-${detail} links the named archive to river ${detail} with its original numeric value. `;
      detail++;
    }
    content = `${content.slice(0, 2380)} item-end-${index} ${marker}`;
    return { role: 'user', content };
  });

  await adapter.concentrate(messages, false, true, { exhaustive: true });

  assert.ok(prompts.length > 1, 'oversized conversation should be sent in bounded segments');
  assert.ok(prompts.every(prompt => estimatePromptTokens(prompt) <= MAX_DISTILLATION_INPUT_TOKENS));
  const countMarker = text => text.split(marker).length - 1;
  assert.equal(prompts.reduce((sum, prompt) => sum + countMarker(prompt), 0), messages.reduce((sum, message) => sum + countMarker(message.content), 0));
  for (let index = 0; index < messages.length; index++) {
    assert.ok(prompts.some(prompt => prompt.includes(`item-end-${index}`)), `message ${index} content must be preserved`);
  }
});
