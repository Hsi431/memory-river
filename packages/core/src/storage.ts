import * as fs from 'node:fs';
import * as path from 'node:path';

export type StorageMode = 'auto' | 'ram' | 'ssd';

export const MIN_RAM_DB_BYTES = 512 * 1024 * 1024;

export interface RamDbPathResolutionOptions {
  dbPath: string;
  ramDbPath: string;
  storageMode?: StorageMode;
  getShmFreeBytes?: () => number;
  getDbSizeBytes?: (dbPath: string) => number;
  log?: (message: string) => void;
}

export interface RamDbPathResolution {
  ramDbPath: string;
  mode: 'ram' | 'ssd-fallback';
  requiredBytes?: number;
  availableBytes?: number;
  reason?: string;
}

function directorySizeBytes(dir: string): number {
  try {
    const metadata = fs.statSync(dir);
    if (metadata.isFile()) return metadata.size;
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) total += directorySizeBytes(entryPath);
      else if (entry.isFile()) total += fs.statSync(entryPath).size;
    }
    return total;
  } catch {
    return 0;
  }
}

export function getDevShmFreeBytes(): number {
  try {
    const stats = fs.statfsSync('/dev/shm');
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return 0;
  }
}

export function resolveRamDbPath(options: RamDbPathResolutionOptions): RamDbPathResolution {
  const storageMode = options.storageMode ?? 'auto';
  if (storageMode === 'ram') return { ramDbPath: options.ramDbPath, mode: 'ram' };
  if (storageMode === 'ssd') {
    return { ramDbPath: options.dbPath, mode: 'ssd-fallback', reason: 'storageMode=ssd' };
  }

  const existingDbBytes = (options.getDbSizeBytes ?? directorySizeBytes)(options.dbPath);
  const requiredBytes = Math.max(MIN_RAM_DB_BYTES, existingDbBytes * 2);
  const availableBytes = (options.getShmFreeBytes ?? getDevShmFreeBytes)();
  if (availableBytes >= requiredBytes) {
    return { ramDbPath: options.ramDbPath, mode: 'ram', requiredBytes, availableBytes };
  }

  const reason = `/dev/shm has ${availableBytes} bytes free; ${requiredBytes} bytes required`;
  (options.log ?? console.warn)(
    `[memory-river] RAM storage disabled: ${reason}. Using SSD fallback; set storageMode=ram to override.`,
  );
  return {
    ramDbPath: options.dbPath,
    mode: 'ssd-fallback',
    requiredBytes,
    availableBytes,
    reason,
  };
}
