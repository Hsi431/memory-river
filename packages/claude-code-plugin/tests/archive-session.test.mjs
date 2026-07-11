import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleArchiveSession } from '../lib/archive.mjs';
import { transcriptJsonlToMessages } from '../lib/transcript.mjs';

async function bestEffortRm(target, options) {
  try {
    await rm(target, options);
  } catch (error) {
    console.warn(`[test-teardown] best-effort rm failed for ${target}:`, error?.code ?? error);
  }
}

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

test('synthetic Claude JSONL becomes ContextMessage objects and skips tool lines', () => {
  const raw = [
    line({
      type: 'user',
      timestamp: '2026-07-08T00:00:00.000Z',
      message: { role: 'user', content: 'question one' },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-07-08T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'answer one' },
          { type: 'tool_use', name: 'Read' },
          { type: 'text', text: 'answer two' },
        ],
      },
    }),
    line({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'tool output' }],
      },
      toolUseResult: {},
    }),
    line({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Write' }],
      },
    }),
    line({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'question two' },
          { type: 'tool_result', content: 'ignored' },
        ],
      },
    }),
    line({
      type: 'assistant',
      message: { role: 'assistant', content: 'final answer' },
    }),
    line({ type: 'summary', content: 'skip me' }),
  ].join('');

  const messages = transcriptJsonlToMessages(raw);

  assert.deepEqual(messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'question one' },
    { role: 'assistant', content: 'answer one\nanswer two' },
    { role: 'user', content: 'question two' },
    { role: 'assistant', content: 'final answer' },
  ]);
  assert.equal(messages[0].timestamp, Date.parse('2026-07-08T00:00:00.000Z'));
  assert.equal(messages[1].timestamp, Date.parse('2026-07-08T00:00:01.000Z'));
});

test('archive posts parsed messages to /archive-transcript', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mr-cc-archive-'));
  const transcriptPath = path.join(tmpDir, 'session.jsonl');
  await writeFile(transcriptPath, [
    line({ type: 'user', message: { role: 'user', content: 'hello' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] } }),
  ].join(''), 'utf8');

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ archived: 2 }),
    };
  };

  try {
    await handleArchiveSession({
      session_id: 'abc',
      transcript_path: transcriptPath,
    }, { fetchImpl });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:4791/archive-transcript');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      session: { sessionKey: 'cc-abc' },
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ],
    });
  } finally {
    await bestEffortRm(tmpDir, { recursive: true, force: true });
  }
});

test('empty transcript does not call archive API', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mr-cc-empty-'));
  const transcriptPath = path.join(tmpDir, 'empty.jsonl');
  await writeFile(transcriptPath, '', 'utf8');
  let calls = 0;

  try {
    await handleArchiveSession({
      session_id: 'abc',
      transcript_path: transcriptPath,
    }, {
      fetchImpl: async () => {
        calls += 1;
        throw new Error('should not call');
      },
    });

    assert.equal(calls, 0);
  } finally {
    await bestEffortRm(tmpDir, { recursive: true, force: true });
  }
});
