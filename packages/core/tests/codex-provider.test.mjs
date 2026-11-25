import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

import {
  ConcentratorAdapter,
  parseCodexOutput,
  runCodexCli,
} from '../dist/distill/concentrator-adapter.js';

const codexConfig = {
  model: 'gpt-5.6-luna',
  reasoningEffort: 'low',
  workdir: path.join(os.tmpdir(), 'memory-river-codex-provider'),
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

test('assembles codex argv and sends the prompt through stdin', async () => {
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
    '-C', codexConfig.workdir,
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '-c', 'model=gpt-5.6-luna',
    '-c', 'model_reasoning_effort=low',
    '-',
  ]);
  assert.equal(observed.stdinEnded, true);
  assert.equal(observed.options.timeout, 120000);
  assert.equal(observed.options.shell, undefined);
});

test('streams a 300 KB prompt to codex stdin without putting it in argv', async () => {
  const prompt = 'x'.repeat(300 * 1024);
  const observed = { prompt: '' };
  const fakeExecFile = (file, args, options, callback) => {
    observed.file = file;
    observed.args = args;
    observed.options = options;
    const stdin = new Writable({
      write(chunk, _encoding, done) {
        observed.prompt += chunk.toString();
        done();
      },
      final(done) {
        callback(null, '{"ok":true}', '');
        done();
      },
    });
    return { kill() { return true; }, stdin };
  };

  assert.equal(await runCodexCli(prompt, codexConfig, fakeExecFile), '{"ok":true}');
  assert.equal(observed.file, 'codex');
  assert.deepEqual(observed.args, [
    'exec',
    '-C', codexConfig.workdir,
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '-c', 'model=gpt-5.6-luna',
    '-c', 'model_reasoning_effort=low',
    '-',
  ]);
  assert.equal(observed.args.includes(prompt), false);
  assert.equal(observed.prompt, prompt);
});

test('converts a codex stdin EPIPE into CodexCliExecutionError without an uncaught error', async () => {
  const fakeExecFile = (_file, _args, _options, callback) => {
    const stdin = new EventEmitter();
    stdin.end = (prompt) => {
      if (prompt) {
        stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      } else {
        setImmediate(() => callback(null, '{"ok":true}', ''));
      }
    };
    return { stdin };
  };

  await assert.rejects(
    runCodexCli('trigger EPIPE', codexConfig, fakeExecFile),
    (error) => error.name === 'CodexCliExecutionError' && /EPIPE/.test(error.message),
  );
});

test('kills codex when the configured timeout expires', async () => {
  let killedWith;
  const fakeExecFile = () => ({
    kill(signal) {
      killedWith = signal;
      return true;
    },
    stdin: { end() {} },
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
