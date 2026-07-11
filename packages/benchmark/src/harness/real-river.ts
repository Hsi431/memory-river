/**
 * Real MemoryRiver factory for B2b (LoCoMo, full extraction pipeline).
 *
 * Drives the *shipped* memory-river pipeline end to end: real Ollama embeddings,
 * with a benchmark-only DeepSeek LlmClient injected for every ingestion-side
 * consumer. The answer judge is configured separately and remains on Gemini.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createMemoryRiver,
  type ContextMessage,
  type MemoryRiver,
} from '@memory-river/core';

import { createDeepSeekJudge as createDeepSeekIngestClient } from './deepseek-llm.js';
import { createRealEmbedder } from './real-embedder.js';
import { deepseekApiKey } from './provider-keys.js';

const benchmarkLogger = {
  info(message: string, meta?: unknown) {
    meta === undefined ? console.info(message) : console.info(message, meta);
  },
  warn(message: string, meta?: unknown) {
    meta === undefined ? console.warn(message) : console.warn(message, meta);
  },
  error(message: string, meta?: unknown) {
    meta === undefined ? console.error(message) : console.error(message, meta);
  },
};
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60000;
const MIN_SETTLE_MS = 10000;
const EMPTY_CONVERSATION_PLACEHOLDER_PATTERNS = [
  /對話內容為空/,
  /無法生成前情提要/,
  /沒有任何對話內容/,
  /沒有任何可供參考的前情提要/,
];

export function assertNoConcentrationPlaceholders(memoryTexts: string[]): void {
  const placeholderCount = memoryTexts.filter(text =>
    EMPTY_CONVERSATION_PLACEHOLDER_PATTERNS.some(pattern => pattern.test(text))
  ).length;
  if (placeholderCount === 0) return;

  throw new Error(
    'BenchmarkIngestionError: concentration produced empty-conversation placeholder(s) — ' +
    `${placeholderCount} of ${memoryTexts.length} memories are placeholders. ` +
    'Check harness message formatting.',
  );
}

export interface RealRiver {
  river: MemoryRiver;
  root: string;
  dataDir: string;
  forceCompactSession(
    sessionKey: string,
    messages: ContextMessage[],
  ): Promise<{ compacted: boolean; memoryCount: number }>;
  /** Copy the fully-ingested store tree to destDir for later restore. */
  snapshotTo(destDir: string): void;
  cleanup(): Promise<void>;
}

export interface ProviderUsageEvent {
  provider: 'gemini' | 'deepseek';
  promptTokens: number;
  completionTokens: number;
}

export function concentrationConfigured(): boolean {
  return !!deepseekApiKey();
}

