import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConcentratorAdapter } from '../dist/distill/concentrator-adapter.js';

function makeAdapter(root) {
  const inboxPath = path.join(root, 'inbox');
  const sessionSummaryDir = path.join(root, 'session-summaries');
  fs.mkdirSync(inboxPath, { recursive: true });
  return new ConcentratorAdapter({
    apiKey: 'k',
    model: 'm',
    inboxPath,
    sessionSummaryDir,
  });
}

function makeSummary(sessionId) {
  return {
    sessionId,
    concentratedAt: Date.now(),
    capsule: 'capsule text',
    notes: [],
    primaryRequest: '',
    pendingTasks: '',
    nextStep: '',
  };
}

function listFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

test('writeSessionSummary rejects path-traversal / separator sessionIds and never writes outside sessionSummaryDir (F3)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concentrator-summary-traversal-'));
  try {
    const adapter = makeAdapter(root);

    // 直接跳一層跑出 sessionSummaryDir 的經典逃逸案例
    await adapter.writeSessionSummary(makeSummary('../escape'));
    assert.equal(
      fs.existsSync(path.join(root, 'escape-summary.json')),
      false,
      'a "../escape" sessionId must not write a file outside sessionSummaryDir',
    );

    // 絕對路徑 / 含分隔符的 sessionId：一律拒絕，不應在 sessionSummaryDir 內外留下任何檔案
    for (const sessionId of ['/etc/passwd-ish', 'a/b', 'a\\b']) {
      await adapter.writeSessionSummary(makeSummary(sessionId));
    }

    const summaryDir = path.join(root, 'session-summaries');
    const files = listFilesRecursive(summaryDir);
    assert.equal(files.length, 0, `expected no files written for malicious sessionIds, got: ${files.join(', ')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('writeSessionSummary still writes normal sessionIds (including ":" and ".") inside sessionSummaryDir', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concentrator-summary-normal-'));
  try {
    const adapter = makeAdapter(root);
    const sessionId = 'agent:foo.bar-baz_123';
    await adapter.writeSessionSummary(makeSummary(sessionId));

    const summaryDir = path.join(root, 'session-summaries');
    const expectedPath = path.join(summaryDir, `${sessionId}-summary.json`);
    assert.ok(fs.existsSync(expectedPath), `expected summary file at ${expectedPath}`);
    const parsed = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));
    assert.equal(parsed.capsule, 'capsule text');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
