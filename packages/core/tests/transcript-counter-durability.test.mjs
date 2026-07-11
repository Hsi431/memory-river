import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncBuiltinESMExports } from 'node:module';

import { createTranscriptArchive } from '../dist/transcript/transcript-archive.js';

test('archive does not append when persisting the entry counter fails', () => {
  const transcriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-transcript-counter-'));
  const archive = createTranscriptArchive(transcriptsDir);
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (file === path.join(transcriptsDir, 'transcript.counter')) {
      throw new Error('counter write failed');
    }
    return originalWriteFileSync(file, ...args);
  };
  syncBuiltinESMExports();

  try {
    const result = archive.archiveSnapshot(
      { canonicalKey: 'agent:test', sessionKey: 'agent:test' },
      [
        { role: 'user', content: 'persist counter first', timestamp: 1 },
        { role: 'assistant', content: 'acknowledged', timestamp: 2 },
      ],
    );

    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(path.join(transcriptsDir, 'agent:test.jsonl')), false);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    syncBuiltinESMExports();
    try {
      fs.rmSync(transcriptsDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${transcriptsDir}:`, error?.code ?? error);
    }
  }
});
