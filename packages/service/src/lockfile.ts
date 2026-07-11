import { open, mkdir, readFile, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';

export interface ServiceLock {
  path: string;
  pid: number;
  release(): Promise<void>;
}

const TAKEOVER_STALE_MS = 10_000;

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

async function readTakeover(lockPath: string): Promise<{ pid: number | null; mtimeMs: number } | null> {
  try {
    const [raw, metadata] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    const pid = Number.parseInt(raw.trim(), 10);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      mtimeMs: metadata.mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
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
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${pid}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        pid,
        release: () => releaseServiceLock(dataDir, pid),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const existingPid = await readLockPid(lockPath);
    if (existingPid !== null && isPidAlive(existingPid)) {
      throw new Error(
        `mr-serve lockfile ${lockPath} is held by live pid ${existingPid}; ` +
        'stop that process or remove the lockfile if it is stale.',
      );
    }

    try {
      const handle = await open(takeoverPath, 'wx');
      try {
        await handle.writeFile(`${pid}\n`, 'utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const takeover = await readTakeover(takeoverPath);
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
      const currentPid = await readLockPid(lockPath);
      if (currentPid !== null && isPidAlive(currentPid)) {
        throw new Error(
          `mr-serve lockfile ${lockPath} is held by live pid ${currentPid}; ` +
          'stop that process or remove the lockfile if it is stale.',
        );
      }

      await rm(lockPath, { force: true });
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${pid}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        pid,
        release: () => releaseServiceLock(dataDir, pid),
      };
    } finally {
      await rm(takeoverPath, { force: true });
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
