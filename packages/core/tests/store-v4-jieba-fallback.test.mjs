import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 必須在 import store-v4 之前掛,才攔得到它動態 import 的 nodejieba。
register('./fixtures/broken-nodejieba-hooks.mjs', import.meta.url);

const { MemoryStore } = await import('../dist/store/store-v4.js');

async function withTempStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-jieba-'));
  const oldHome = process.env.HOME;
  process.env.HOME = path.join(root, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const store = new MemoryStore(
    path.join(root, 'ssd'),
    path.join(root, 'ram'),
    4,
    undefined,
    { embed: async () => [0.1, 0.2, 0.3, 0.4] },
  );

  try {
    await store.ensureInitialized();
    await fn(store);
  } finally {
    await store.shutdown?.().catch?.(() => {});
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  }
}

test('a broken nodejieba native binding degrades tokenization instead of failing writes', async () => {
  await withTempStore(async store => {
    const entry = await store.store({
      text: '星辰科技這個月應收帳款',
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 0.8,
      category: 'fact',
      parentId: null,
      metadata: '{}',
    });
    assert.ok(entry?.id);

    await store.update(entry.id, { text: '星辰科技下個月應收帳款' });

    // 降級成單字切分,中文 FTS 仍然找得到。
    const hits = await store.ftsSearch('星辰', 10);
    assert.ok(hits.length > 0);
  });
});
