import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('default RAM path preserves /dev/shm and falls back to the system temp directory', async () => {
  const adapter = await import('../dist/index.js');
  const fallbackDirectory = path.join(os.tmpdir(), 'F3-ram-fallback');
  assert.equal(
    adapter.resolveDefaultRamDbPath?.(),
    path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'memory-river', 'lancedb-v6-qwen'),
  );
  assert.equal(
    adapter.resolveDefaultRamDbPath(true, fallbackDirectory),
    path.join('/dev/shm', 'memory-river', 'lancedb-v6-qwen'),
  );
  assert.equal(
    adapter.resolveDefaultRamDbPath(false, fallbackDirectory),
    path.join(fallbackDirectory, 'memory-river', 'lancedb-v6-qwen'),
  );
});

test('static session fallback uses the OS home directory when HOME is unset', async () => {
  const systemHome = os.homedir();
  const originalHome = process.env.HOME;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  delete process.env.HOME;
  delete process.env.OPENCLAW_STATE_DIR;
  try {
    const adapter = await import(`../dist/index.js?f3-home-${Date.now()}`);
    const resolved = adapter.resolveSessionFile({
      sessionKey: 'agent:portable-agent:discord:direct:1',
      sessionId: 'session-1',
    });
    assert.equal(
      resolved.sessionFile,
      path.join(systemHome, '.openclaw', 'agents', 'portable-agent', 'sessions', 'session-1.jsonl'),
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});
