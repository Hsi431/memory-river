import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { acquireServiceLock, serviceLockPath } from '../dist/lockfile.js';

async function startLiveProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  return child;
}

async function stopLiveProcess(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('a live pid in a pre-boot service lock is reclaimed', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-service-lock-pre-boot-'));
  const lockPath = serviceLockPath(dataDir);
  const child = await startLiveProcess();
  t.after(async () => {
    await stopLiveProcess(child);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${dataDir}:`, error?.code ?? error);
    }
  });

  assert.ok(child.pid);
  assert.equal(child.exitCode, null);
  fs.writeFileSync(lockPath, `${child.pid}\n`);
  const bootTimeMs = Date.now() - os.uptime() * 1000;
  const preBootMtimeMs = bootTimeMs - 60_000;
  fs.utimesSync(lockPath, preBootMtimeMs / 1000, preBootMtimeMs / 1000);

  const lock = await acquireServiceLock(dataDir);
  try {
    assert.equal(lock.pid, process.pid);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), `${process.pid}\n`);
  } finally {
    await lock.release();
  }
});

test('a live pid in a current service lock is still rejected', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-service-lock-current-'));
  const lockPath = serviceLockPath(dataDir);
  const child = await startLiveProcess();
  t.after(async () => {
    await stopLiveProcess(child);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${dataDir}:`, error?.code ?? error);
    }
  });

  assert.ok(child.pid);
  assert.equal(child.exitCode, null);
  fs.writeFileSync(lockPath, `${child.pid}\n`);
  const currentMtimeSeconds = Date.now() / 1000;
  fs.utimesSync(lockPath, currentMtimeSeconds, currentMtimeSeconds);

  await assert.rejects(
    () => acquireServiceLock(dataDir),
    /is held by live pid/,
  );
});

test('an empty pid lock is treated as being created until its pid is written', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-river-service-lock-empty-pid-'));
  const lockPath = serviceLockPath(dataDir);
  const writer = await fs.promises.open(lockPath, 'wx');
  let writerOpen = true;
  let settled;
  const acquisition = acquireServiceLock(dataDir).then(
    (lock) => { settled = { lock }; return settled; },
    (error) => { settled = { error }; return settled; },
  );
  t.after(async () => {
    if (writerOpen) await writer.close().catch(() => {});
    if (settled?.lock) await settled.lock.release().catch(() => {});
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[test-teardown] best-effort rm failed for ${dataDir}:`, error?.code ?? error);
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  await writer.writeFile(`${process.pid}\n`, 'utf8');
  await writer.close();
  writerOpen = false;

  const result = await acquisition;
  assert.ok(result.error, 'a second process must wait for the first lock writer');
  assert.match(result.error.message, /held by live pid/);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), `${process.pid}\n`);
});

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
    // A contender can exit between the filter and send; the IPC write then fails with EPIPE.
    // Swallow that per-send error and don't wait for children that are already gone.
    for (const child of running) child.send('release', () => {});
    await Promise.all(running.map((child) => (child.exitCode !== null || child.signalCode !== null)
      ? undefined
      : new Promise((resolve) => child.once('exit', resolve))));
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
