import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConcentratorAdapter } from '../dist/distill/concentrator-adapter.js';
import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';

const FIXED_EPOCH = 1783030769576;

function makeMessages(count) {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn-${i}`,
    timestamp: 1710000000000 + i * 1000,
  }));
}

function retainedTurnContents(result) {
  return result.messages
    .map((message) => typeof message.content === 'string' ? message.content : '')
    .filter((content) => content.startsWith('turn-'));
}

async function withAdapter(options, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concentrator-exhaustive-'));
  const transcripts = path.join(root, 'transcripts');
  fs.mkdirSync(transcripts, { recursive: true });
  const transcriptArchive = createTranscriptArchive(transcripts);
  transcriptArchive.clearTranscriptCache();

  const captured = {
    prompts: [],
    simplePrompts: [],
    writes: [],
  };

  try {
    const adapter = new ConcentratorAdapter({
      apiKey: 'test-api-key',
      model: 'test-model',
      inboxPath: path.join(root, 'inbox'),
      concentrationTarget: options.concentrationTarget ?? 1,
      transcriptArchive,
      sessionSummaryDir: path.join(root, 'session-summaries'),
      ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
    });

    adapter.callWithFallback = async (prompt, _fnName, simplePrompt) => {
      captured.prompts.push(prompt);
      captured.simplePrompts.push(simplePrompt);
      return JSON.stringify({
        capsule: 'test capsule',
        notes: [],
        confidence: 0.9,
      });
    };
    adapter.writeSessionSummary = async () => {};
    adapter.capsuleBridge = {
      async writeToInbox(text, opts) {
        captured.writes.push({ text, opts });
        return path.join(root, 'captured-capsule.txt');
      },
    };

    await fn(adapter, captured);
  } finally {
    transcriptArchive.clearTranscriptCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('force without exhaustive preserves the existing last-five tail behavior', async () => {
  await withAdapter({}, async (adapter, captured) => {
    const result = await adapter.concentrate(makeMessages(8), false, true);

    assert.equal(result.processedThroughIndex, 3);
    assert.deepEqual(retainedTurnContents(result), ['turn-3', 'turn-4', 'turn-5', 'turn-6', 'turn-7']);
    assert.equal(captured.prompts.length, 1);
    assert.ok(captured.prompts[0].includes('turn-0'));
    assert.ok(captured.prompts[0].includes('turn-1'));
    assert.ok(captured.prompts[0].includes('turn-2'));
    assert.equal(captured.prompts[0].includes('turn-3'), false);
  });
});

test('force with exhaustive summarizes all messages and retains no old non-system turns', async () => {
  await withAdapter({}, async (adapter, captured) => {
    const result = await adapter.concentrate(makeMessages(8), false, true, { exhaustive: true });

    assert.equal(result.processedThroughIndex, 8);
    assert.deepEqual(retainedTurnContents(result), []);
    assert.equal(captured.prompts.length, 1);
    for (let i = 0; i < 8; i++) {
      assert.ok(captured.prompts[0].includes(`turn-${i}`));
    }
  });
});

test('non-cut early return reports processedThroughIndex zero', async () => {
  await withAdapter({ concentrationTarget: 1_000_000 }, async (adapter, captured) => {
    const result = await adapter.concentrate(makeMessages(2), false, false);

    assert.equal(result.wasConcentrated, false);
    assert.equal(result.processedThroughIndex, 0);
    assert.deepEqual(retainedTurnContents(result), ['turn-0', 'turn-1']);
    assert.equal(captured.prompts.length, 0);
  });
});

test('force on five or fewer messages keeps existing full-batch behavior with and without exhaustive', async () => {
  for (const context of [{}, { exhaustive: true }]) {
    await withAdapter({}, async (adapter, captured) => {
      const result = await adapter.concentrate(makeMessages(5), false, true, context);

      assert.equal(result.processedThroughIndex, 5);
      assert.deepEqual(retainedTurnContents(result), []);
      assert.equal(captured.prompts.length, 1);
      for (let i = 0; i < 5; i++) {
        assert.ok(captured.prompts[0].includes(`turn-${i}`));
      }
    });
  }
});

test('Asia/Taipei timezone anchors prompt timestamps to local wall clock with offset', async () => {
  await withAdapter({ timezone: 'Asia/Taipei' }, async (adapter, captured) => {
    await adapter.concentrate([
      { role: 'user', content: 'time-anchor', timestamp: FIXED_EPOCH },
    ], false, true);

    assert.equal(captured.prompts.length, 1);
    assert.ok(captured.prompts[0].includes('[at=2026-07-03T06:19'));
    assert.ok(captured.prompts[0].includes('+08:00'));
  });
});

test('UTC timezone anchors prompt timestamps to UTC wall clock with zero offset', async () => {
  await withAdapter({ timezone: 'UTC' }, async (adapter, captured) => {
    await adapter.concentrate([
      { role: 'user', content: 'time-anchor', timestamp: FIXED_EPOCH },
    ], false, true);

    assert.equal(captured.prompts.length, 1);
    assert.ok(captured.prompts[0].includes('[at=2026-07-02T22:19'));
    assert.ok(captured.prompts[0].includes('+00:00'));
    assert.equal(captured.prompts[0].includes('+08:00'), false);
  });
});

test('invalid timezone does not throw and falls back to UTC prompt timestamps', async () => {
  await withAdapter({ timezone: 'Not/AZone' }, async (adapter, captured) => {
    await adapter.concentrate([
      { role: 'user', content: 'time-anchor', timestamp: FIXED_EPOCH },
    ], false, true);

    assert.equal(captured.prompts.length, 1);
    assert.ok(captured.prompts[0].includes('[at=2026-07-02T22:19'));
    assert.ok(captured.prompts[0].includes('+00:00'));
    assert.equal(captured.prompts[0].includes('+08:00'), false);
  });
});
