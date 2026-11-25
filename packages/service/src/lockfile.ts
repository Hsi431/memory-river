import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ServiceLock {
  path: string;
  pid: number;
  release(): Promise<void>;
}

const TAKEOVER_STALE_MS = 10_000;
const BOOT_TIME_TOLERANCE_MS = 5_000;

export function serviceLockPath(dataDir: string): string {
  return path.join(dataDir, 'mr-serve.lock');
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readLockState(lockPath: string): Promise<{ pid: number | null; mtimeMs: number } | null> {
  let handle;
  try {
    handle = await open(lockPath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    const raw = await handle.readFile('utf8');
    const metadata = await handle.stat();
    const pid = Number.parseInt(raw.trim(), 10);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      mtimeMs: metadata.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

function isFromPreviousBoot(mtimeMs: number): boolean {
  const bootTimeMs = Date.now() - os.uptime() * 1000;
  return mtimeMs < bootTimeMs - BOOT_TIME_TOLERANCE_MS;
}

function waitForTakeover(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

export async function acquireServiceLock(
  dataDir: string,
  pid = process.pid,
): Promise<ServiceLock> {
  await mkdir(dataDir, { recursive: true });
  const lockPath = serviceLockPath(dataDir);
  const takeoverPath = `${lockPath}.takeover`;

  for (;;) {
    try {
      const handle = await open(takeoverPath, 'wx');
      try {
        await handle.writeFile(`${pid}\n`, 'utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const takeover = await readLockState(takeoverPath);
      if (takeover && (
        (takeover.pid !== null && isPidAlive(takeover.pid)) ||
        Date.now() - takeover.mtimeMs < TAKEOVER_STALE_MS
      )) {
        await waitForTakeover();
      } else if (takeover) {
        await rm(takeoverPath, { force: true });
      }
      continue;
    }

    try {
      let currentLock = await readLockState(lockPath);
      if (
        currentLock !== null && currentLock.pid === null &&
        Date.now() - currentLock.mtimeMs < TAKEOVER_STALE_MS
      ) {
        await waitForTakeover();
        currentLock = await readLockState(lockPath);
        if (
          currentLock !== null && currentLock.pid === null &&
          Date.now() - currentLock.mtimeMs < TAKEOVER_STALE_MS
        ) {
          continue;
        }
      }

      if (
        currentLock !== null && currentLock.pid !== null &&
        isPidAlive(currentLock.pid) && !isFromPreviousBoot(currentLock.mtimeMs)
      ) {
        throw new Error(
          `mr-serve lockfile ${lockPath} is held by live pid ${currentLock.pid}; ` +
          'stop that process or remove the lockfile if it is stale.',
        );
      }

      const temporaryPath = `${lockPath}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporaryPath, 'wx');
        try {
          await handle.writeFile(`${pid}\n`, 'utf8');
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, lockPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
      return {
        path: lockPath,
        pid,
        release: () => releaseServiceLock(dataDir, pid),
      };
    } finally {
      const takeover = await readLockState(takeoverPath);
      if (takeover?.pid === pid) await rm(takeoverPath, { force: true });
    }
  }
}

export async function releaseServiceLock(
  dataDir: string,
  pid = process.pid,
): Promise<void> {
  const lockPath = serviceLockPath(dataDir);
  try {
    const existingPid = await readLockPid(lockPath);
    if (existingPid !== pid) return;
    await rm(lockPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
