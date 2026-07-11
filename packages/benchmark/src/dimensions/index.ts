import { runCragBenchmark } from './crag.js';
import { runEvidenceBenchmark } from './evidence.js';
import { runLifecycleBenchmark } from './lifecycle.js';
import { runLocomoBenchmark } from './locomo.js';
import { runRecoveryBenchmark } from './recovery.js';
import { runRetrievalBenchmark } from './retrieval.js';
import { runZhChatBenchmark } from './zh-chat.js';

export interface BenchmarkOptions {
  limit?: number;
  maxQuestions?: number;
  /** Only run questions of this LoCoMo category (1-5). Applied before the maxQuestions slice. */
  category?: number;
  judgeAll?: boolean;
  sample?: number;
  seed?: number;
  /** Reuse/persist per-conversation ingested stores under this dir to skip re-ingest. */
  snapshotDir?: string;
  /** Force re-ingest and overwrite snapshots (use after a distill-side code change). */
  rebuildSnapshot?: boolean;
  onProgress?(result: import('../report.js').BenchmarkResult): void;
}

export const dimensions = {
  lifecycle: (_options?: BenchmarkOptions) => runLifecycleBenchmark(),
  evidence: (_options?: BenchmarkOptions) => runEvidenceBenchmark(),
  recovery: (_options?: BenchmarkOptions) => runRecoveryBenchmark(),
  retrieval: runRetrievalBenchmark,
  crag: runCragBenchmark,
  locomo: runLocomoBenchmark,
  'zh-chat': runZhChatBenchmark,
};

export type DimensionName = keyof typeof dimensions;