export async function createRealMemoryRiver(
  onConcentrationUsage?: (event: ProviderUsageEvent) => void,
  restoreFrom?: string,
): Promise<RealRiver> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-bench-locomo-'));
  const dataDir = path.join(root, 'data');
  const ramDir = path.join(root, 'ram');
  const sessionDir = path.join(root, 'sessions');
  const inboxDir = path.join(dataDir, 'inbox');
  // Restore a previously-ingested snapshot (same model + conversation content) so
  // retrieval-side iterations skip the per-conversation DeepSeek ingest. start()
  // rehydrates RAM from the restored SSD store below.
  if (restoreFrom) fs.cpSync(restoreFrom, root, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  // The engine resolves rerankerCacheDir to <dataDir>/.model-cache (core
  // paths.ts). Benchmarks run in a fresh temp dataDir, so the cross-encoder
  // model is absent and BOTH the CRAG gate and coverage selection silently
  // no-op (logs: "cross-encoder gate unavailable; ... ONNX not found"). Link
  // the global HF cache in so the offline model resolves like it does live.
  const hfCache = process.env.TRANSFORMERS_CACHE
    ?? process.env.HF_HOME
    ?? path.join(os.homedir(), '.cache', 'huggingface');
  const modelCacheLink = path.join(dataDir, '.model-cache');
  if (fs.existsSync(hfCache) && !fs.existsSync(modelCacheLink)) {
    fs.symlinkSync(hfCache, modelCacheLink, 'dir');
  }
  fs.mkdirSync(ramDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPaths = new Map<string, string>();
  const deepseekKey = deepseekApiKey();
  // ingest LLM (concentration/hooks/entities) is pinned to cheap flash via the
  // MR_INGEST_* envs so it never burns an expensive answerer model (gpt-on-proxy).
  const ingestLlm = createDeepSeekIngestClient(usage => {
    onConcentrationUsage?.({ provider: 'deepseek', ...usage });
  }, { ingest: true });

  const river = createMemoryRiver(
    {
      dataDir,
      ramDir,
      concentration: {
        deepseekApiKey: deepseekKey,
        deepseekModel: process.env.MR_INGEST_MODEL ?? 'deepseek-v4-flash',
        maxTokens: 8192,
      } as any,
    },
    {
      embedder: createRealEmbedder(),
      llm: ingestLlm,
      logger: benchmarkLogger,
      sessionFiles: {
        resolveSessionFile(identity) {
          const key = identity.sessionKey ?? identity.sessionId;
          return key ? sessionPaths.get(key) ?? null : null;
        },
      },
    },
  );
  await river.start();

  async function waitForMemoryStability(): Promise<string[]> {
    const startedAt = Date.now();
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let previousCount = -1;
    let stablePolls = 0;
    let memoryTexts: string[] = [];
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      const memories = (await river.recall('conversation people events dates preferences', 1000))
        .filter(result => result.entry.text !== '_SYSTEM_INIT_');
      const uniqueMemories = new Map(memories.map(result => [result.entry.id, result.entry.text]));
      const count = uniqueMemories.size;
      memoryTexts = [...uniqueMemories.values()];
      stablePolls = count === previousCount ? stablePolls + 1 : 0;
      const inboxBusy = fs.existsSync(inboxDir) &&
        fs.readdirSync(inboxDir).some(name => name !== 'error');
      const settledLongEnough = Date.now() - startedAt >= MIN_SETTLE_MS;
      if (!inboxBusy && settledLongEnough && stablePolls >= 2) return memoryTexts;
      previousCount = count;
    }
    return memoryTexts;
  }

  return {
    river,
    root,
    dataDir,
    async forceCompactSession(sessionKey, messages) {
      // Archive the raw transcript FIRST, under the SAME key and with the SAME
      // timestamped messages that compaction will see. This is what lets the
      // concentrator's sourceEntryIds probe align (count + text + timestamp) and
      // attach entryId back-pointers; without it the probe reports archive_lag.
      await river.archiveTranscript({ sessionKey, sessionId: sessionKey }, messages);

      const sessionPath = path.join(sessionDir, `${sessionKey}.jsonl`);
      sessionPaths.set(sessionKey, sessionPath);
      const lines = [
        JSON.stringify({ type: 'session', sessionKey }),
        ...messages.map(message => JSON.stringify({ type: 'message', message })),
      ];
      fs.writeFileSync(sessionPath, `${lines.join('\n')}\n`, 'utf8');
      const result = await river.compactSessionFile({ sessionKey, sessionId: sessionKey });
      const memoryTexts = await waitForMemoryStability();
      assertNoConcentrationPlaceholders(memoryTexts);
      return { compacted: result.compacted, memoryCount: memoryTexts.length };
    },
    snapshotTo(destDir) {
      // Ingest has settled (waitForMemoryStability drained the inbox) so the
      // on-disk store is quiescent and safe to copy verbatim.
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.rmSync(destDir, { recursive: true, force: true });
      const snapshotInboxDir = path.join(root, 'data', 'inbox');
      fs.cpSync(root, destDir, {
        recursive: true,
        filter: src => src !== snapshotInboxDir && !src.startsWith(snapshotInboxDir + path.sep),
      });
    },
    async cleanup() {
      await river.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
