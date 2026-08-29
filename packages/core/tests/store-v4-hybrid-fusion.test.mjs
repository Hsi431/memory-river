import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';

function makeTempPaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const ram = path.join(root, 'ram-db');
  const ssd = path.join(root, 'ssd-db');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ram, { recursive: true });
  fs.mkdirSync(ssd, { recursive: true });
  return { root, home, ram, ssd };
}

async function withTempStore(prefix, fn) {
  const paths = makeTempPaths(prefix);
  const oldHome = process.env.HOME;
  process.env.HOME = paths.home;

  const store = new MemoryStore(paths.ssd, paths.ram, 4, undefined, {
    embed: async () => [1, 0, 0, 0],
  });

  try {
    await store.ensureInitialized();
    await fn({ store });
  } finally {
    await store.shutdown?.().catch?.(() => {});
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    try {
      fs.rmSync(paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${paths.root}:`, error?.code ?? error);
    }
  }
}

async function storeMemory(store, text, vector = [1, 0, 0, 0]) {
  return await store.store({
    text,
    vector,
    importance: 0.8,
    category: 'fact',
    parentId: null,
    metadata: '{}',
  });
}

function makeCandidate(entry, overrides = {}) {
  return {
    entry,
    vectorScore: overrides.vectorScore ?? 0.8,
    rankScore: overrides.rankScore ?? 0.8,
    rawDistance: overrides.rawDistance ?? 0.25,
    bm25Score: overrides.bm25Score ?? 0,
    fusedScore: overrides.fusedScore ?? 0.8,
  };
}

test('hybridVectorSearch keeps a BM25-only match in the requested results', async () => {
  await withTempStore('hybrid-fusion-bm25-only-', async ({ store }) => {
    for (let i = 0; i < 4; i += 1) {
      await storeMemory(store, `vector distractor ${i}`);
    }
    const lexicalOnly = await storeMemory(
      store,
      'memory contains zzq-unique-token',
      [0, 1, 0, 0],
    );

    const vectorResults = await store.vectorSearch([1, 0, 0, 0], 4);
    assert.equal(vectorResults.some((result) => result.entry.id === lexicalOnly.id), false);

    const results = await store.hybridVectorSearch('zzq-unique-token', 2);

    assert.equal(results.some((result) => result.entry.id === lexicalOnly.id), true);
  });
});

test('hybridVectorSearch ranks a candidate found by both sources above single-source matches', async () => {
  await withTempStore('hybrid-fusion-both-sources-', async ({ store }) => {
    const both = await storeMemory(store, 'zzq-both-token shared semantic memory', [1, 0, 0, 0]);
    const vectorOnly = await storeMemory(store, 'semantic neighbor memory', [0.95, 0.05, 0, 0]);
    const bm25Only = await storeMemory(store, 'zzq-both-token lexical memory', [0, 1, 0, 0]);

    const results = await store.hybridVectorSearch('zzq-both-token', 3);
    const byId = new Map(results.map((result) => [result.entry.id, result]));

    assert.ok(byId.get(both.id).rankScore > 0);
    assert.ok(byId.get(both.id).bm25Score > 0);
    assert.ok(byId.get(both.id).fusedScore > byId.get(vectorOnly.id).fusedScore);
    assert.ok(byId.get(both.id).fusedScore > byId.get(bm25Only.id).fusedScore);
  });
});

// 排序不依賴 Map 的插入順序。注意這裡能保證的只有「確定性」:rankScore 是依名次
// 重算的,同一份清單裡必然互異,所以 fusedScore 與 rankScore 同時相等的平手不存在,
// 沒有第三層可比,也沒有第三層需要測。
test('hybridVectorSearch 的排序是確定性的,不吃 Map 插入順序', async () => {
  await withTempStore('hybrid-fusion-deterministic-', async ({ store }) => {
    const first = await storeMemory(store, 'tie vector candidate');
    const second = await storeMemory(store, 'tie lexical candidate');
    store.vectorSearch = async () => [makeCandidate(first)];
    store.ftsAvailable = true;
    store.ftsSearch = async () => [makeCandidate(second)];

    const firstRun = await store.hybridVectorSearch('tie query', 2);
    const secondRun = await store.hybridVectorSearch('tie query', 2);

    assert.deepEqual(
      firstRun.map((result) => result.entry.id),
      secondRun.map((result) => result.entry.id),
    );
    // 兩路各出一筆、名次相同 ⇒ fusedScore 相等,由 rankScore 決勝:向量那筆在前。
    assert.equal(firstRun[0].entry.id, first.id);
  });
});
