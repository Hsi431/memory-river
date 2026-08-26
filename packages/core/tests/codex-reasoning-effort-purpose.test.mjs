import assert from 'node:assert/strict';
import test from 'node:test';

import { ConcentratorAdapter } from '../dist/distill/concentrator-adapter.js';

function makeAdapter(overrides = {}) {
  return new ConcentratorAdapter({
    apiKey: '',
    model: 'gemini-test-model',
    inboxPath: '/tmp/memory-river-codex-reasoning-effort-test-inbox',
    transcriptArchive: {},
    sessionSummaryDir: '/tmp/memory-river-codex-reasoning-effort-test-summaries',
    codexModel: 'gpt-test-model',
    codexReasoningEffort: 'medium',
    codexWorkdir: '/tmp/codex-workdir',
    codexTimeoutMs: 4567,
    ...overrides,
  });
}

test('buildCodexOptions uses the purpose-specific reasoning effort', () => {
  const adapter = makeAdapter({
    codexReasoningEffortByPurpose: { 'night-consolidation': 'high' },
  });

  assert.deepEqual(adapter.buildCodexOptions('night-consolidation'), {
    model: 'gpt-test-model',
    reasoningEffort: 'high',
    workdir: '/tmp/codex-workdir',
    timeoutMs: 4567,
  });
});

test('buildCodexOptions falls back to the shared effort for another purpose', () => {
  const adapter = makeAdapter({
    codexReasoningEffortByPurpose: { 'night-consolidation': 'high' },
  });

  assert.equal(adapter.buildCodexOptions('concentrate').reasoningEffort, 'medium');
});

test('buildCodexOptions uses the shared effort when no purpose map is configured', () => {
  const adapter = makeAdapter({ codexReasoningEffort: 'low' });

  assert.equal(adapter.buildCodexOptions('night-consolidation').reasoningEffort, 'low');
  assert.equal(adapter.buildCodexOptions('concentrate').reasoningEffort, 'low');
});
