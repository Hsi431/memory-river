#!/usr/bin/env node

import { configFromEnv, createRiverFromEnv } from '@memory-river/adapter-mcp';

import { listenMemoryRiverHttpService, type MemoryRiverHttpService } from './http.js';
import { acquireServiceLock, type ServiceLock } from './lockfile.js';

function portFromEnv(): number {
  const raw = process.env.MR_SERVE_PORT?.trim();
  if (!raw) return 4791;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`MR_SERVE_PORT must be an integer from 0 to 65535, got: ${raw}`);
  }
  return port;
}

async function main(): Promise<void> {
  const config = configFromEnv();
  let lock: ServiceLock | null = null;
  let stopping = false;
  let river: ReturnType<typeof createRiverFromEnv>['river'] | null = null;
  let service: MemoryRiverHttpService | null = null;

  const stop = async (exitCode?: number) => {
    if (stopping) return;
    stopping = true;
    await service?.close().catch(error => {
      console.error('[mr-serve] HTTP shutdown failed:', error);
    });
    await river?.stop().catch(error => {
      console.error('[mr-serve] river shutdown failed:', error);
    });
    await lock?.release().catch(error => {
      console.error('[mr-serve] lock cleanup failed:', error);
    });
    if (exitCode !== undefined) process.exit(exitCode);
  };

  // 訊號處理器必須在拿鎖之前掛好:反過來會留一個「lockfile 已存在、
  // SIGTERM 卻走預設終止」的空窗,行程被殺後殘留 stale lockfile。
  process.once('SIGINT', () => void stop(130));
  process.once('SIGTERM', () => void stop(143));

  try {
    lock = await acquireServiceLock(config.dataDir);
  } catch (error) {
    console.error('[mr-serve] lock failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  const created = createRiverFromEnv();
  river = created.river;
  const sessionKey = created.sessionKey;

  try {
    await river.start();
    service = await listenMemoryRiverHttpService({
      river,
      dataDir: config.dataDir,
      sessionKey,
      port: portFromEnv(),
    });
  } catch (error) {
    await stop();
    throw error;
  }

  console.error(`[mr-serve] listening on ${service.url}`);
}

main().catch(error => {
  console.error('[mr-serve] fatal:', error);
  process.exitCode = 1;
});
