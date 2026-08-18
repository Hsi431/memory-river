import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';

import {
  ConcentratorAdapter,
  parseCodexOutput,
  runCodexCli,
} from '../dist/distill/concentrator-adapter.js';

const codexConfig = {
  model: 'gpt-5.6-luna',
  reasoningEffort: 'low',
  workdir: os.homedir(),
  timeoutMs: 120000,
};

test('parses a bare JSON array at the end of codex logs', () => {
  const output = [
    'hook: Stop',
    'hook: Stop Completed',
    'tokens used',
    '14,825',
    '[{"text":"use systemd","category":"knowledge","importance":0.86,"tags":["systemd"]}]',
  ].join('\n');

  assert.deepEqual(parseCodexOutput(output), [
    { text: 'use systemd', category: 'knowledge', importance: 0.86, tags: ['systemd'] },
  ]);
});

test('parses JSON inside a markdown code fence', () => {
  const output = '```json\n[{"text":"fenced","category":"fact"}]\n```';
  assert.deepEqual(parseCodexOutput(output), [{ text: 'fenced', category: 'fact' }]);
});

test('selects the last balanced JSON object despite surrounding noise', () => {
  const output = 'old [1,2]\nlog: continuing\n{"actual":true,"nested":{"value":"ok"}}\ntrailer [not json';
  assert.deepEqual(parseCodexOutput(output), {
    actual: true,
    nested: { value: 'ok' },
  });
});

test('throws when codex stdout contains no parseable JSON', () => {
  assert.throws(() => parseCodexOutput('hook: Stop\nno structured result'), /parseable JSON/);
});

test('assembles codex argv and uses ignored stdin', async () => {
  const observed = {};
  const prompt = 'Preserve `backticks` and punctuation: [x]';
  const fakeExecFile = (file, args, options, callback) => {
    observed.file = file;
    observed.args = args;
    observed.options = options;
    callback(null, 'log\n{"ok":true}\n', '');
    return {
      kill() { return true; },
      stdin: { end() { observed.stdinEnded = true; } },
    };
  };

  const result = await runCodexCli(prompt, codexConfig, fakeExecFile);

  assert.equal(result, '{"ok":true}');
  assert.equal(observed.file, 'codex');
  assert.deepEqual(observed.args, [
    'exec',
    '-C', os.homedir(),
    '-c', 'model=gpt-5.6-luna',
    '-c', 'model_reasoning_effort=low',
    prompt,
  ]);
  // execFile 忽略 stdio 選項,只有主動 end() 掉 stdin,codex 才不會停在等輸入
  assert.equal(observed.stdinEnded, true);
  assert.equal(observed.options.timeout, 120000);
  assert.equal(observed.options.shell, undefined);
});

test('kills codex when the configured timeout expires', async () => {
  let killedWith;
  const fakeExecFile = () => ({
    kill(signal) {
      killedWith = signal;
      return true;
    },
  });

  await assert.rejects(
    runCodexCli('never returns', { ...codexConfig, timeoutMs: 10 }, fakeExecFile),
    /timed out after 10ms/,
  );
  assert.equal(killedWith, 'SIGTERM');
});

test('codex provider is attempted before gemini', async () => {
  const attempted = [];
  const adapter = new ConcentratorAdapter({
    apiKey: 'gemini-test-key',
    model: 'gemini-test-model',
    provider: 'codex',
    inboxPath: '/tmp/memory-river-codex-provider-test-inbox',
    transcriptArchive: { },
    sessionSummaryDir: '/tmp/memory-river-codex-provider-test-summaries',
  });

  adapter.callProvider = async (provider) => {
    attempted.push(provider);
    if (provider === 'codex') throw new Error('codex test failure');
    return '{"capsule":"fallback"}';
  };

  assert.equal(await adapter.generate('test fallback'), '{"capsule":"fallback"}');
  assert.deepEqual(attempted, ['codex', 'gemini']);
});

test('live codex CLI integration', { skip: process.env.MR_CODEX_LIVE_TEST !== '1' }, async () => {
  const startedAt = Date.now();
  const output = await runCodexCli(
    'Return exactly this JSON object and no other text: {"ok":true}',
    codexConfig,
  );
  const elapsedMs = Date.now() - startedAt;
  assert.deepEqual(JSON.parse(output), { ok: true });
  console.log(`[codex-live] exit=0 durationMs=${elapsedMs}`);
});
