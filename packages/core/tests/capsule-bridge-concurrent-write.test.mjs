import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CapsuleBridge } from '../dist/pipeline/capsule-bridge.js';

test('writeToInbox: concurrent same-tick writes never collide or overwrite each other', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capsule-bridge-concurrent-'));
  try {
    const bridge = new CapsuleBridge(root);

    const writes = Array.from({ length: 20 }, (_, i) =>
      bridge.writeToInbox(`capsule text #${i}`, { category: 'fact', importance: 0.5 })
    );
    const paths = await Promise.all(writes);

    // 20 個呼叫必須得到 20 個不同的路徑
    const uniquePaths = new Set(paths);
    assert.equal(uniquePaths.size, 20, `expected 20 unique paths, got ${uniquePaths.size}`);

    // 20 個檔案都要真的存在，且各自內容對應正確的索引
    for (let i = 0; i < 20; i++) {
      const p = paths[i];
      assert.ok(fs.existsSync(p), `expected file to exist: ${p}`);
      const content = fs.readFileSync(p, 'utf-8');
      assert.ok(
        content.includes(`capsule text #${i}`),
        `file ${p} content should contain capsule text #${i}, got: ${content}`
      );
    }

    // 檔名前綴仍要維持 river_capsule_ 供 inbox-watcher 辨識
    for (const p of paths) {
      assert.match(path.basename(p), /^river_capsule_\d+_[0-9a-f]+\.txt$/);
    }
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  }
});
