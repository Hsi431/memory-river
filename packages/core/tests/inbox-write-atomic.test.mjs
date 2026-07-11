import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InboxWatcher } from '../dist/pipeline/inbox-watcher.js';

test('writeInbox renames a completed temporary file into the inbox', async () => {
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-inbox-'));
  const originalRename = fs.promises.rename;
  let renameArgs;
  fs.promises.rename = async (from, to) => {
    renameArgs = [from, to];
    return originalRename(from, to);
  };
  try {
    const filename = await InboxWatcher.writeInbox(inbox, { text: 'atomic', category: 'fact' });
    assert.equal(renameArgs[0], path.join(inbox, `${filename}.tmp`));
    assert.equal(renameArgs[1], path.join(inbox, filename));
    assert.equal(fs.existsSync(renameArgs[0]), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(renameArgs[1], 'utf8')), { text: 'atomic', category: 'fact' });
  } finally {
    fs.promises.rename = originalRename;
    try {
      fs.rmSync(inbox, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${inbox}:`, error?.code ?? error);
    }
  }
});
