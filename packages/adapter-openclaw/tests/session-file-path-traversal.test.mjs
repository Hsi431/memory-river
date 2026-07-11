import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveSessionFile } from '../dist/index.js';

test('static session-file fallback rejects traversal session IDs', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-openclaw-state-'));
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;

  try {
    const result = resolveSessionFile({
      sessionKey: 'agent:trusted-agent:discord:direct:1',
      sessionId: '../../etc/x',
    });

    assert.equal(result.sessionFile, null);
  } finally {
    if (originalStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = originalStateDir;
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${stateDir}:`, error?.code ?? error);
    }
  }
});
