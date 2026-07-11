import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { serviceLockPath } from '../dist/lockfile.js';

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('exactly one process acquires a stale service lock', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-service-lock-process-race-'));
  const lockPath = serviceLockPath(dataDir);
  const stalePid = 99_999_999;
  const children = [];
  const ready = [];
  const results = [];
  fs.writeFileSync(lockPath, `${stalePid}\n`);
  t.after(async () => {
    const running = children.filter((child) => child.exitCode === null && child.connected);
    for (const child of running) child.send('release');
    await Promise.all(running.map((child) => new Promise((resolve) => child.once('exit', resolve))));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${dataDir}:`, error?.code ?? error);
    }
  });

  for (let index = 0; index < 12; index++) {
    const child = fork(new URL('./lockfile-race-child.mjs', import.meta.url), [dataDir], {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    children.push(child);
    child.on('message', (message) => {
      if (message.ready) ready.push(message);
      if ('acquired' in message) results.push(message);
    });
  }

  await waitFor(() => ready.length === children.length, 'all lock contenders to be ready', 10_000);
  for (const child of children) child.send('acquire');
  await waitFor(() => results.length === children.length, 'all lock contenders to settle', 10_000);
  const winnerCount = results.filter((result) => result.acquired).length;
  console.log(`[lockfile-race] cross-process winner count=${winnerCount}`);
  assert.equal(winnerCount, 1);
});
