import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleRecallInject } from '../lib/recall.mjs';

async function bestEffortRm(target, options) {
  try {
    await rm(target, options);
  } catch (error) {
    console.warn(`[test-teardown] best-effort rm failed for ${target}:`, error?.code ?? error);
  }
}

function responseJson(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

test('normal recall injects additionalContext with the service block', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mr-cc-recall-'));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responseJson({
      results: [{ entry: { id: 'entry-1' } }],
      block: '[{"id":"entry-1","text":"stored context"}]',
    });
  };

  try {
    const output = await handleRecallInject({
      session_id: 'session-1',
      prompt: 'please remember this implementation detail',
    }, { fetchImpl, tmpDir });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:4791/recall');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      query: 'please remember this implementation detail',
      limit: 5,
    });
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(output.hookSpecificOutput.additionalContext, /memory-river recall/);
    assert.match(output.hookSpecificOutput.additionalContext, /stored context/);
  } finally {
    await bestEffortRm(tmpDir, { recursive: true, force: true });
  }
});

test('daemon failure returns empty output without throwing', async () => {
  const output = await handleRecallInject({
    session_id: 'session-1',
    prompt: 'please recall something relevant',
  }, {
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  assert.equal(output, null);
});

test('slash commands and short prompts skip recall', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return responseJson({ results: [], block: '[]' });
  };

  assert.equal(await handleRecallInject({
    session_id: 'session-1',
    prompt: '/help memory',
  }, { fetchImpl }), null);
  assert.equal(await handleRecallInject({
    session_id: 'session-1',
    prompt: 'short',
  }, { fetchImpl }), null);
  assert.equal(calls, 0);
});

test('dedupe prevents injecting the same entry twice in one session', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mr-cc-dedupe-'));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return responseJson({
      results: [{ entry: { id: 'entry-1' } }],
      block: '[{"id":"entry-1","text":"only once"}]',
    });
  };

  try {
    const first = await handleRecallInject({
      session_id: 'session-1',
      prompt: 'please recall this once',
    }, { fetchImpl, tmpDir });
    const second = await handleRecallInject({
      session_id: 'session-1',
      prompt: 'please recall this once',
    }, { fetchImpl, tmpDir });

    assert.ok(first);
    assert.equal(second, null);
    assert.equal(calls, 2);
  } finally {
    await bestEffortRm(tmpDir, { recursive: true, force: true });
  }
});
