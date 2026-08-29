// 鎖住入庫端「要不要覆寫既有記憶」的判定面。
//
// 為什麼需要這支:UPDATE 的判準是一個**綁在特定向量表示法上的絕對距離**
// (Qwen3 1024d 用 updateThreshold 0.28 / causalThreshold 0.32),加上一道
// 字面重疊(Jaccard >= 0.30)的二次確認。2026-08-28 改 query embedding 模板時
// 實測發現:光是換表示法,30 筆真實記憶裡就有 3 筆從 INDEPENDENT 變成 UPDATE
// (覆寫既有記憶),而當時沒有任何測試會紅。這支就是那個缺口。
//
// 這裡用假 embedder 精確控制距離,鎖的是「判定邏輯」;表示法漂移本身測不到
// (那需要真的 ollama),那一層靠 tools/causal-update-rate-probe.mjs 人工量。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';
import { CausalEngine } from '../dist/cognition/causal-engine.js';

// 四維單位向量:餘弦距離好算。A 與 A 距離 0;A 與 B 正交,距離 1。
const V = {
  a: [1, 0, 0, 0],
  b: [0, 1, 0, 0],
};

async function withEngine(prefix, vectorFor, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const ram = path.join(root, 'ram-db');
  const ssd = path.join(root, 'ssd-db');
  for (const dir of [home, ram, ssd]) fs.mkdirSync(dir, { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;

  const embedder = { dimensions: 4, embed: async (text) => vectorFor(text) };
  const store = new MemoryStore(ssd, ram, 4, undefined, embedder);
  try {
    await store.ensureInitialized();
    await fn({ store, engine: new CausalEngine(store, embedder, {}) });
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

function seed(store, text, vector, category = 'fact') {
  return store.store({ text, vector, importance: 0.6, category, parentId: null, metadata: '{}' });
}

const EXISTING = '使用者要求 AI 不要使用 Markdown emoji 條列或裝飾符號';

test('距離夠近且字面高度重疊 → UPDATE(覆寫既有記憶)', async () => {
  await withEngine('causal-update-', () => V.a, async ({ store, engine }) => {
    await seed(store, EXISTING, V.a);
    // 同一件事換句話說:向量相同(距離 0),字面重疊遠高於 0.30
    const result = await engine.determineRelation(
      '使用者指示 AI 不要使用 Markdown emoji 條列或裝飾符號',
      undefined,
      'fact',
    );
    assert.equal(result.action, 'UPDATE');
    assert.ok(result.parentId, 'UPDATE 必須指出要覆寫誰');
  });
});

test('距離夠近、字面不重疊、但同 category → 捷徑繞過 Jaccard 直接 UPDATE', async () => {
  // ⚠️ 這條鎖的是「已知的洞」,不是理想行為。judgeAction() 在 Jaccard 檢查之後有一條
  // `sameCategory && distance < updateThreshold * 0.75` 的捷徑,會繞過字面重疊確認。
  // 真實記憶庫裡 category 高度集中(fact / decision 佔多數),所以那道號稱防向量漂移的
  // 保護,在最常見的情況下並不生效。改這個行為前先看 REVIEW20260828_MERGED.md。
  await withEngine('causal-samecat-', () => V.a, async ({ store, engine }) => {
    await seed(store, EXISTING, V.a, 'fact');
    const result = await engine.determineRelation('車上節點的紅色門檻定為六十秒', undefined, 'fact');
    assert.equal(result.action, 'UPDATE');
  });
});

test('距離夠近、字面不重疊、不同 category → 降級 CAUSAL,不覆寫(漂移保護生效)', async () => {
  await withEngine('causal-guard-', () => V.a, async ({ store, engine }) => {
    await seed(store, EXISTING, V.a, 'fact');
    const result = await engine.determineRelation('車上節點的紅色門檻定為六十秒', undefined, 'decision');
    assert.notEqual(result.action, 'UPDATE');
    assert.equal(result.action, 'CAUSAL');
  });
});

test('距離超過 causalThreshold → INDEPENDENT', async () => {
  const vectorFor = (text) => (text.includes('Markdown') ? V.a : V.b);
  await withEngine('causal-independent-', vectorFor, async ({ store, engine }) => {
    await seed(store, EXISTING, V.a);
    const result = await engine.determineRelation('完全無關的一件事', undefined, 'fact');
    assert.equal(result.action, 'INDEPENDENT');
  });
});
