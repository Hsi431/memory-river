import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';
import { CapsuleBridge } from '../dist/pipeline/capsule-bridge.js';
import { ConcentratorAdapter } from '../dist/distill/concentrator-adapter.js';

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

let originalUmask;
test.before(() => {
  // 確保測試在已知基線下跑，不受呼叫者 shell 的 umask 影響（F4 驗收條件要求）
  originalUmask = process.umask(0o022);
});
test.after(() => {
  process.umask(originalUmask);
});

test('transcript-archive: newly created dir and files are 0700/0600 (F4)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-transcript-'));
  try {
    const transcriptsDir = path.join(root, 'transcripts');
    const { archiveSnapshot } = createTranscriptArchive(transcriptsDir);
    const identity = { canonicalKey: 'perm-test', sessionKey: 'perm-test', sessionId: 'perm-test' };
    const messages = [
      { role: 'user', content: 'hi', timestamp: 1 },
      { role: 'assistant', content: 'hello', timestamp: 2 },
    ];
    const result = archiveSnapshot(identity, messages);
    assert.equal(result.ok, true);

    assert.equal(modeOf(transcriptsDir), 0o700, 'transcripts dir should be 0700');
    const jsonlPath = path.join(transcriptsDir, 'perm-test.jsonl');
    assert.ok(fs.existsSync(jsonlPath));
    assert.equal(modeOf(jsonlPath), 0o600, 'transcript jsonl file should be 0600');
    const idxPath = jsonlPath + '.idx';
    assert.ok(fs.existsSync(idxPath));
    assert.equal(modeOf(idxPath), 0o600, 'transcript .idx sidecar should be 0600');
    const counterPath = path.join(transcriptsDir, 'transcript.counter');
    assert.ok(fs.existsSync(counterPath));
    assert.equal(modeOf(counterPath), 0o600, 'transcript.counter should be 0600');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('capsule-bridge: newly created inbox dir and files are 0700/0600 (F4)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-capsule-'));
  try {
    const inboxPath = path.join(root, 'inbox');
    const bridge = new CapsuleBridge(inboxPath);
    assert.equal(modeOf(inboxPath), 0o700, 'inbox dir should be 0700');

    const capsulePath = await bridge.writeToInbox('hello capsule', { category: 'fact' });
    assert.equal(modeOf(capsulePath), 0o600, 'river_capsule_*.txt should be 0600');

    const itemPath = await bridge.writeInboxItem('hello item', { category: 'fact' });
    assert.equal(modeOf(itemPath), 0o600, 'pending_*.json should be 0600');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('concentrator-adapter: session-summary dir and file are 0700/0600 (F4)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-summary-'));
  try {
    const inboxPath = path.join(root, 'inbox');
    const sessionSummaryDir = path.join(root, 'session-summaries');
    fs.mkdirSync(inboxPath, { recursive: true });
    const adapter = new ConcentratorAdapter({ apiKey: 'k', model: 'm', inboxPath, sessionSummaryDir });

    await adapter.writeSessionSummary({
      sessionId: 'perm-test-session',
      concentratedAt: Date.now(),
      capsule: 'c',
      notes: [],
      primaryRequest: '',
      pendingTasks: '',
      nextStep: '',
    });

    assert.equal(modeOf(sessionSummaryDir), 0o700, 'session-summaries dir should be 0700');
    const summaryPath = path.join(sessionSummaryDir, 'perm-test-session-summary.json');
    assert.ok(fs.existsSync(summaryPath));
    assert.equal(modeOf(summaryPath), 0o600, 'session summary file should be 0600');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
