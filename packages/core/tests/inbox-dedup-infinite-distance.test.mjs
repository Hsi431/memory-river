import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';
import { MemoryStore } from '../dist/store/store-v4.js';

// 迴歸測試:0b579a9 讓 hybridVectorSearch 改依 fusedScore 排序之後,「只有 BM25 命中」
// 的候選可以排到第 0 位,而那種候選的 rawDistance 是 Infinity。去重檢查如果只看
// similar[0],就會拿 Infinity 去比 0.15,判定為「不重複」而把重複記憶寫進去。
// 修正前的排序是純向量名次,第 0 位幾乎必然是有限距離,所以這條路以前踩不到。
test('inbox dedup skips a duplicate even when an FTS-only hit sorts first', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't7-inbox-inf-'));
  const oldHome = process.env.HOME;
  process.env.HOME = path.join(root, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const procPath = path.join(root, 'pending_test.json');
  let relationCalls = 0;
  let storeCalls = 0;
  const vector = [0.1, 0.2, 0.3, 0.4];
  const store = new MemoryStore(
    path.join(root, 'ssd'),
    path.join(root, 'ram'),
    4,
    undefined,
    { embed: async () => vector },
  );
  await store.ensureInitialized();
  const originalStore = store.store.bind(store);
  store.store = async (...args) => {
    storeCalls += 1;
    return await originalStore(...args);
  };
  // 第 0 筆是 BM25-only 命中(Infinity),第 1 筆才是真正的近似重複。
  store.hybridVectorSearch = async () => ([
    { entry: { id: 'fts-only', text: 'unrelated but shares a word', category: 'fact', metadata: '{}' },
      rawDistance: Number.POSITIVE_INFINITY, vectorScore: 0, rankScore: 0, bm25Score: 1 / 61, fusedScore: 1 / 122 },
    { entry: { id: 'real-dup', text: 'same memory', category: 'fact', metadata: '{}' },
      rawDistance: 0.05, vectorScore: 1 / 63, rankScore: 1 / 63, bm25Score: 0, fusedScore: 1 / 126 },
  ]);

  const watcher = new InboxWatcher(
    store,
    { embed: async () => vector },
    {
      determineRelation: async () => {
        relationCalls += 1;
        return { action: 'CREATE', parentId: undefined };
      },
    },
    null,
    null,
    { generate: async () => '' },
    root,
    2000,
    undefined,
    { changeStatus: async () => {} },
    async () => {},
  );

  try {
    fs.writeFileSync(procPath, JSON.stringify({
      text: 'same memory',
      category: 'fact',
      importance: 0.8,
    }));

    await watcher._processMemoryEntry(procPath);

    assert.equal(storeCalls, 0, '重複記憶不該被寫入');
    assert.equal(relationCalls, 0, '判定為重複時不該再叫 determineRelation');
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
});
