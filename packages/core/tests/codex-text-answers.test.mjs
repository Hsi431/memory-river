import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

import { ConcentratorAdapter, runCodexCli } from '../dist/distill/concentrator-adapter.js';
import { ConflictDetector } from '../dist/cognition/conflict-detector.js';

const codexConfig = {
  model: 'gpt-test-model',
  reasoningEffort: 'low',
  workdir: os.homedir(),
  timeoutMs: 1000,
};

function makeExecFile(response) {
  return (_file, _args, _options, callback) => {
    const result = response();
    callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '');
    return {
      kill() { return true; },
      stdin: { end() {} },
    };
  };
}

function makeAdapter(execFileImpl, name) {
  const root = path.join(os.tmpdir(), `T13-codex-text-${name}`);
  return new ConcentratorAdapter({
    apiKey: '',
    model: 'gemini-test-model',
    provider: 'codex',
    inboxPath: path.join(root, 'inbox'),
    transcriptArchive: {},
    sessionSummaryDir: path.join(root, 'summaries'),
    codexWorkdir: path.join(root, 'workdir'),
    codexTimeoutMs: 1000,
    codexExecFileImpl: execFileImpl,
  });
}

test('runCodexCli returns trimmed stdout for an explicitly plain-text purpose', async () => {
  const fakeExecFile = (_file, _args, _options, callback) => {
    callback(null, '\n衝突\n', '');
    return { stdin: { end() {} } };
  };

  assert.equal(await runCodexCli('只回答衝突或共存', codexConfig, fakeExecFile, true), '衝突');
});

test('conflict-detection returns true when codex answers 衝突', async () => {
  const adapter = makeAdapter(makeExecFile(() => ({ stdout: '{"conflict":true}\n' })), 'conflict-true');
  const detector = new ConflictDetector({}, {}, adapter, {});

  assert.equal(await detector.judgeConflict('新記憶', '舊記憶', 'preference'), true);
});

test('conflict-detection returns false when codex answers 共存', async () => {
  const adapter = makeAdapter(makeExecFile(() => ({ stdout: '{"conflict":false}\n' })), 'conflict-false');
  const detector = new ConflictDetector({}, {}, adapter, {});

  assert.equal(await detector.judgeConflict('新記憶', '舊記憶', 'preference'), false);
});

test('concentrate still rejects codex output without JSON', async () => {
  const adapter = makeAdapter(makeExecFile(() => ({ stdout: '不是 JSON' })), 'strict-json');

  await assert.rejects(adapter.generate('請回 JSON', { purpose: 'concentrate' }), /parseable JSON/);
});

test('five codex format errors do not trip the global breaker', async () => {
  let calls = 0;
  const adapter = makeAdapter(makeExecFile(() => {
    calls += 1;
    return { stdout: calls <= 5 ? '不是 JSON' : '{"conflict":false}' };
  }), 'format-breaker');

  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(adapter.generate('請回 JSON', { purpose: 'concentrate' }), /parseable JSON/);
  }
  assert.equal(await adapter.generate('只回答共存', { purpose: 'conflict-detection' }), '{"conflict":false}');
  assert.equal(calls, 6);
});

test('three nonzero codex exits still open the global breaker', async () => {
  let calls = 0;
  const adapter = makeAdapter(makeExecFile(() => {
    calls += 1;
    const error = Object.assign(new Error('exit 7'), { code: 7 });
    return { error, stderr: 'exit 7' };
  }), 'execution-breaker');

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(adapter.generate('請回 JSON', { purpose: 'concentrate' }), /Codex CLI failed: exit 7/);
  }
  await assert.rejects(adapter.generate('第四次呼叫', { purpose: 'conflict-detection' }));
  assert.equal(calls, 3);
});
