import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../dist/store/store-v4.js';

function makeStore(row) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-dynamic-capsule-decay-'));
  const store = new MemoryStore(
    path.join(root, 'ssd'),
    path.join(root, 'ram'),
    8,
    {
      initialScore: 100,
      decayPerRun: 5,
      decayIntervalMs: 24 * 60 * 60 * 1000,
      deleteThreshold: 0,
      coreCategories: ['identity', 'constraint', 'business', 'core_rule'],
      coreImportanceThreshold: 0.75,
    },
  );
  store.ramTable = {
    query() {
      return {
        limit() {
          return { async toArray() { return [row]; } };
        },
      };
    },
  };
  return { root, store };
}

function expiringRow(metadata, category = 'history') {
  const lastDecayedAt = Date.now() - 20 * 60 * 60 * 1000;
  return {
    id: '11111111-1111-4111-8111-111111111111',
    text: 'test memory',
    category,
    importance: 0.8,
    metadata: JSON.stringify({
      ...metadata,
      health: {
        healthScore: 100,
        lastAccessedAt: lastDecayedAt,
        lastDecayedAt,
        accessCount: 0,
        decayCount: 0,
      },
    }),
    createdAt: lastDecayedAt,
  };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('dynamic capsule bypasses importance core protection by default', async () => {
  const { root, store } = makeStore(expiringRow({ type: 'dynamic_capsule' }));
  try {
    const result = await store.decayMemories(5, 0, { dryRun: true });

    assert.equal(result.coreProtected, 0);
    assert.equal(result.wouldDecay, 1);
    assert.equal(result.wouldDelete, 0);
  } finally {
    cleanup(root);
  }
});

test('ordinary memory with importance above the threshold remains core-protected', async () => {
  const { root, store } = makeStore(expiringRow({}));
  try {
    const result = await store.decayMemories(5, 0, { dryRun: true });

    assert.equal(result.coreProtected, 1);
    assert.equal(result.wouldDecay, 0);
    assert.equal(result.wouldDelete, 0);
  } finally {
    cleanup(root);
  }
});

test('skill capsule remains protected after dynamic capsule bypass', async () => {
  const { root, store } = makeStore(expiringRow({ capsuleType: 'skill_capsule' }));
  try {
    const result = await store.decayMemories(5, 0, {
      dryRun: true,
      coreImportanceThreshold: 0.9,
    });

    assert.equal(result.coreProtected, 0);
    assert.equal(result.wouldDecay, 0);
    assert.equal(result.wouldDelete, 0);
  } finally {
    cleanup(root);
  }
});

test('capsuleBypassCore false still decays ordinary non-core memories', async () => {
  // 關掉開關必須是「回到舊行為」,不是把所有記憶都當成 core 而凍結整個衰減。
  const { root, store } = makeStore(expiringRow({}, 'history'));
  store.ramTable.query = () => ({
    limit: () => ({ async toArray() { return [expiringRow({}, 'history')]; } }),
  });
  try {
    const result = await store.decayMemories(5, 0, {
      dryRun: true,
      coreImportanceThreshold: 0.9, // 0.8 < 0.9 且 category 非 core ⇒ 這筆不該被保護
      capsuleBypassCore: false,
    });

    assert.equal(result.coreProtected, 0);
    assert.equal(result.wouldDecay + result.wouldDelete, 1);
  } finally {
    cleanup(root);
  }
});

test('capsuleBypassCore false restores core protection for dynamic capsules', async () => {
  const { root, store } = makeStore(expiringRow({ type: 'dynamic_capsule' }));
  try {
    const result = await store.decayMemories(5, 0, {
      dryRun: true,
      capsuleBypassCore: false,
    });

    assert.equal(result.coreProtected, 1);
    assert.equal(result.wouldDecay, 0);
    assert.equal(result.wouldDelete, 0);
  } finally {
    cleanup(root);
  }
});
