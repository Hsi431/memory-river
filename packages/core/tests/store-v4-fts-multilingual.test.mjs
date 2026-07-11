import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../dist/store/store-v4.js';

async function withTempStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-fts-'));
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

async function storeMemory(store, text) {
  return await store.store({
    text,
    vector: [0.1, 0.2, 0.3, 0.4],
    importance: 0.8,
    category: 'fact',
    parentId: null,
    metadata: '{}',
  });
}

test('FTS supports Chinese, English, mixed text, and excludes zero-score rows', async () => {
  await withTempStore(async store => {
    await storeMemory(store, '星辰科技這個月應收帳款');
    await storeMemory(store, 'Zorblax quarterly revenue increased');
    await storeMemory(store, '星辰科技 uses Zorblax for reporting');
    await storeMemory(store, '完全無關的午餐紀錄');

    const chinese = await store.ftsSearch('星辰科技', 10);
    const english = await store.ftsSearch('Zorblax', 10);
    const mixed = await store.ftsSearch('星辰科技 Zorblax', 10);
    const noMatch = await store.ftsSearch('NoSuchTerm987654', 10);

    assert.ok(chinese.length > 0);
    assert.ok(chinese.every(result => result.bm25Score > 0));
    assert.ok(chinese.some(result => result.entry.text === '星辰科技這個月應收帳款'));
    assert.ok(english.length > 0);
    assert.ok(english.every(result => result.bm25Score > 0));
    assert.ok(english.some(result => result.entry.text === 'Zorblax quarterly revenue increased'));
    assert.ok(mixed.length > 0);
    assert.ok(mixed.every(result => result.bm25Score > 0));
    assert.equal(mixed.some(result => result.entry.text === '完全無關的午餐紀錄'), false);
    assert.deepEqual(noMatch, []);

    console.log(
      `[fts-repro] 星辰科技=${chinese[0].bm25Score.toFixed(3)} ` +
      `Zorblax=${english[0].bm25Score.toFixed(3)} noMatch=${noMatch.length}`,
    );
  });
});
