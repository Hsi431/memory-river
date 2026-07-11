import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryRiver } from '../dist/api.js';
import { MemoryStore } from '../dist/store/store-v4.js';

// 確定性假嵌入：文字內容（字元碼總和）決定向量，方便斷言「向量是不是跟著新文字變了」
function deterministicVector(text) {
  const vector = [0, 0, 0, 0];
  for (let i = 0; i < text.length; i++) vector[i % vector.length] += text.charCodeAt(i) / 1000;
  return vector;
}

function makeRiver(root) {
  return createMemoryRiver({
    dataDir: path.join(root, 'data'),
    ramDir: path.join(root, 'ram'),
    autoRecall: false,
  }, {
    embedder: {
      embed: async text => deterministicVector(text),
      embedBatch: async texts => texts.map(deterministicVector),
      getDimensions: () => 4,
      healthCheck: async () => true,
    },
    llm: {
      generate: async () => JSON.stringify({ capsule: 'mock', notes: [] }),
    },
  });
}

test('updateMemory re-embeds text so the stored vector reflects the new content (F2)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-update-vector-'));
  const river = makeRiver(root);
  try {
    await river.start();
    const oldText = 'F2 vector regression original marker Alpha1234';
    const newText = 'F2 vector regression replaced marker Zulu9999XYZ totally different length';
    await river.remember(oldText, { category: 'fact', importance: 0.9 });

    const before = await river.recall(oldText, 5);
    const target = before.find(r => r.entry.text === oldText);
    assert.ok(target, 'expected to find the stored memory before update');
    const id = target.entry.id;

    const ok = await river.updateMemory(id, { text: newText });
    assert.equal(ok, true);

    const after = await river.recall(newText, 5);
    const updated = after.find(r => r.entry.id === id);
    assert.ok(updated, 'expected to find the updated memory via new text');
    assert.equal(updated.entry.text, newText);

    // LanceDB 向量欄位以 float32 存放，讀回會有 float32 量級的捨入誤差（~1e-7 相對值），
    // 容差抓 1e-4 遠大於捨入雜訊、但遠小於「還是舊向量」與「新向量」之間的實際差距。
    const expectedVector = deterministicVector(newText);
    for (let i = 0; i < expectedVector.length; i++) {
      assert.ok(
        Math.abs(updated.entry.vector[i] - expectedVector[i]) < 1e-4,
        `vector[${i}] should equal the new text's embedding after update: got ${updated.entry.vector[i]}, expected ${expectedVector[i]}`
      );
    }
  } finally {
    await river.stop();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${root}:`, error?.code ?? error);
    }
  }
});

test('store.update() still rejects a vector smuggled inside the updates object (F2 guard unchanged)', async () => {
  const VALID_ID = '11111111-1111-4111-8111-111111111111';
  const store = {
    ssdAvailable: false,
    async ensureInitialized() {},
  };
  await assert.rejects(
    () => MemoryStore.prototype.update.call(store, VALID_ID, { vector: [0.1, 0.2] }),
    /update\(\) rejected: cannot modify immutable field 'vector'/
  );
});
