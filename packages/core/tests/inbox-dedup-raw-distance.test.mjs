import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';
import { MemoryStore } from '../dist/store/store-v4.js';

test('inbox duplicate check skips a high-similarity memory using rawDistance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't7-inbox-dedup-'));
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
  await store.store({
    text: 'same memory',
    vector,
    importance: 0.8,
    category: 'fact',
    parentId: null,
    metadata: '{}',
  });
  const originalStore = store.store.bind(store);
  store.store = async (...args) => {
    storeCalls += 1;
    return await originalStore(...args);
  };
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

    assert.equal(relationCalls, 0);
    assert.equal(storeCalls, 0);
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
