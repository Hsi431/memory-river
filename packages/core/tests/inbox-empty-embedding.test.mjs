import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';

test('empty embedding dead-letters the inbox item instead of deleting it', async () => {
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-empty-embedding-'));
  const filePath = path.join(inbox, 'pending-empty.json');
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    callback();
    return 0;
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify({ text: 'must survive empty embedding', category: 'fact' }));
    const watcher = new InboxWatcher(
      {},
      { embed: async () => [] },
      {},
      null,
      null,
      { generate: async () => '' },
      inbox,
      2000,
      undefined,
      { changeStatus: async () => {} },
      async () => {},
    );

    const result = await watcher.processFile(filePath);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty_embedding');
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.existsSync(path.join(inbox, 'error', 'pending-empty.json')), true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    fs.rmSync(inbox, { recursive: true, force: true });
  }
});
