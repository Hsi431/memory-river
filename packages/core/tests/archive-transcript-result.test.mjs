import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryRiver } from '../dist/api.js';

function makeRiver(root) {
  return createMemoryRiver({
    dataDir: path.join(root, 'data'),
    ramDir: path.join(root, 'ram'),
    autoRecall: false,
  }, {
    embedder: {
      embed: async () => [0, 0, 0, 0],
      embedBatch: async texts => texts.map(() => [0, 0, 0, 0]),
      getDimensions: () => 4,
      healthCheck: async () => true,
    },
    llm: {
      generate: async () => JSON.stringify({ capsule: 'mock', notes: [] }),
    },
  });
}

test('archiveTranscript returns the real ArchiveSnapshotResult instead of silently discarding it (F5)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-transcript-result-'));
  const river = makeRiver(root);
  try {
    await river.start();

    const messages = [
      { role: 'user', content: 'F5 regression question', timestamp: 1 },
      { role: 'assistant', content: 'F5 regression answer', timestamp: 2 },
    ];

    // 成功路徑：有 sessionKey，應該回傳 ok:true 且 appendedEntries 正確，不是被吞掉的 undefined
    const ok = await river.archiveTranscript({ sessionKey: 'f5-session' }, messages);
    assert.equal(ok.ok, true);
    assert.equal(ok.appendedEntries, 1);

    // 失敗路徑：完全沒有 sessionKey/sessionId → archiveSnapshot 內部判定失敗，
    // 絕不能靜默成功（不能回傳 undefined 讓 caller 誤以為成功）
    const failed = await river.archiveTranscript({}, messages);
    assert.equal(failed.ok, false);
    assert.equal(failed.appendedEntries, 0);
  } finally {
    await river.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
