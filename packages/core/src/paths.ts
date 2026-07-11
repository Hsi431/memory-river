import { join } from 'node:path';

export interface MemoryRiverPaths {
  dataDir: string;        // 一切持久化的根目錄，由宿主 adapter 決定
  ramDir?: string | null; // tmpfs 加速層；null = 停用 RAM 層，直接讀寫 SSD
}
export function resolvePaths(p: MemoryRiverPaths) {
  return {
    dbDir:            join(p.dataDir, 'lancedb'),
    ramDbDir:         p.ramDir ?? null,
    inboxDir:         join(p.dataDir, 'inbox'),
    walFile:          join(p.dataDir, 'wal.jsonl'),
    transcriptsDir:   join(p.dataDir, 'transcripts'),
    trashDir:         join(p.dataDir, '.trash'),
    stateDir:         join(p.dataDir, 'state'),          // cleanup-state.json
    gwmStateFile:     join(p.dataDir, 'global-working-memory.json'),
    consolidationLog: join(p.dataDir, 'consolidation-log.jsonl'),
    sessionSummaryDir:join(p.dataDir, 'session-summaries'),
    rerankerCacheDir: join(p.dataDir, '.model-cache'),    // 原 ~/.cache/huggingface
  };
}
