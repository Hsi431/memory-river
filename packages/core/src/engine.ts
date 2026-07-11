import * as fs from 'fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { MemoryStore } from './store/store-v4.js';
import { Embedder } from './providers/embedder-v5.js';
import { Retriever, type HybridSearchResponse } from './retrieval/retriever-v4.js';
import { CausalEngine } from './cognition/causal-engine.js';
import { CausalAttributionEngine, type InjectedMemory } from './cognition/causal-attribution.js';
import { HooksEngine } from './cognition/hooks-engine.js';
import { GraphStore } from './store/graph-store.js';
import { GraphEnumerator } from './store/graph-enumerator.js';
import { InboxWatcher } from './pipeline/inbox-watcher.js';
import { ConflictDetector } from './cognition/conflict-detector.js';
import { StatusManager } from './store/status-manager.js';
import { CapsuleBridge } from './pipeline/capsule-bridge.js';
import { ConcentratorAdapter } from './distill/concentrator-adapter.js';
import { GlobalWorkingMemory, type DriftResult } from './cognition/global-working-memory.js';
import { CleanupEngine } from './lifecycle/cleanup-engine.js';
import {
  chooseStartupRecoveryMode,
  readCleanupState,
  shouldRunStartupRecovery,
  writeCleanupState,
  type CleanupState,
  type StartupRecoveryLimits,
} from './lifecycle/cleanup-state.js';
import { NightConsolidator } from './lifecycle/night-consolidation.js';
import type { ArchiveSnapshotResult } from './transcript/transcript-archive.js';
import { setBoundedMapEntry } from './util/bounded-map.js';

// ── Ralph Loop 核心組件 (搬移至 src 並轉為 .ts 後的引用路徑) ──────────────────
import { trimTailErrors, generateWarning, extractGoalFromMsgs, RalphState } from './cognition/ralph-core.js';

import {
  type PluginConfig,
  type ContextMessage,
  type EnumerationPlan,
  type MemoryEntry,
  type MemorySearchResult,
  type SkillCapsuleV2,
  type SkillDef,
  type SkillIndexEntry,
  type StatusChangeRequest,
  type StatusChangeResult,
  type SubsystemEffectivenessEvent,
} from './types.js';
import { validateSkillDef } from './skills/validate.js';
import type { EmbeddingProvider, LlmClient, Logger } from './ports.js';

import {
  resolveSessionIdentity,
  resolveSessionIdentityFromArgs,
  setFallbackObserver,
  GLOBAL_FALLBACK_KEY,
  type SessionIdentity,
} from './util/session-identity.js';
import {
  type AsyncCompactRequest,
  type CompactRequestInboxItem,
  writeCompactRequest,
} from './pipeline/compact-request.js';
import {
  buildNightRecoveryMetadata,
  healthCheck as runNightRecoveryHealthCheck,
  type NightRecoverySource,
} from './lifecycle/night-recovery.js';
import { hashQuery } from './util/util-hash.js';

export interface MemoryRiverEngineDeps {
  paths: {
    rerankerCacheDir: string;
    consolidationLog: string;
    stateDir: string;
    walFile: string;
    sessionSummaryDir: string;
    trashDir: string;
    gwmStateFile: string;
  };
  transcriptArchive: {
    archiveSnapshot: any;
    clearTranscriptCache: () => void;
  };
  notifier?: import('./ports.js').Notifier;
  embedder?: EmbeddingProvider;
  llm?: LlmClient;
  logger?: Logger;
  deriveSessionFile(args: { sessionId?: string; sessionKey?: string }): string | null;
  ollamaUrl: string;
  geminiApiKey: string;
  deepseekApiKey: string;
}

type SessionFileMappingRecord = { trackingKey: string; sessionKey?: string; sessionId?: string; sessionFile: string; updatedAt: number; source: 'maintain' | 'compact' | 'fallback' };
type PendingAttributionRecord = { injected: InjectedMemory[]; keys: string[]; createdAt: number };
type RecentLlmIdentity = { model: string | null; provider: string | null; updatedAt: number };
type GwmPendingEpisode = { episodeId: string; injectionOrdinal: number; queryHash: string; similarityAtInjection: number; preInjectDriftRoundCount: number | null; roundsSinceLastInjection: number | null; taskDescriptionHash: string; llmModel: string | null; llmProvider: string | null };
type GwmSessionEpisodeState = { injectionCount: number; turnIndex: number; lastInjectionTurnIndex: number | null; pendingEpisode: GwmPendingEpisode | null };
type FrameworkMetadataMatch = 'conversation_info' | 'run_aborted' | 'media_attached' | 'system_tag' | 'metadata_tag';
const SESSION_WATERMARK_MAX = 500;
const WATERMARK_INTERVAL = 20000;
const RECENT_COMPACT_TTL_MS = 60_000;
const NIGHT_HEALTH_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const NIGHT_STARTUP_RECOVERY_DELAY_MS = 5000;
const PENDING_ATTRIBUTION_MAX_KEYS = 100;
const PENDING_ATTRIBUTION_TTL_MS = 30 * 60 * 1000;

export class MemoryRiverEngine {
  constructor(private config: Required<PluginConfig>, private deps: MemoryRiverEngineDeps) {
    this.activePluginConfig = config;
  }

  configure(config: Required<PluginConfig>, deps: MemoryRiverEngineDeps): void {
    this.config = config;
    this.deps = deps;
    this.activePluginConfig = config;
    this.isAutoRecallEnabled = config.autoRecall;
    if (!this.embedderRef) {
      this.embedderRef = deps.embedder
        ? deps.embedder as Embedder
        : new Embedder({
            ...config.embedding,
            ollamaUrl: deps.ollamaUrl,
          });
    }
    const embedder = this.embedderRef;
    if (!this.memoryStoreRef) {
      this.memoryStoreRef = new MemoryStore(
        config.dbPath,
        config.ramDbPath,
        config.embedding.dimensions!,
        deps.paths.walFile,
        config.health as any,
        embedder,
      );
    }
    const store = this.memoryStoreRef;
    if (!this.statusManagerRef) this.statusManagerRef = new StatusManager(store);
    if (!this.fallbackObserverRegistered) {
      setFallbackObserver(() => {
        if (!this.memoryStoreRef) return;
        void this.memoryStoreRef.recordConcentratorStat({
          canonicalKey: GLOBAL_FALLBACK_KEY,
          sessionId: null,
          provider: 'all_failed',
          outcome: 'failure',
          attemptedProviders: '[]',
          inputTokens: 0,
          outputTokens: null,
          durationMs: 0,
          failureReason: 'other',
          createdAt: Date.now(),
        }).catch((err: any) => {
          console.warn('[memory-river] Failed to write session_identity_fallback stat:', err?.message ?? err);
        });
      });
      this.fallbackObserverRegistered = true;
    }
    if (!this.activeConcentrator) {
      this.activeConcentrator = new ConcentratorAdapter({
        apiKey: config.concentration?.geminiApiKey || config.embedding.apiKey || deps.geminiApiKey,
        model: config.concentration?.model || 'gemini-2.5-flash-lite',
        inboxPath: config.inboxPath,
        provider: config.concentration?.provider || 'gemini',
        maxTokens: config.concentration?.maxTokens ?? 8192,
        deepseekApiKey: config.concentration?.deepseekApiKey || deps.deepseekApiKey,
        deepseekModel: config.concentration?.deepseekModel || 'deepseek-v4-flash',
        statsStore: store,
        transcriptArchive: deps.transcriptArchive as any,
        sessionSummaryDir: deps.paths.sessionSummaryDir,
        llm: deps.llm,
      });
    }
    if (!this.causalEngineRef) this.causalEngineRef = new CausalEngine(store, embedder, config.causalEngine);
    if (!this.conflictDetectorRef) {
      this.conflictDetectorRef = new ConflictDetector(store, embedder, this.activeConcentrator, this.statusManagerRef!);
    }
    if (!this.inboxWatcherRef) {
      this.inboxWatcherRef = new InboxWatcher(
        store,
        embedder,
        this.causalEngineRef,
        null,
        null,
        this.activeConcentrator,
        config.inboxPath,
        2000,
        this.conflictDetectorRef,
        this.statusManagerRef!,
        (req) => this.processAsyncCompactRequest(req),
      );
    }
    if (!this.capsuleBridgeRef) this.capsuleBridgeRef = new CapsuleBridge(config.inboxPath);
    if (!this.gwmRef) this.gwmRef = new GlobalWorkingMemory(embedder, deps.paths.gwmStateFile, config.driftThreshold);
    if (!this.cleanupEngineRef) {
      this.cleanupEngineRef = new CleanupEngine(store, {
        enabled: config.cleanupEngine?.enabled ?? config.cleanup?.enabled ?? true,
        decayDays: config.cleanupEngine?.decayDays ?? config.cleanup?.decayDays ?? 7,
        deleteBelow: config.cleanupEngine?.deleteBelow ?? config.cleanup?.deleteBelow ?? 10,
        coreCategories: config.cleanupEngine?.coreCategories ?? config.cleanupEngine.coreCategories,
        coreImportanceThreshold: config.cleanupEngine?.coreImportanceThreshold ?? config.cleanupEngine.coreImportanceThreshold,
        skillCapsuleProtection: config.cleanupEngine?.skillCapsuleProtection ?? config.cleanupEngine.skillCapsuleProtection,
        useTrash: config.cleanupEngine?.useTrash ?? config.cleanupEngine.useTrash,
        dryRun: config.cleanupEngine?.dryRun ?? config.cleanupEngine.dryRun,
        trashPath: deps.paths.trashDir,
        trashRetentionDays: config.cleanupEngine?.trashRetentionDays ?? config.cleanup?.trashRetentionDays ?? 7,
        enableTrashAutoPurge: true,
      });
    }
    if (!this.cleanupEngineInstanceRegistered) {
      CleanupEngine.setInstance(this.cleanupEngineRef);
      this.cleanupEngineInstanceRegistered = true;
    }
  }
  private activeConcentrator: ConcentratorAdapter | null = null;
  private retrieverRef: Retriever | null = null;
  private isAutoRecallEnabled: boolean = false;
  private gwmRef: GlobalWorkingMemory | null = null;
  private cleanupEngineRef: CleanupEngine | null = null;
  private nightConsolidatorRef: NightConsolidator | null = null;
  private memoryStoreRef: MemoryStore | null = null;
  private embedderRef: Embedder | null = null;
  private hooksEngineRef: HooksEngine | null = null;
  private graphStoreRef: GraphStore | null = null;
  private inboxWatcherRef: InboxWatcher | null = null;
  private causalEngineRef: CausalEngine | null = null;
  private conflictDetectorRef: ConflictDetector | null = null;
  private statusManagerRef: StatusManager | null = null;
  private capsuleBridgeRef: CapsuleBridge | null = null;
  private pluginInitPromise: Promise<void> | null = null;
  private pluginInitialized = false;
  private pluginInitError: any = null;
  private fallbackObserverRegistered = false;
  private cleanupEngineInstanceRegistered = false;
  private nightTimerId: ReturnType<typeof setTimeout> | null = null;
  private nightIntervalId: ReturnType<typeof setInterval> | null = null;
  private nightHealthCheckIntervalId: ReturnType<typeof setInterval> | null = null;
  private nightStartupRecoveryTimerId: ReturnType<typeof setTimeout> | null = null;
  private nightConsolidatorIsRunning = false;
  private lastNightConsolidatorSuccessfulRunAt = 0;
  private cleanupTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastCleanupSuccessfulRunAt = 0;
  private activePluginConfig!: PluginConfig;

  initFailedResult(err: any) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: `❌ MEMORY_RIVER_INIT_FAILED: ${message}` }],
    isError: true,
  };
}

  async recordPluginInitSmokeStat(
  store: any,
  outcome: 'succeeded' | 'failed',
  err?: any,
): Promise<void> {
  try {
    const recordSubsystemEffectiveness = store?.recordSubsystemEffectiveness;
    if (typeof recordSubsystemEffectiveness !== 'function') return;
    const errorMessage = err instanceof Error ? err.message : err ? String(err) : '';
    await recordSubsystemEffectiveness.call(store, {
      subsystem: 'plugin',
      event: 'init_completed',
      outcome,
      metadata: outcome === 'failed' ? { error: errorMessage } : {},
    });
  } catch (statErr: any) {
    console.warn('[memory-river] Failed to write plugin init smoke stat:', statErr?.message ?? statErr);
  }
}

  private sessionTokenWatermark = new Map<string, number>();
  private sessionCompactWatermark = new Map<string, number>();
  private sessionFileMappings = new Map<string, SessionFileMappingRecord>();
  private recentlyCompacted = new Map<string, number>();

  private lastArchivedLineCount = new Map<string, { sessionId: string | null; lineCount: number }>();

  private maintainLocks = new Map<string, Promise<void>>();
  private skillLocks = new Map<string, Promise<unknown>>();

  private queuedAsyncCompactKeys = new Set<string>();
  private runningAsyncCompactKeys = new Set<string>();
  private pendingAttribution = new Map<string, PendingAttributionRecord>();
  private recentLlmIdentityByKey = new Map<string, RecentLlmIdentity>();
  private gwmSessionState = new Map<string, GwmSessionEpisodeState>();
  private lastObservedSessionIdentity: SessionIdentity | null = null;

  pickNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

  addAttributionKey(keys: Set<string>, prefix: string, value: unknown): void {
  const str = this.pickNonEmptyString(value);
  if (str) keys.add(`${prefix}:${str}`);
}

  extractAttributionRequestKeyFromArgs(...args: unknown[]): string | null {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue;
    const obj = arg as Record<string, unknown>;
    const requestId = this.pickNonEmptyString(obj.requestId);
    if (requestId) return `request:${requestId}`;
    const runId = this.pickNonEmptyString(obj.runId);
    if (runId) return `run:${runId}`;
  }
  return null;
}

  extractAutoRecallResultsObserverFromArgs(...args: unknown[]): ((event: { query: string; results: MemorySearchResult[] }) => void) | null {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue;
    const candidate = (arg as Record<string, unknown>).onAutoRecallResults;
    if (typeof candidate === 'function') {
      return candidate as (event: { query: string; results: MemorySearchResult[] }) => void;
    }
  }
  return null;
}

  attributionKeysFromIdentity(identity: SessionIdentity, requestKey?: string | null): string[] {
  const keys = new Set<string>();
  if (requestKey) keys.add(requestKey);
  this.addAttributionKey(keys, 'canonical', identity.canonicalKey);
  this.addAttributionKey(keys, 'sessionKey', identity.sessionKey);
  this.addAttributionKey(keys, 'sessionId', identity.sessionId);
  return [...keys];
}

  attributionKeysFromLlmOutput(event: any, ctx: any): string[] {
  const keys = new Set<string>();
  this.addAttributionKey(keys, 'request', event?.requestId ?? ctx?.requestId);
  this.addAttributionKey(keys, 'run', event?.runId ?? ctx?.runId);
  this.addAttributionKey(keys, 'sessionId', event?.sessionId ?? ctx?.sessionId);
  this.addAttributionKey(keys, 'sessionKey', event?.sessionKey ?? ctx?.sessionKey);
  this.addAttributionKey(keys, 'canonical', ctx?.sessionKey ?? event?.sessionKey ?? ctx?.sessionId ?? event?.sessionId);
  return [...keys];
}

  getRecentLlmIdentityForKeys(keys: string[]): RecentLlmIdentity | null {
  for (const key of keys) {
    const identity = this.recentLlmIdentityByKey.get(key);
    if (identity) return identity;
  }
  return null;
}

  getOrCreateGwmSessionState(sessionKey: string): GwmSessionEpisodeState {
  let state = this.gwmSessionState.get(sessionKey);
  if (!state) {
    state = {
      injectionCount: 0,
      turnIndex: 0,
      lastInjectionTurnIndex: null,
      pendingEpisode: null,
    };
    this.gwmSessionState.set(sessionKey, state);
  }
  return state;
}

  cleanupPendingAttribution(now = Date.now()): void {
  for (const record of new Set(this.pendingAttribution.values())) {
    if (now - record.createdAt <= PENDING_ATTRIBUTION_TTL_MS) continue;
    for (const key of record.keys) this.pendingAttribution.delete(key);
  }
  while (this.pendingAttribution.size > PENDING_ATTRIBUTION_MAX_KEYS) {
    const oldest = this.pendingAttribution.values().next().value;
    if (!oldest) break;
    for (const key of oldest.keys) this.pendingAttribution.delete(key);
  }
}

  rememberInjectedMemories(
  identity: SessionIdentity,
  injected: InjectedMemory[],
  requestKey?: string | null,
): void {
  if (injected.length === 0) return;
  this.cleanupPendingAttribution();
  const keys = this.attributionKeysFromIdentity(identity, requestKey);
  if (keys.length === 0) return;
  const record: PendingAttributionRecord = {
    injected,
    keys,
    createdAt: Date.now(),
  };
  for (const key of keys) this.pendingAttribution.set(key, record);
  this.cleanupPendingAttribution();
}

  takePendingAttribution(keys: string[]): InjectedMemory[] {
  this.cleanupPendingAttribution();
  for (const key of keys) {
    const record = this.pendingAttribution.get(key);
    if (!record) continue;
    for (const alias of record.keys) this.pendingAttribution.delete(alias);
    return record.injected;
  }
  return [];
}

  getAsyncCompactConcurrency(): number {
  return Math.max(1, this.activePluginConfig.concentration?.asyncCompactConcurrency ?? 1);
}

  async countFileLines(filePath: string): Promise<number> {
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  if (!raw.trim()) return 0;
  return raw.trim().split('\n').filter(Boolean).length;
}

  enqueueAsyncCompact(req: AsyncCompactRequest): void {
  if (this.queuedAsyncCompactKeys.has(req.trackingKey) || this.runningAsyncCompactKeys.has(req.trackingKey)) {
    console.log(`[asyncCompact] skipped duplicate trackingKey=${req.trackingKey}`);
    return;
  }
  this.queuedAsyncCompactKeys.add(req.trackingKey);

  const item: CompactRequestInboxItem = {
    type: 'compact_request',
    version: 1,
    requestId: randomUUID(),
    trackingKey: req.trackingKey,
    sessionId: req.sessionId,
    sessionKey: req.sessionKey,
    originalTokens: req.originalTokens,
    compressedTokens: req.compressedTokens,
    createdAt: req.timestamp,
    source: 'asyncCompactAfterAssemble',
  };

  const inboxPath = this.activePluginConfig?.inboxPath;
  if (!inboxPath) {
    console.warn(`[asyncCompact] no inboxPath configured, dropping trackingKey=${req.trackingKey}`);
    this.queuedAsyncCompactKeys.delete(req.trackingKey);
    return;
  }

  const t0 = Date.now();
  void writeCompactRequest(inboxPath, item)
    .then((filePath) => {
      console.log(`[asyncCompact] persisted trackingKey=${req.trackingKey} requestId=${item.requestId} writeMs=${Date.now() - t0} path=${filePath}`);
    })
    .catch((err) => {
      console.error(`[asyncCompact] failed to persist trackingKey=${req.trackingKey}:`, err);
      this.queuedAsyncCompactKeys.delete(req.trackingKey);
    });
}

  async processAsyncCompactRequest(req: AsyncCompactRequest): Promise<void> {
  this.runningAsyncCompactKeys.add(req.trackingKey);
  try {
    const resolved = this.resolveSessionFile({
      sessionKey: req.sessionKey,
      sessionId: req.sessionId,
    });

    if (!resolved.sessionFile) {
      console.warn(`[asyncCompact] no sessionFile, skip trackingKey=${req.trackingKey}`);
      return;
    }

    console.log(`[asyncCompact] processing trackingKey=${req.trackingKey}`);

    const statBefore = await fs.promises.stat(resolved.sessionFile);
    const lineCountBefore = await this.countFileLines(resolved.sessionFile);

    const compactResult = await this.compact({
      sessionId: req.sessionId,
      sessionKey: req.sessionKey,
      sessionFile: resolved.sessionFile,
      expectedLineCount: lineCountBefore,
      expectedSize: statBefore.size,
      expectedMtime: statBefore.mtimeMs,
      source: 'asyncCompactAfterAssemble',
      force: true,
    });

    if (compactResult?.aborted) {
      console.warn(`[asyncCompact] race detected trackingKey=${req.trackingKey} reason=${compactResult.reason ?? 'unknown'}`);
      return;
    }

    if (!compactResult?.ok || !compactResult?.compacted) {
      console.warn(`[asyncCompact] failed trackingKey=${req.trackingKey} error=${compactResult?.reason ?? 'compact-returned-no-result'}`);
      return;
    }

    const statAfter = await fs.promises.stat(resolved.sessionFile);
    const lineCountAfter = await this.countFileLines(resolved.sessionFile);
    console.log(`[asyncCompact] success trackingKey=${req.trackingKey} compressedTokens=${req.compressedTokens} newSessionFileLines=${lineCountAfter} size=${statAfter.size}`);
  } finally {
    this.queuedAsyncCompactKeys.delete(req.trackingKey);
    this.runningAsyncCompactKeys.delete(req.trackingKey);
  }
}

  get asyncCompactTestHooks() {
    return {
      enqueue: (req: AsyncCompactRequest) => this.enqueueAsyncCompact(req),
      reset: (): void => {
        this.queuedAsyncCompactKeys.clear();
        this.runningAsyncCompactKeys.clear();
        this.activePluginConfig = this.config;
      },
      setInboxPath: (inboxPath: string): void => {
        this.activePluginConfig = {
          ...this.activePluginConfig,
          inboxPath,
        };
      },
      isQueued: (trackingKey: string): boolean => this.queuedAsyncCompactKeys.has(trackingKey),
    };
  }

  setWatermark(canonicalKey: string, value: number): void {
  setBoundedMapEntry(this.sessionTokenWatermark, canonicalKey, value, SESSION_WATERMARK_MAX);
}

  setCompactWatermark(canonicalKey: string, value: number): void {
  setBoundedMapEntry(this.sessionCompactWatermark, canonicalKey, value, SESSION_WATERMARK_MAX);
}

  setSessionFileMapping(canonicalKey: string, record: SessionFileMappingRecord): void {
  setBoundedMapEntry(this.sessionFileMappings, canonicalKey, record, SESSION_WATERMARK_MAX);
}

  setArchivedLineCount(key: string, sessionId: string | null, lineCount: number): void {
  setBoundedMapEntry(this.lastArchivedLineCount, key, { sessionId, lineCount }, SESSION_WATERMARK_MAX);
}

  async resolveArchivedLineCount(
  store: MemoryStore | null,
  canonicalKey: string,
  sessionId: string | null,
): Promise<{ sessionId: string | null; lineCount: number }> {
  const cached = this.lastArchivedLineCount.get(canonicalKey);
  if (cached !== undefined && cached.sessionId === sessionId) return cached;
  if (!store) return { sessionId: null, lineCount: 0 };

  try {
    const row = await store.getTranscriptWatermark(canonicalKey);
    if (!row) return { sessionId: null, lineCount: 0 };
    this.setArchivedLineCount(canonicalKey, row.sessionId, row.lineCount);
    return { sessionId: row.sessionId, lineCount: row.lineCount };
  } catch (err) {
    console.warn(`[memory-river] Failed to read transcript watermark canonicalKey=${canonicalKey}:`, err);
    return { sessionId: null, lineCount: 0 };
  }
}

  async persistArchivedLineCount(
  store: MemoryStore | null,
  canonicalKey: string,
  sessionId: string | null,
  lineCount: number,
): Promise<void> {
  if (store) {
    try {
      await store.setTranscriptWatermark(canonicalKey, sessionId, lineCount);
    } catch (err) {
      console.warn(`[memory-river] Failed to write transcript watermark canonicalKey=${canonicalKey}:`, err);
    }
  }
  this.setArchivedLineCount(canonicalKey, sessionId, lineCount);
}

  markRecentlyCompacted(canonicalKey: string): void {
  const now = Date.now();
  for (const [key, timestamp] of this.recentlyCompacted) {
    if (now - timestamp > RECENT_COMPACT_TTL_MS) {
      this.recentlyCompacted.delete(key);
    }
  }
  if (this.recentlyCompacted.size >= SESSION_WATERMARK_MAX && !this.recentlyCompacted.has(canonicalKey)) {
    const oldest = this.recentlyCompacted.keys().next().value;
    if (oldest !== undefined) this.recentlyCompacted.delete(oldest);
  }
  this.recentlyCompacted.set(canonicalKey, now);
}

  wasRecentlyCompacted(canonicalKey: string): boolean {
  const timestamp = this.recentlyCompacted.get(canonicalKey);
  if (!timestamp) return false;
  if (Date.now() - timestamp > RECENT_COMPACT_TTL_MS) {
    this.recentlyCompacted.delete(canonicalKey);
    return false;
  }
  return true;
}

  deriveSessionFileFromStaticRule(args: { sessionId?: string; sessionKey?: string }): string | null {
    return this.deps.deriveSessionFile(args);
  }

  resolveSessionFile(args: {
  sessionKey?: string;
  sessionId?: string;
  session?: any;
}): { sessionFile: string | null; source: 'cache' | 'fallback' | 'none' } {
  const identity = resolveSessionIdentity(args);
  const cached = this.sessionFileMappings.get(identity.canonicalKey);
  if (cached?.sessionFile) {
    return { sessionFile: cached.sessionFile, source: 'cache' };
  }

  const fallbackPath = this.deriveSessionFileFromStaticRule({
    sessionId: identity.sessionId ?? undefined,
    sessionKey: identity.sessionKey ?? undefined,
  });
  if (fallbackPath) {
    return { sessionFile: fallbackPath, source: 'fallback' };
  }

  return { sessionFile: null, source: 'none' };
}

  init(): Promise<void> {
  if (this.pluginInitPromise) {
    if (this.pluginInitialized && this.nightConsolidatorRef && !this.nightTimerId && !this.nightIntervalId) {
      this.scheduleNightConsolidator();
    }
    if (this.pluginInitialized && this.cleanupEngineRef && !this.cleanupTimeoutId && !this.cleanupIntervalId) {
      this.scheduleCleanupEngine();
    }
    return this.pluginInitPromise;
  }

  this.pluginInitPromise = (async () => {
    if (!this.memoryStoreRef || !this.embedderRef || !this.activeConcentrator) {
      throw new Error('memory-river 初始化前置依賴缺失');
    }

    await this.memoryStoreRef.ensureInitialized();

    this.graphStoreRef = new GraphStore(this.memoryStoreRef.db, this.memoryStoreRef.ssd, this.embedderRef, this.config.embedding.dimensions);
    this.hooksEngineRef = new HooksEngine(this.memoryStoreRef, this.embedderRef, this.config.hooks ?? {}, this.activeConcentrator, this.memoryStoreRef.db);
    this.hooksEngineRef.setGraphStore(this.graphStoreRef);
    await this.hooksEngineRef.loadStats();

    this.retrieverRef = new Retriever(this.memoryStoreRef, this.embedderRef, this.config.retrieval, this.deps.paths.rerankerCacheDir, this.hooksEngineRef);
    if (this.inboxWatcherRef && this.hooksEngineRef && this.graphStoreRef) {
      this.inboxWatcherRef.setDependencies(this.hooksEngineRef, this.graphStoreRef);
    }

    if (this.gwmRef) {
      await this.gwmRef.load();
    }

    if (!this.nightConsolidatorRef) {
      this.nightConsolidatorRef = new NightConsolidator(
        this.memoryStoreRef,
        {
          concentrator: this.activeConcentrator,
          statusManager: this.statusManagerRef!,
          notifier: this.deps.notifier,
        },
        this.deps.paths.consolidationLog,
      );
    }
    this.scheduleNightConsolidator();
    this.scheduleCleanupEngine();
    this.pluginInitialized = true;
    this.pluginInitError = null;
  })().catch((err) => {
    this.pluginInitPromise = null;
    this.pluginInitialized = false;
    this.pluginInitError = err;
    this.retrieverRef = null;
    this.hooksEngineRef = null;
    this.graphStoreRef = null;
    console.error('[memory-river] Initialization failed (partial state cleared):', err);
    throw err;
  });

  return this.pluginInitPromise;
}

  clearNightConsolidatorTimers(): void {
  if (this.nightTimerId) {
    clearTimeout(this.nightTimerId);
    this.nightTimerId = null;
  }
  if (this.nightIntervalId) {
    clearInterval(this.nightIntervalId);
    this.nightIntervalId = null;
  }
  if (this.nightHealthCheckIntervalId) {
    clearInterval(this.nightHealthCheckIntervalId);
    this.nightHealthCheckIntervalId = null;
  }
  if (this.nightStartupRecoveryTimerId) {
    clearTimeout(this.nightStartupRecoveryTimerId);
    this.nightStartupRecoveryTimerId = null;
  }
}

  recordNightConsolidationStat(stat: Parameters<MemoryStore['recordNightConsolidationStat']>[0]): void {
  if (!this.memoryStoreRef) return;
  void this.memoryStoreRef.recordNightConsolidationStat(stat).catch((err: any) => {
    console.warn('[NightConsolidator] stats write failed:', err?.message ?? err);
  });
}

  async getLastSuccessfulNightRunTs(): Promise<number | null> {
  if (!this.memoryStoreRef?.db) return null;
  try {
    if (typeof this.memoryStoreRef.db.tableNames === 'function') {
      const tableNames = await this.memoryStoreRef.db.tableNames();
      if (!tableNames.includes('night_consolidation_stats')) return null;
    }
    const table = await this.memoryStoreRef.db.openTable('night_consolidation_stats');
    const rows = await table
      .query()
      .where("phase = 'run_completed' AND outcome = 'ok'")
      .limit(1000)
      .toArray();
    let latest: number | null = null;
    for (const row of rows) {
      const ts = Number(row?.ts);
      if (Number.isFinite(ts) && (latest === null || ts > latest)) latest = ts;
    }
    return latest;
  } catch (err: any) {
    console.warn('[NightConsolidator] last-success lookup failed:', err?.message ?? err);
    return null;
  }
}

  async runNightConsolidatorNow(
  runId = randomUUID(),
  scheduledFor?: number,
  source: NightRecoverySource = 'scheduled_timer',
): Promise<void> {
  if (!this.nightConsolidatorRef) return;
  const now = Date.now();
  if (this.lastNightConsolidatorSuccessfulRunAt > 0 && now - this.lastNightConsolidatorSuccessfulRunAt > 48 * 60 * 60 * 1000) {
    console.warn(
      `[NightConsolidator] warning: last successful run was ${new Date(this.lastNightConsolidatorSuccessfulRunAt).toISOString()}, over 48h ago`
    );
  }
  const startedAt = Date.now();
  this.recordNightConsolidationStat({
    runId,
    phase: 'run_started',
    ts: startedAt,
    scheduledFor: scheduledFor ?? null,
    metadata: buildNightRecoveryMetadata({ source }),
  });
  console.log('[NightConsolidator] run started');
  try {
    const result = await this.nightConsolidatorRef.consolidateToday(runId, source);
    this.lastNightConsolidatorSuccessfulRunAt = Date.now();
    this.recordNightConsolidationStat({
      runId,
      phase: 'run_completed',
      ts: Date.now(),
      outcome: result.errors.length === 0 ? 'ok' : 'failed',
      durationMs: Date.now() - startedAt,
      decisionCount: result.plan.decisions.length,
      mergeCount: result.plan.mergedCount,
      deleteCount: result.plan.decisions.filter(d => d.action === 'delete').length,
      deprecatedCount: result.plan.decisions.filter(d => d.action === 'deprecated').length,
      updateCount: result.plan.updatedCount,
      keepCount: result.plan.keptCount,
      candidateCount: result.plan.processedCount,
      metadata: buildNightRecoveryMetadata({ source, errorsCount: result.errors.length }),
    });
    console.log(`[NightConsolidator] run completed processed=${result.plan.processedCount}`);
  } catch (err: any) {
    this.recordNightConsolidationStat({
      runId,
      phase: 'run_failed',
      ts: Date.now(),
      outcome: 'failed',
      durationMs: Date.now() - startedAt,
      scheduledFor: scheduledFor ?? null,
      errorMessage: err?.message ?? String(err),
      metadata: buildNightRecoveryMetadata({ source }),
    });
    console.error('[NightConsolidator] run failed:', err);
    if (err?.stack) {
      console.error(err.stack);
    }
  }
}

  async tryRunNightConsolidator(
  source: NightRecoverySource,
  runId = randomUUID(),
  scheduledFor?: number,
): Promise<void> {
  await runNightRecoveryHealthCheck({
    source,
    isRunning: () => this.nightConsolidatorIsRunning,
    setRunning: (running) => {
      this.nightConsolidatorIsRunning = running;
    },
    getLastSuccessfulRunTs: () => this.getLastSuccessfulNightRunTs(),
    recordStat: (stat) => this.recordNightConsolidationStat(stat),
    runNightConsolidation: async (runSource) => {
      await this.runNightConsolidatorNow(runId, scheduledFor, runSource);
    },
  });
}

  scheduleNightConsolidator(): void {
  // Benchmark confirmatory A/B (MR_OTTER_READONLY=1) freezes the river during QA so each question
  // is an independent probe. Night consolidation is a timer-scheduled writer that can fire mid-run
  // and mutate memory content/health -> cross-question contamination. Gate it (no config flag for
  // it exists). Production untouched (flag default off).
  if (process.env.MR_OTTER_READONLY === '1') return;
  if (!this.nightConsolidatorRef) return;
  this.clearNightConsolidatorTimers();
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(3, 0, 0, 0);
  if (nextRun.getTime() <= now.getTime()) nextRun.setDate(nextRun.getDate() + 1);
  const scheduledFor = nextRun.getTime();
  const scheduledRunId = randomUUID();
  const msUntilFirstRun = nextRun.getTime() - now.getTime();
  this.recordNightConsolidationStat({
    runId: scheduledRunId,
    phase: 'schedule_created',
    ts: Date.now(),
    scheduledFor,
    metadata: buildNightRecoveryMetadata({ source: 'scheduled_timer' }),
  });
  console.log(`[NightConsolidator] timer scheduled, fires at ${nextRun.toISOString()} (${msUntilFirstRun} ms)`);
  this.nightTimerId = setTimeout(() => {
    const firedAt = Date.now();
    this.recordNightConsolidationStat({
      runId: scheduledRunId,
      phase: 'timer_fired',
      ts: firedAt,
      scheduledFor,
      driftMs: firedAt - scheduledFor,
      metadata: buildNightRecoveryMetadata({ source: 'scheduled_timer' }),
    });
    console.log(`[NightConsolidator] timer fired at ${new Date().toISOString()}`);
    void this.tryRunNightConsolidator('scheduled_timer', scheduledRunId, scheduledFor);
    let intervalScheduledFor = scheduledFor + 24 * 60 * 60 * 1000;
    let intervalRunId = randomUUID();
    this.recordNightConsolidationStat({
      runId: intervalRunId,
      phase: 'schedule_created',
      ts: Date.now(),
      scheduledFor: intervalScheduledFor,
      metadata: buildNightRecoveryMetadata({ source: 'scheduled_timer' }),
    });
    this.nightIntervalId = setInterval(() => {
      const intervalFiredAt = Date.now();
      const currentRunId = intervalRunId;
      const currentScheduledFor = intervalScheduledFor;
      this.recordNightConsolidationStat({
        runId: currentRunId,
        phase: 'timer_fired',
        ts: intervalFiredAt,
        scheduledFor: currentScheduledFor,
        driftMs: intervalFiredAt - currentScheduledFor,
        metadata: buildNightRecoveryMetadata({ source: 'scheduled_timer' }),
      });
      console.log(`[NightConsolidator] timer fired at ${new Date().toISOString()}`);
      void this.tryRunNightConsolidator('scheduled_timer', currentRunId, currentScheduledFor);
      intervalScheduledFor = currentScheduledFor + 24 * 60 * 60 * 1000;
      intervalRunId = randomUUID();
      this.recordNightConsolidationStat({
        runId: intervalRunId,
        phase: 'schedule_created',
        ts: Date.now(),
        scheduledFor: intervalScheduledFor,
        metadata: buildNightRecoveryMetadata({ source: 'scheduled_timer' }),
      });
    }, 24 * 60 * 60 * 1000);
    this.nightIntervalId.unref?.();
  }, msUntilFirstRun);
  this.nightTimerId.unref?.();
  this.nightHealthCheckIntervalId = setInterval(() => {
    void this.tryRunNightConsolidator('health_check_recovery').catch((err: any) => {
      console.warn('[NightConsolidator] health-check failed:', err?.message ?? err);
    });
  }, NIGHT_HEALTH_CHECK_INTERVAL_MS);
  this.nightHealthCheckIntervalId.unref?.();
  this.nightStartupRecoveryTimerId = setTimeout(() => {
    void this.tryRunNightConsolidator('startup_recovery').catch((err: any) => {
      console.warn('[NightConsolidator] startup recovery check failed:', err?.message ?? err);
    });
  }, NIGHT_STARTUP_RECOVERY_DELAY_MS);
  this.nightStartupRecoveryTimerId.unref?.();
  console.log(`[memory-river] NightConsolidator scheduled; next run: ${nextRun.toISOString()}`);
}

  clearCleanupEngineTimers(): void {
  if (this.cleanupTimeoutId) {
    clearTimeout(this.cleanupTimeoutId);
    this.cleanupTimeoutId = null;
  }
  if (this.cleanupIntervalId) {
    clearInterval(this.cleanupIntervalId);
    this.cleanupIntervalId = null;
  }
}

  async runCleanupEngineNow(source: 'daily-schedule' | 'startup-recovery' | 'session-end'): Promise<void> {
  if (!this.cleanupEngineRef) return;
  try {
    const result = await this.cleanupEngineRef.runSmartCleanup(source);
    this.recordCleanupSuccess(result);
  } catch (err: any) {
    console.error(`[CleanupEngine] run failed, source=${source}:`, err);
    if (err?.stack) {
      console.error(err.stack);
    }
  }
}

  recordCleanupSuccess(result: { deleted: number; updated: number }): void {
  const now = Date.now();
  this.lastCleanupSuccessfulRunAt = now;
  writeCleanupState({
    lastSuccessfulRunAt: now,
    lastDeleteCount: result.deleted,
    lastDecayCount: result.updated,
  }, path.join(this.deps.paths.stateDir, 'cleanup-state.json'));
}

  getStartupRecoveryLimits(): StartupRecoveryLimits {
  return {
    maxStartupDelete: this.activePluginConfig.cleanupEngine?.maxStartupDelete ?? this.config.cleanupEngine.maxStartupDelete ?? 20,
    maxStartupDecay: this.activePluginConfig.cleanupEngine?.maxStartupDecay ?? this.config.cleanupEngine.maxStartupDecay ?? 50,
  };
}

  formatHours(hours: number): string {
  return hours.toFixed(1).replace(/\.0$/, '');
}

  formatCandidateSummary(summary: {
  count: number;
  firstId: string | null;
  lastId: string | null;
  minCreatedAt: number | null;
  maxCreatedAt: number | null;
  createdAtByDay: Record<string, number>;
}): string {
  const range = `${summary.firstId ?? 'none'}..${summary.lastId ?? 'none'}`;
  const createdAtRange = summary.minCreatedAt && summary.maxCreatedAt
    ? `${new Date(summary.minCreatedAt).toISOString()}..${new Date(summary.maxCreatedAt).toISOString()}`
    : 'none';
  return `count=${summary.count} idRange=${range} createdAtRange=${createdAtRange} createdAtByDay=${JSON.stringify(summary.createdAtByDay)}`;
}

  shouldScheduleStartupRecoveryFromState(
  state: CleanupState | null,
  nowMs: number = Date.now(),
) {
  return shouldRunStartupRecovery(state, nowMs);
}

  async runStartupRecoveryWithProtection(): Promise<void> {
  if (!this.cleanupEngineRef) return;
  const limits = this.getStartupRecoveryLimits();
  console.log(`[CleanupEngine] startup recovery estimating candidates, maxDelete=${limits.maxStartupDelete}, maxDecay=${limits.maxStartupDecay}`);

  const estimate = await this.cleanupEngineRef.runSmartCleanup('startup-recovery', { dryRunOverride: true });
  const mode = chooseStartupRecoveryMode(estimate.wouldDelete, limits);

  if (mode.dryRunOnly) {
    console.warn(
      `[CleanupEngine] startup-recovery backlog too large: estimatedDelete=${estimate.wouldDelete} limit=${mode.maxDelete}, dryRun=true, ${this.formatCandidateSummary(estimate.deleteCandidateSummary)}`
    );
    this.recordCleanupSuccess({ deleted: 0, updated: 0 });
    return;
  }

  const result = await this.cleanupEngineRef.runSmartCleanup('startup-recovery', {
    maxDelete: mode.maxDelete,
    maxDecay: mode.maxDecay,
  });
  if (result.deferredDelete > 0 || result.deferredDecay > 0) {
    console.log(
      `[CleanupEngine] startup-recovery: hit limit, deferred ${result.deferredDelete} delete candidates and ${result.deferredDecay} decay candidates to next run`
    );
  }
  this.recordCleanupSuccess(result);
}

  scheduleCleanupEngine(): void {
  // See scheduleNightConsolidator: under MR_OTTER_READONLY=1 the startup-recovery path here runs
  // healthScore decay (store-v4.ts) and the interval timer keeps writing -> cross-question drift.
  // Gate it; production untouched (flag default off).
  if (process.env.MR_OTTER_READONLY === '1') return;
  if (!this.cleanupEngineRef) return;
  this.clearCleanupEngineTimers();

  const nowMs = Date.now();
  const state = readCleanupState(path.join(this.deps.paths.stateDir, 'cleanup-state.json'));
  const decision = shouldRunStartupRecovery(state, nowMs);
  if (decision.shouldRun) {
    console.log(`[CleanupEngine] startup recovery triggered, source=startup-recovery, reason=${decision.reason}`);
    void this.runStartupRecoveryWithProtection().catch((err: any) => {
      console.error('[CleanupEngine] startup recovery failed:', err);
      if (err?.stack) console.error(err.stack);
    });
  } else {
    console.log(`[CleanupEngine] startup-recovery skipped: last success was ${this.formatHours(decision.hoursSinceLastSuccess)}h ago`);
  }

  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(4, 0, 0, 0);
  if (nextRun.getTime() <= now.getTime()) nextRun.setDate(nextRun.getDate() + 1);
  const msUntilFirstRun = nextRun.getTime() - now.getTime();
  console.log(`[CleanupEngine] timer scheduled, fires at ${nextRun.toISOString()} (${msUntilFirstRun} ms)`);
  this.cleanupTimeoutId = setTimeout(() => {
    console.log(`[CleanupEngine] timer fired at ${new Date().toISOString()}, source=daily-schedule`);
    void this.runCleanupEngineNow('daily-schedule');
    this.cleanupIntervalId = setInterval(() => {
      console.log(`[CleanupEngine] timer fired at ${new Date().toISOString()}, source=daily-schedule`);
      void this.runCleanupEngineNow('daily-schedule');
    }, 24 * 60 * 60 * 1000);
  }, msUntilFirstRun);
}

/** 提取訊息陣列 */
  extractMessages(...args: any[]): any[] {
  for (const arg of args) {
    if (Array.isArray(arg)) return arg;
    if (arg && Array.isArray(arg.messages)) return arg.messages;
    if (arg && arg.session && Array.isArray(arg.session.messages)) return arg.session.messages;
    if (arg && arg.message) return Array.isArray(arg.message.content) ? arg.message.content : [arg.message];
  }
  return [];
}

  normalizeFrameworkLine(line: string): string {
  return line.trim().replace(/：/g, ':').toLowerCase();
}

  metadataHeadingLength(text: string): number {
  const match = text.match(/^[^\S\r\n]*[^\r\n]*\(untrusted metadata\)[^\r\n]*[:：]?[^\r\n]*(?:\r?\n|$)/i);
  return match ? match[0].length : 0;
}

  stripLeadingUntrustedMetadataBlocks(text: string): string {
  let rest = text;
  while (true) {
    rest = rest.trimStart();
    const headingLength = this.metadataHeadingLength(rest);
    if (headingLength === 0) break;
    const afterHeading = rest.slice(headingLength);
    const blankLineMatch = afterHeading.match(/\r?\n[ \t]*\r?\n/);
    const nextHeadingMatch = afterHeading.match(/\r?\n[^\S\r\n]*[^\r\n]*\(untrusted metadata\)[^\r\n]*[:：]?[^\r\n]*(?:\r?\n|$)/i);
    const blankEnd = blankLineMatch ? blankLineMatch.index! + blankLineMatch[0].length : Infinity;
    const nextHeadingEnd = nextHeadingMatch ? nextHeadingMatch.index! + 1 : Infinity;
    const end = Math.min(blankEnd, nextHeadingEnd);
    rest = end === Infinity ? '' : afterHeading.slice(end);
  }
  return rest.trim();
}

/** 提取最後一則 User 訊息文字 */
  extractLastUserMessage(msgs: any[]): string {
  const matchFrameworkMetadata = (text: string): FrameworkMetadataMatch | null => {
    if (!text) return null;
    const trimmed = text.trimStart();
    const normalized = this.normalizeFrameworkLine(trimmed.split(/\r?\n/, 1)[0] ?? trimmed);

    return normalized.startsWith('conversation info (untrusted metadata)') ? 'conversation_info' :
      normalized.startsWith('note: the previous agent run was aborted') ? 'run_aborted' :
      normalized.startsWith('[media attached:') ? 'media_attached' :
      normalized.startsWith('(system)') ? 'system_tag' :
      normalized.startsWith('[metadata]') ? 'metadata_tag' :
      null;
  };

  const extractText = (content: any): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((c: any) => c?.type === 'text' ? c.text : '')
        .join(' ')
        .trim();
    }
    return '';
  };

  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'user') continue;

    const text = extractText(m.content);
    if (!text) continue;
    const matched = matchFrameworkMetadata(text);
    if (matched) {
      if (matched === 'conversation_info') {
        const stripped = this.stripLeadingUntrustedMetadataBlocks(text);
        if (stripped) return stripped;
        console.log('[autoRecall] skipped framework: pattern=conversation_info_after_strip');
      } else {
        console.log(`[autoRecall] skipped framework: pattern=${matched}`);
      }
      continue;
    }

    return text;
  }

  return '';
}

  recordHookPromptIncludedEvents(
  store: any,
  results: any[],
  searchResponse: Pick<HybridSearchResponse, "hookOriginIds" | "hookOriginKeywords" | "queryHash"> | null | undefined,
): void {
  const recordSubsystemEffectiveness = store?.recordSubsystemEffectiveness;
  if (typeof recordSubsystemEffectiveness !== "function") return;
  if (!searchResponse?.queryHash || !Array.isArray(searchResponse.hookOriginIds)) return;

  const hookOriginIds = new Set(searchResponse.hookOriginIds);
  if (hookOriginIds.size === 0) return;

  results.forEach((result, index) => {
    const memoryId = result?.entry?.id;
    if (typeof memoryId !== "string" || !hookOriginIds.has(memoryId)) return;

    const score = Number(result?.finalScore ?? result?.fusedScore ?? 0);
    void recordSubsystemEffectiveness.call(store, {
      subsystem: "hooks",
      event: "hook_prompt_included",
      entityId: memoryId,
      relatedId: "",
      queryHash: searchResponse.queryHash,
      outcome: "included",
      count: 1,
      score: Number.isFinite(score) ? score : 0,
      durationMs: 0,
      metadata: {
        rank: index + 1,
        keyword: searchResponse.hookOriginKeywords?.[memoryId] ?? "",
      },
    }).catch((err: any) => {
      console.warn("[memory-river] hooks prompt effectiveness write failed:", err?.message ?? err);
    });
  });
}

  recordGwmEffectiveness(
  store: any,
  event: Partial<SubsystemEffectivenessEvent>,
): void {
  const fn = (store as any)?.recordSubsystemEffectiveness;
  if (typeof fn !== 'function') return;
  void fn.call(store, {
    subsystem: 'gwm',
    relatedId: '',
    durationMs: 0,
    ...event,
  }).catch((err: any) => {
    console.warn('[memory-river] gwm effectiveness write failed:', err?.message ?? err);
  });
}

  async executeMemoryRecall(params: any) {
  try {
    await this.init();
  } catch (err) {
    return this.initFailedResult(err);
  }

  if (!this.retrieverRef) {
    return this.initFailedResult(this.pluginInitError ?? new Error('retriever unavailable after initialization'));
  }

  const searchResponse = await this.retrieverRef.hybridSearch(params.query, params.limit || 5);
  const results = searchResponse.results;
  if (results.length === 0) {
    const queryHash = searchResponse.queryHash || hashQuery(String(params.query ?? ''));
    let searched = 'unknown';
    try {
      const store = typeof (this.retrieverRef as any).getStore === 'function'
        ? (this.retrieverRef as any).getStore()
        : this.memoryStoreRef;
      const count = await store?.count?.();
      if (Number.isFinite(Number(count))) searched = String(Number(count));
    } catch {
      searched = 'unknown';
    }
    return { content: [{ type: 'text', text: `查無相關記憶 (queryHash=${queryHash}, searched=${searched} memories)` }] };
  }

  const text = results.map((r: any) => `• ${r.entry.text}`).join('\n');
  return { content: [{ type: 'text', text: `[相關記憶]\n${text}` }] };
}

  async executeMemoryStore(params: any) {
  if (!this.capsuleBridgeRef) {
    return {
      content: [{ type: 'text', text: '❌ INBOX_WRITER_UNAVAILABLE: capsule bridge not initialized' }],
      isError: true,
    };
  }

  const { text, category, importance } = params;
  await this.capsuleBridgeRef.writeInboxItem(text, { category: category || 'other', importance: importance ?? 0.7 });
  return { content: [{ type: 'text', text: `📝 已寫入 Inbox（待濃縮入庫）` }] };
}

  async remember(
    text: string,
    opts: { category?: string; importance?: number; metadata?: object } = {},
  ): Promise<MemoryEntry> {
    await this.init();
    if (!this.memoryStoreRef || !this.embedderRef) {
      throw this.pluginInitError ?? new Error('memory store unavailable after initialization');
    }
    const vector = await this.embedderRef.embed(text, 'store');
    return this.memoryStoreRef.store({
      text,
      vector,
      category: (opts.category || 'other') as any,
      importance: opts.importance ?? 0.7,
      parentId: null,
      metadata: JSON.stringify(opts.metadata ?? {}),
    });
  }

  async updateMemory(
    id: string,
    updates: Partial<Pick<MemoryEntry, 'text' | 'category' | 'importance' | 'metadata'>>,
  ): Promise<boolean> {
    await this.init();
    if (!this.memoryStoreRef || !this.embedderRef) {
      throw this.pluginInitError ?? new Error('memory store unavailable after initialization');
    }
    // F2 修復：改字要跟著改向量，否則向量檢索仍代表舊語意。
    const newVector = updates.text !== undefined
      ? await this.embedderRef.embed(updates.text, 'store')
      : undefined;
    return this.memoryStoreRef.update(id, updates, newVector);
  }

  async setMemoryStatus(req: StatusChangeRequest): Promise<StatusChangeResult> {
    await this.init();
    if (!this.statusManagerRef) {
      throw this.pluginInitError ?? new Error('status manager unavailable after initialization');
    }
    return this.statusManagerRef.changeStatus(req);
  }

  async recall(query: string, limit = 5): Promise<MemorySearchResult[]> {
    await this.init();
    if (!this.memoryStoreRef) {
      throw this.pluginInitError ?? new Error('memory store unavailable after initialization');
    }
    return this.memoryStoreRef.hybridVectorSearch(query, limit);
  }

  // ⚠️ DEPRECATED / DORMANT (2026-06-19): graph-enumerate is superseded by memory_recall
  // for cat1 enumeration. Fair full-10: recall SiblingRecall@10 ~48% vs enumerate ~29%, at
  // LOWER noise. Not wired into any agent/MCP/answer path (facade-only). Do NOT invest further;
  // every retrieval lever (ranking/breadth/direction/fanout/relation-typing) was falsified.
  // Revisit only if ingestion-side relation normalization happens. See
  // docs/internal/FINDINGS_ENUM_CAT1_20260619.md.
  async enumerate(plan: EnumerationPlan, limit = 1000): Promise<MemorySearchResult[]> {
    await this.init();
    if (!this.graphStoreRef || !this.memoryStoreRef || !this.embedderRef) {
      throw this.pluginInitError ?? new Error('graph enumeration unavailable after initialization');
    }

    if (limit <= 0) return [];

    const enumerator = new GraphEnumerator(this.graphStoreRef, this.embedderRef);
    // Enumerate the full answer set internally; `limit` caps returned MEMORIES so
    // callers get a true top-`limit` result (recall@k / Noise@k are measured over
    // at most `limit` memories, not over the memories backing the top-`limit` answers).
    const result = await enumerator.enumerate(plan);
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const answer of result.answers) {
      for (const id of answer.sourceMemoryIds) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }

    // Filter hidden-status memories BEFORE applying the limit: getByIds drops
    // non-active rows, so slicing to `limit` first would let a deprecated memory
    // in the top-`limit` prefix silently shrink the result below `limit` (at
    // limit=1 a deprecated head returns []). Hydrate the full id list, then cap.
    const entries = (await this.memoryStoreRef.getByIds(ids)).slice(0, limit);
    return entries.map(entry => ({
      entry,
      // Non-ranking placeholders: enumeration hits are provenance-backed, not similarity-ranked.
      rawDistance: Number.POSITIVE_INFINITY,
      vectorScore: 0,
      rankScore: 0,
      bm25Score: 0,
      fusedScore: 0,
    }));
  }

  async searchMemory(query: string, limit = 5): Promise<MemorySearchResult[]> {
    await this.init();
    if (!this.retrieverRef) {
      throw this.pluginInitError ?? new Error('retriever unavailable after initialization');
    }
    // TODO(read-only): hybridSearchWithoutBoost still records recall metadata.
    return (await this.retrieverRef.hybridSearchWithoutBoost(query, limit)).results;
  }

  private async withSkillLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.skillLocks.get(name) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const chain = run.catch(() => {});
    this.skillLocks.set(name, chain);
    try {
      return await run;
    } finally {
      if (this.skillLocks.get(name) === chain) {
        this.skillLocks.delete(name);
      }
    }
  }

  async saveSkill(def: SkillDef): Promise<{ id: string }> {
    validateSkillDef(def);
    await this.init();
    if (!this.memoryStoreRef || !this.embedderRef || !this.statusManagerRef) {
      throw this.pluginInitError ?? new Error('memory store unavailable after initialization');
    }

    return this.withSkillLock(def.name, async () => {
      const existing = (await this.memoryStoreRef!.queryAllWithMeta())
        .filter(entry => entry.metadataObj.capsuleVersion === 2)
        .filter(entry => entry.metadataObj.status === 'active')
        .filter(entry => entry.metadataObj.skillName === def.name);

      const vector = await this.embedderRef!.embed(def.summary, 'store');
      const created = await this.memoryStoreRef!.store({
        text: def.summary,
        vector,
        category: 'skill',
        importance: 0.7,
        parentId: null,
        metadata: JSON.stringify({
          capsuleVersion: 2,
          skillName: def.name,
          triggerConditions: def.triggers,
          executionSteps: def.steps,
          usageCount: 0,
          lastUsedAt: null,
          status: 'active',
        }),
      });

      try {
        for (const old of existing) {
          const result = await this.statusManagerRef!.changeStatus({
            memoryId: old.id,
            toStatus: 'superseded',
            reason: 'manual',
            source: 'skills.save',
            supersededBy: created.id,
          });
          if (!result.ok) {
            throw new Error(`failed to supersede skill ${old.id}: ${result.error ?? 'unknown error'}`);
          }
        }
      } catch (err) {
        try {
          const rollback = await this.statusManagerRef!.changeStatus({
            memoryId: created.id,
            toStatus: 'trashed',
            reason: 'saveSkill_supersede_rollback',
            source: 'skills.save',
          });
          if (!rollback.ok) {
            console.warn(`[memory-river] saveSkill rollback failed for ${created.id}: ${rollback.error ?? 'unknown error'}`);
          }
        } catch (rollbackErr) {
          console.warn(`[memory-river] saveSkill rollback failed for ${created.id}:`, rollbackErr);
        }
        throw err;
      }

      return { id: created.id };
    });
  }

  async searchSkills(query: string, limit = 2): Promise<SkillIndexEntry[]> {
    await this.init();
    if (!this.memoryStoreRef) {
      throw this.pluginInitError ?? new Error('memory store unavailable after initialization');
    }
    const candidates = await this.memoryStoreRef.hybridSkillCapsuleSearch(
      query,
      limit,
      { capsuleVersion: 2, status: 'active' },
    );
    return candidates
      .map(candidate => ({
        name: candidate.skillName,
        triggerConditions: candidate.triggerConditions,
        summary: candidate.summary,
      }));
  }

  async loadSkill(name: string): Promise<SkillCapsuleV2 | null> {
    await this.init();
    if (!this.memoryStoreRef) {
      throw this.pluginInitError ?? new Error('memory store unavailable after initialization');
    }
    return this.withSkillLock(name, async () => {
      const matches = (await this.memoryStoreRef!.queryAllWithMeta())
        .filter(candidate => candidate.metadataObj.capsuleVersion === 2
          && candidate.metadataObj.status === 'active'
          && candidate.metadataObj.skillName === name)
        .sort((a, b) => b.createdAt - a.createdAt);
      if (matches.length > 1) {
        console.warn(`[memory-river] Multiple active v2 skills named ${name}: ${matches.map(entry => entry.id).join(', ')}`);
      }
      const entry = matches[0];
      if (!entry) return null;

      const metadata = entry.metadataObj;
      metadata.usageCount = (metadata.usageCount ?? 0) + 1;
      metadata.lastUsedAt = Date.now();
      await this.memoryStoreRef!.update(entry.id, { metadata: JSON.stringify(metadata) });
      await this.memoryStoreRef!.boostHealth(entry.id);

      const updated = await this.memoryStoreRef!.getById(entry.id);
      return updated ? this.toSkillCapsuleV2(updated) : null;
    });
  }

  async listSkills(): Promise<SkillIndexEntry[]> {
    await this.init();
    if (!this.memoryStoreRef) {
      throw this.pluginInitError ?? new Error('memory store unavailable after initialization');
    }
    const newestByName = new Map<string, Awaited<ReturnType<typeof this.memoryStoreRef.queryAllWithMeta>>[number]>();
    for (const entry of (await this.memoryStoreRef.queryAllWithMeta())
      .filter(entry => entry.metadataObj.capsuleVersion === 2 && entry.metadataObj.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt)) {
      const name = String(entry.metadataObj.skillName);
      if (!newestByName.has(name)) newestByName.set(name, entry);
    }
    return Array.from(newestByName.values())
      .map(entry => ({
        name: String(entry.metadataObj.skillName),
        triggerConditions: Array.isArray(entry.metadataObj.triggerConditions) ? entry.metadataObj.triggerConditions : [],
        summary: entry.text,
      }));
  }

  private toSkillCapsuleV2(entry: MemoryEntry): SkillCapsuleV2 {
    const metadata = JSON.parse(entry.metadata || '{}');
    return {
      id: entry.id,
      name: metadata.skillName,
      triggerConditions: metadata.triggerConditions ?? [],
      executionSteps: metadata.executionSteps ?? [],
      summary: entry.text,
      category: 'skill',
      importance: 0.7,
      capsuleVersion: 2,
      usageCount: metadata.usageCount ?? 0,
      lastUsedAt: metadata.lastUsedAt ?? null,
      status: metadata.status,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  gwmNotInitializedResult() {
  return {
    content: [{ type: 'text', text: '❌ GWM_NOT_INITIALIZED: global working memory is not initialized' }],
    isError: true,
  };
}

  async executeGwmOn(params: any) {
  if (!this.gwmRef) return this.gwmNotInitializedResult();
  const result = await this.gwmRef.gwmOn(params.taskName, params.taskDescription, params.keywords);
  const sessionIdentity = this.lastObservedSessionIdentity;
  const sessionKey = sessionIdentity?.canonicalKey ?? 'global';
  const sessionState = this.getOrCreateGwmSessionState(sessionKey);
  sessionState.injectionCount = 0;
  sessionState.turnIndex = 0;
  sessionState.lastInjectionTurnIndex = null;
  sessionState.pendingEpisode = null;
  const llmIdentity = sessionIdentity
    ? this.getRecentLlmIdentityForKeys(this.attributionKeysFromIdentity(sessionIdentity))
    : null;
  const gwmState = (this.gwmRef as any)?.state;
  this.recordGwmEffectiveness(this.retrieverRef?.getStore?.() ?? this.memoryStoreRef, {
    event: 'gwm_lifecycle',
    outcome: 'on',
    sessionKey: sessionIdentity?.sessionKey ?? sessionIdentity?.canonicalKey ?? '',
    sessionId: sessionIdentity?.sessionId ?? '',
    count: sessionState.injectionCount,
    metadata: {
      lifecycle: 'on',
      llmModel: llmIdentity?.model ?? null,
      llmProvider: llmIdentity?.provider ?? null,
      taskDescriptionHash: gwmState?.taskDescription ? hashQuery(gwmState.taskDescription) : hashQuery(String(params.taskDescription ?? '')),
      roundsSinceLastInjection: null,
      sessionTrackingKey: sessionKey,
      source: 'tool_call_proxy',
    },
  });
  return { content: [{ type: 'text', text: result }] };
}

  async executeGwmOff() {
  if (!this.gwmRef) return this.gwmNotInitializedResult();
  const sessionIdentity = this.lastObservedSessionIdentity;
  const sessionKey = sessionIdentity?.canonicalKey ?? 'global';
  const sessionState = this.getOrCreateGwmSessionState(sessionKey);
  const llmIdentity = sessionIdentity
    ? this.getRecentLlmIdentityForKeys(this.attributionKeysFromIdentity(sessionIdentity))
    : null;
  const gwmStateBeforeOff = (this.gwmRef as any)?.state;
  const roundsSinceLastInjection = sessionState.lastInjectionTurnIndex === null
    ? null
    : Math.max(0, sessionState.turnIndex - sessionState.lastInjectionTurnIndex);
  const result = await this.gwmRef.gwmOff();
  this.recordGwmEffectiveness(this.retrieverRef?.getStore?.() ?? this.memoryStoreRef, {
    event: 'gwm_lifecycle',
    outcome: 'off',
    sessionKey: sessionIdentity?.sessionKey ?? sessionIdentity?.canonicalKey ?? '',
    sessionId: sessionIdentity?.sessionId ?? '',
    count: sessionState.injectionCount,
    metadata: {
      lifecycle: 'off',
      llmModel: llmIdentity?.model ?? null,
      llmProvider: llmIdentity?.provider ?? null,
      taskDescriptionHash: gwmStateBeforeOff?.taskDescription ? hashQuery(gwmStateBeforeOff.taskDescription) : null,
      roundsSinceLastInjection,
      sessionTrackingKey: sessionKey,
      closeReason: 'tool_call_unknown_actor',
      source: 'tool_call_proxy',
    },
  });
  sessionState.pendingEpisode = null;
  return { content: [{ type: 'text', text: result }] };
}

  executeGwmStatus() {
  if (!this.gwmRef) return this.gwmNotInitializedResult();
  const result = this.gwmRef.gwmStatus();
  return { content: [{ type: 'text', text: result }] };
}

  async executeGwmUpdate(params: any) {
  if (!this.gwmRef) return this.gwmNotInitializedResult();
  const sessionIdentity = this.lastObservedSessionIdentity;
  const sessionKey = sessionIdentity?.canonicalKey ?? 'global';
  const sessionState = this.getOrCreateGwmSessionState(sessionKey);
  const llmIdentity = sessionIdentity
    ? this.getRecentLlmIdentityForKeys(this.attributionKeysFromIdentity(sessionIdentity))
    : null;
  const gwmStateBeforeUpdate = (this.gwmRef as any)?.state;
  const oldTaskDescriptionHash = gwmStateBeforeUpdate?.taskDescription
    ? hashQuery(gwmStateBeforeUpdate.taskDescription)
    : null;
  const result = await this.gwmRef.gwmUpdate(params);
  const gwmStateAfterUpdate = (this.gwmRef as any)?.state;
  const roundsSinceLastInjection = sessionState.lastInjectionTurnIndex === null
    ? null
    : Math.max(0, sessionState.turnIndex - sessionState.lastInjectionTurnIndex);
  this.recordGwmEffectiveness(this.retrieverRef?.getStore?.() ?? this.memoryStoreRef, {
    event: 'gwm_lifecycle',
    outcome: 'update',
    sessionKey: sessionIdentity?.sessionKey ?? sessionIdentity?.canonicalKey ?? '',
    sessionId: sessionIdentity?.sessionId ?? '',
    count: sessionState.injectionCount,
    metadata: {
      lifecycle: 'update',
      llmModel: llmIdentity?.model ?? null,
      llmProvider: llmIdentity?.provider ?? null,
      taskDescriptionHash: gwmStateAfterUpdate?.taskDescription ? hashQuery(gwmStateAfterUpdate.taskDescription) : oldTaskDescriptionHash,
      oldTaskDescriptionHash,
      newTaskDescriptionHash: gwmStateAfterUpdate?.taskDescription ? hashQuery(gwmStateAfterUpdate.taskDescription) : oldTaskDescriptionHash,
      roundsSinceLastInjection,
      sessionTrackingKey: sessionKey,
      source: 'tool_call_proxy',
    },
  });
  return { content: [{ type: 'text', text: result }] };
}

  get testHooks() {
    return {
      resetState: () => this.resetStateForTests(),
      setState: (state: any) => this.setStateForTests(state),
      getState: () => this.getStateForTests(),
      ensurePluginInitialized: (_config: PluginConfig = this.config) => this.init(),
      recordPluginInitSmokeStat: (store: any, outcome: 'succeeded' | 'failed', err?: any) => this.recordPluginInitSmokeStat(store, outcome, err),
      executeMemoryRecall: (params: any, _config: PluginConfig = this.config) => this.executeMemoryRecall(params),
      executeMemoryStore: (params: any) => this.executeMemoryStore(params),
      executeGwmOn: (params: any) => this.executeGwmOn(params),
      executeGwmOff: () => this.executeGwmOff(),
      executeGwmStatus: () => this.executeGwmStatus(),
      executeGwmUpdate: (params: any) => this.executeGwmUpdate(params),
    };
  }

  private resetStateForTests(): void {
    this.activeConcentrator = null; this.retrieverRef = null; this.isAutoRecallEnabled = false;
    this.memoryStoreRef = null; this.embedderRef = null; this.hooksEngineRef = null; this.graphStoreRef = null;
    this.inboxWatcherRef = null; this.causalEngineRef = null; this.conflictDetectorRef = null; this.statusManagerRef = null;
    this.capsuleBridgeRef = null; this.gwmRef = null; this.cleanupEngineRef = null; this.pluginInitPromise = null;
    this.pluginInitialized = false; this.pluginInitError = null; this.fallbackObserverRegistered = false;
    this.cleanupEngineInstanceRegistered = false; this.pendingAttribution.clear(); this.recentLlmIdentityByKey.clear();
    this.gwmSessionState.clear(); this.lastObservedSessionIdentity = null;
  }

  private setStateForTests(state: any): void {
    const keys = ['activeConcentrator','retrieverRef','memoryStoreRef','embedderRef','hooksEngineRef','graphStoreRef','inboxWatcherRef','causalEngineRef','conflictDetectorRef','statusManagerRef','capsuleBridgeRef','gwmRef','cleanupEngineRef','pluginInitPromise','pluginInitialized','pluginInitError'] as const;
    for (const key of keys) if (key in state) (this as any)[key] = state[key];
  }

  private getStateForTests(): any {
    const { memoryStoreRef, retrieverRef, hooksEngineRef, graphStoreRef, inboxWatcherRef, causalEngineRef, conflictDetectorRef, statusManagerRef, capsuleBridgeRef, gwmRef, cleanupEngineRef, pluginInitPromise, pluginInitialized, pluginInitError } = this;
    return { memoryStoreRef, retrieverRef, hooksEngineRef, graphStoreRef, inboxWatcherRef, causalEngineRef, conflictDetectorRef, statusManagerRef, capsuleBridgeRef, gwmRef, cleanupEngineRef, pluginInitPromise, pluginInitialized, pluginInitError };
  }

  start(onStateCleared?: () => void): void {
    this.sessionTokenWatermark.clear();
    this.sessionCompactWatermark.clear();
    this.sessionFileMappings.clear();
    this.recentlyCompacted.clear();
    this.lastArchivedLineCount.clear();
    this.maintainLocks.clear();
    this.queuedAsyncCompactKeys.clear();
    this.runningAsyncCompactKeys.clear();
    this.recentLlmIdentityByKey.clear();
    this.gwmSessionState.clear();
    this.lastObservedSessionIdentity = null;
    this.deps.transcriptArchive.clearTranscriptCache();
    onStateCleared?.();
    this.inboxWatcherRef?.start();
    void this.init().catch(err => {
      console.error('[memory-river] Background initialization failed:', err);
    });
  }

  async stop(): Promise<void> {
    this.inboxWatcherRef?.stop();
    this.clearNightConsolidatorTimers();
    this.clearCleanupEngineTimers();
    await this.memoryStoreRef?.shutdown();
  }

  async onSessionCompactBefore(event: any): Promise<void> {
    if (!this.activeConcentrator) return;
    const messages = event?.messages || [];
    if (messages.length === 0) return;
    const identity = resolveSessionIdentity(event);
    const canonicalKey = identity.canonicalKey;
    if (this.wasRecentlyCompacted(canonicalKey)) {
      console.log(`[memory-river] session:compact:before skipped: ${canonicalKey} was compacted within 60s`);
      return;
    }
    try {
      await this.activeConcentrator.concentrate(messages, false, true, { sessionIdentity: identity });
      this.markRecentlyCompacted(canonicalKey);
      console.log('[memory-river] Session compaction complete (capsule and memory notes written)');
    } catch (err) {
      console.error('[memory-river] Session compaction failed:', err);
    }
  }

  onSessionEnd(event: any): void {
    const sessionId = event?.sessionId ?? 'unknown';
    const sessionKey = typeof event?.sessionKey === 'string' && event.sessionKey.trim().length > 0
      ? event.sessionKey.trim()
      : sessionId;
    if (this.gwmRef?.isActive()) {
      const sessionState = this.getOrCreateGwmSessionState(sessionKey);
      const llmIdentity = this.getRecentLlmIdentityForKeys(this.attributionKeysFromLlmOutput(event, {}));
      const gwmState = (this.gwmRef as any)?.state;
      const roundsSinceLastInjection = sessionState.lastInjectionTurnIndex === null
        ? null
        : Math.max(0, sessionState.turnIndex - sessionState.lastInjectionTurnIndex);
      this.recordGwmEffectiveness(this.retrieverRef?.getStore?.() ?? this.memoryStoreRef, {
        event: 'gwm_lifecycle',
        outcome: 'off',
        sessionKey: sessionKey === 'unknown' ? '' : sessionKey,
        sessionId: sessionId === 'unknown' ? '' : sessionId,
        count: sessionState.injectionCount,
        metadata: {
          lifecycle: 'off',
          llmModel: llmIdentity?.model ?? null,
          llmProvider: llmIdentity?.provider ?? null,
          taskDescriptionHash: gwmState?.taskDescription ? hashQuery(gwmState.taskDescription) : null,
          roundsSinceLastInjection,
          sessionTrackingKey: sessionKey,
          closeReason: 'session_end_unclosed',
          source: 'session_end_proxy',
        },
      });
    }
    void this.cleanupEngineRef?.onSessionEnd(sessionId, [], 'session-end');
  }

  onLlmOutput(event: any, ctx: any): void {
    const keys = this.attributionKeysFromLlmOutput(event, ctx);
    const identity: RecentLlmIdentity = {
      model: this.pickNonEmptyString(event?.model),
      provider: this.pickNonEmptyString(event?.provider),
      updatedAt: Date.now(),
    };
    for (const key of keys) this.recentLlmIdentityByKey.set(key, identity);
    const injected = this.takePendingAttribution(keys);
    if (injected.length === 0) return;
    const assistantTexts = Array.isArray(event?.assistantTexts)
      ? event.assistantTexts.filter((text: unknown): text is string => typeof text === 'string')
      : [];
    const requestId = this.pickNonEmptyString(event?.runId)
      ?? this.pickNonEmptyString(ctx?.runId)
      ?? this.pickNonEmptyString(event?.sessionId)
      ?? this.pickNonEmptyString(ctx?.sessionId)
      ?? 'unknown';
    const store = this.memoryStoreRef;
    const attributionEngine = new CausalAttributionEngine({
      recordEvent(row) {
        const fn = (store as any)?.recordSubsystemEffectiveness;
        if (typeof fn !== 'function') return;
        return fn.call(store, row);
      },
    }, this.embedderRef ?? undefined);
    attributionEngine.attributeMemoriesAsync(injected, assistantTexts.join('\n\n'), requestId);
  }

  get store(): MemoryStore | null {
    return this.memoryStoreRef;
  }

// ── 核心流程：assemble (Gateway 對話組裝) ──────────────────────────────────
  async assemble(...args: any[]): Promise<any> {
  let msgs = this.extractMessages(...args);
  const sessionIdentity: SessionIdentity = resolveSessionIdentityFromArgs(...args);
  this.lastObservedSessionIdentity = sessionIdentity;
  const attributionRequestKey = this.extractAttributionRequestKeyFromArgs(...args);
  const onAutoRecallResults = this.extractAutoRecallResultsObserverFromArgs(...args);
  console.log('[memory-river] assemble called, msgs.length=', msgs.length, 'isAutoRecallEnabled=', this.isAutoRecallEnabled);
  if (msgs.length === 0) return { messages: [] };

  // 【Step 1: Ralph Loop 斷路器 — 優先執行！】
  if (RalphState.shouldIntercept()) {
    console.log('[memory-river] Ralph Loop detected consecutive errors; applying hard truncation...');
    const goal = extractGoalFromMsgs(msgs);
    const trimmed = trimTailErrors(msgs);
    const warning = generateWarning(goal);
    msgs = [...trimmed, warning];

    RalphState.reset(); // 電擊完畢，狀態重置
  }

  // 【Step 2 (原 Step 4): 主動濃縮評估與防護 (先瘦身！)】
  // 改用增量觸發：每增加 WATERMARK_INTERVAL tokens 才檢查一次
  // 壓縮後 watermark 重置為壓縮後 token 數，不會無限往上疊
  // =========================================================
  if (this.activeConcentrator && this.retrieverRef) {
    try {
      const canonicalKey = sessionIdentity.canonicalKey;

      const totalTokens = this.activeConcentrator.estimateTokens(msgs);
      const tokenBreakdown = this.activeConcentrator.estimateTokenBreakdown(msgs);
      const assembleWatermark = this.sessionTokenWatermark.get(canonicalKey) ?? 0;
      const compactWatermark = this.sessionCompactWatermark.get(canonicalKey) ?? 0;
      const tokenGrowth = totalTokens - assembleWatermark;
      const exceedsAssembleWatermark = tokenGrowth >= WATERMARK_INTERVAL;
      const exceedsCompactWatermark = totalTokens > compactWatermark + WATERMARK_INTERVAL;
      // Confirmatory flag: never run assemble-time concentration, which writes sessionTokenWatermark
      // (a cross-question in-memory gate). For cat1 the per-question context is far below the 20k
      // WATERMARK_INTERVAL so this never fires anyway, but gate it to keep each question independent.
      const shouldConcentrate = process.env.MR_OTTER_READONLY !== '1'
        && exceedsAssembleWatermark && exceedsCompactWatermark;
      const reason = shouldConcentrate
        ? 'dual-watermark-pass'
        : !exceedsAssembleWatermark
          ? `growth=${tokenGrowth} < interval=${WATERMARK_INTERVAL}`
          : `total=${totalTokens} <= compact+interval=${compactWatermark + WATERMARK_INTERVAL}`;
      console.log(`[concentrator] tokens: real=${tokenBreakdown.realTokens} tool=${tokenBreakdown.toolTokens} total=${tokenBreakdown.total} assembleWatermark=${assembleWatermark} compactWatermark=${compactWatermark} decision=${shouldConcentrate ? 'compress' : 'skip'} reason=${reason}`);

      // 增量觸發：token 增長量超過 WATERMARK_INTERVAL 才進入 concentrate 檢查
      if (shouldConcentrate) {
        const result = await this.activeConcentrator.concentrate(msgs, false, false, { sessionIdentity });
        if (result && result.wasConcentrated) {
          msgs = result.messages;
          // assemble 壓縮只影響本輪上下文，不會立即持久化回 session file。
          // 因此 watermark 必須記錄本次已處理過的「原始 token 規模」，
          // 否則下一輪看到同一批完整歷史時會再次重複濃縮。
          const compressedTokens = this.activeConcentrator.estimateTokens(msgs);
          this.setWatermark(canonicalKey, totalTokens);
          console.log(`[memory-river] Compaction succeeded: ${totalTokens} -> ${compressedTokens} tokens; watermark recorded original baseline ${totalTokens}`);
          if (this.activePluginConfig.concentration?.asyncCompactAfterAssemble === true) {
            this.enqueueAsyncCompact({
              trackingKey: canonicalKey,
              sessionId: sessionIdentity.sessionId ?? undefined,
              sessionKey: sessionIdentity.sessionKey ?? undefined,
              compressedTokens,
              originalTokens: totalTokens,
              timestamp: Date.now(),
            });
          }
        } else {
          // 未壓縮：記錄當前位置（下次再漲 20k 才重新檢查）
          this.setWatermark(canonicalKey, totalTokens);
          console.log(`[memory-river] Dynamic watermark not reached; next check at ~${totalTokens + WATERMARK_INTERVAL} tokens`);
        }
      }
    } catch (err) {
      console.warn('[memory-river] Compaction evaluation failed; skipping this compaction to preserve operation:', err);
    }
  }

  // =========================================================
  // 【Step 3 (原 Step 2): autoRecall 檢索相關記憶 (注入瘦身後的陣列頂端)】
  // =========================================================
if (this.isAutoRecallEnabled && this.retrieverRef) {
    let userText = this.extractLastUserMessage(msgs);
    let gwmExpandedShortQuery = false;
    let gwmOriginalUserText: string | null = null;
    let gwmKeywords: string[] = [];
    let gwmOriginalQueryHash: string | null = null;
    const injectedMemories: InjectedMemory[] = [];

    if (userText && userText.trim().length < 5) {
      // 繞過 TS 檢查提取 state，並加入嚴格空值保護
      const gwmState = (this.gwmRef as any)?.state;

      if (this.gwmRef && this.gwmRef.isActive() && gwmState?.keywords && gwmState.keywords.length > 0) {
        gwmOriginalUserText = userText;
        gwmKeywords = gwmState.keywords;
        gwmOriginalQueryHash = hashQuery(userText);
        const contextStr = gwmState.keywords.join(' ');
        console.log(`[memory-river] Short-query expansion: '${userText}' expanded to '${userText} ${contextStr}'`);
        userText = `${userText} ${contextStr}`; // 補上任務關鍵字再搜
        gwmExpandedShortQuery = true;
        this.recordGwmEffectiveness(this.retrieverRef?.getStore?.() ?? this.memoryStoreRef, {
          event: 'gwm_short_query_expanded',
          outcome: 'expanded',
          queryHash: hashQuery(userText),
          count: gwmKeywords.length,
          metadata: {
            originalLen: gwmOriginalUserText.length,
            expandedLen: userText.length,
            keywordCount: gwmKeywords.length,
            originalQueryHash: gwmOriginalQueryHash,
          },
        });
      } else {
        console.log(`[memory-river] Short query skipped: '${userText}' does not trigger autoRecall (length < 5 and no task keyword)`);
        userText = ''; // 直接清空，阻斷後續檢索
      }
    }

    if (userText) {
      let gwmRecallUsedFallback = false;
      try {
        let searchResponse: HybridSearchResponse | null = null;
        let results: any[] = [];
        const autoRecallK = (() => {
          const raw = Number(process.env.MR_AUTORECALL_K);
          // Ceiling of 5 (== CRAG gate top-K): inject up to 5, but the relevance
          // gate trims to however many actually pass, so irrelevant turns stay lean.
          return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
        })();
        try {
          searchResponse = await this.retrieverRef.hybridSearch(userText, autoRecallK);
        } catch (primaryErr: any) {
          console.warn('[memory-river] autoRecall primary search failed, fallback to no-boost search:', primaryErr?.message);
          gwmRecallUsedFallback = true;
          searchResponse = await this.retrieverRef.hybridSearchWithoutBoost(userText, autoRecallK);
        }
        results = searchResponse.results;
        onAutoRecallResults?.({ query: userText, results });
        let skills: SkillIndexEntry[] = [];
        try {
          skills = await this.searchSkills(userText, 2);
        } catch (skillErr) {
          console.warn('[memory-river] Skill search failed (non-fatal):', (skillErr as any)?.message);
        }

        let preamble = '';
        if (skills.length > 0) {
          preamble += '[可用技能]\n'
            + skills.map(skill => (
              `- 【${skill.name}】觸發: ${skill.triggerConditions.join(', ')} | 摘要: ${skill.summary}`
              + ` → 完整步驟用 skill_load("${skill.name}")`
            )).join('\n')
            + '\n\n';
        }
        if (results?.length > 0) {
          const memoryPromptLines = results.map((r: any) => {
            const rawMeta = r.entry?.metadata;
            const meta = typeof rawMeta === 'string'
              ? (() => { try { return JSON.parse(rawMeta); } catch { return {}; } })()
              : rawMeta || {};
            const isLossy = (meta.confidence != null && meta.confidence < 0.6)
                         || (meta.compressionRatio != null && meta.compressionRatio > 15);
            const sourceEntryIds = Array.isArray(meta.sourceEntryIds)
              ? meta.sourceEntryIds.filter((id: unknown) => typeof id === 'number' && Number.isFinite(id))
              : [];
            let lossyPrefix = '';
            if (isLossy) {
              const conf = meta.confidence != null ? meta.confidence.toFixed(2) : '?';
              const firstAt = meta.firstTimestamp ?? '';
              const lastAt  = meta.lastTimestamp  ?? '';
              if (sourceEntryIds.length > 0) {
                lossyPrefix = `⚠️ [lossy, confidence=${conf}, firstAt=${firstAt}, lastAt=${lastAt}, call memory_rehydrate with mode='entry_ids' + entryIds=${JSON.stringify(sourceEntryIds)}] `;
              } else {
                const windowMinutes = (meta.firstTimestamp && meta.lastTimestamp)
                  ? Math.ceil((meta.lastTimestamp - meta.firstTimestamp) / 60000) + 30
                  : 60;
                lossyPrefix = `⚠️ [lossy, confidence=${conf}, firstAt=${firstAt}, lastAt=${lastAt}, call memory_rehydrate with mode='time_range' + timestamp=${firstAt} + windowMinutes=${windowMinutes}] `;
              }
            } else if (sourceEntryIds.length > 0) {
              lossyPrefix = `[來源turns entryIds=${JSON.stringify(sourceEntryIds)}｜需要精確細節時可用 memory_rehydrate mode='entry_ids'] `;
            }
            return `• ${lossyPrefix}${r.entry?.text || ''}`;
          });
          preamble += '[相關記憶]:\n'
            + '[記憶為候選證據，未必相關或足夠；不足時優先用其 sourceEntryIds 做 entry_ids rehydrate，召回空泛時改用問題中的具體實體 keyword，確認原文支持再回答]\n'
            + memoryPromptLines.join('\n');
          const injectedAt = Date.now();
          const hookOriginIds = new Set(searchResponse?.hookOriginIds ?? []);
          results.forEach((r: any) => {
            const memoryId = r?.entry?.id;
            if (typeof memoryId !== 'string' || memoryId.length === 0) return;
            const memoryText = typeof r?.entry?.text === 'string' ? r.entry.text : '';
            if (!memoryText || memoryText.length < 10) return;
            if (memoryText.startsWith('[lossy')) return;
            if (memoryText.startsWith('[SYSTEM ERROR]')) return;
            if (memoryText.includes('confidence=0.00')) return;
            if (memoryText.includes('call memory_rehydrate')) return;
            const viaHook = hookOriginIds.has(memoryId);
            injectedMemories.push({
              memoryId,
              snippet: memoryText,
              source: 'autoRecall',
              injectedAt,
              viaHook,
              hookKeyword: viaHook ? searchResponse?.hookOriginKeywords?.[memoryId] : undefined,
            });
          });
          this.recordHookPromptIncludedEvents(this.retrieverRef.getStore(), results, searchResponse);
        }

        if (gwmExpandedShortQuery) {
          const memoryCount = results?.length ?? 0;
          const capsuleCount = skills.length;
          this.recordGwmEffectiveness(this.retrieverRef?.getStore?.() ?? this.memoryStoreRef, {
            event: 'gwm_keywords_recalled',
            outcome: (memoryCount + capsuleCount) > 0 ? 'recalled' : 'empty',
            queryHash: searchResponse?.queryHash ?? gwmOriginalQueryHash ?? '',
            count: memoryCount + capsuleCount,
            metadata: {
              memoryCount,
              capsuleCount,
              keywordCount: gwmKeywords.length,
              originalLen: gwmOriginalUserText?.length ?? 0,
              expandedLen: userText.length,
              usedFallback: gwmRecallUsedFallback,
            },
          });
        }

        if (preamble) {
          msgs = [{ role: 'system', content: preamble }, ...msgs];
          this.rememberInjectedMemories(sessionIdentity, injectedMemories, attributionRequestKey);
          console.log(`[memory-river] autoRecall injected: ${results?.length || 0} memories, ${skills.length} skill capsules`);
        }
      } catch (err) {
        if (gwmExpandedShortQuery) {
          this.recordGwmEffectiveness(this.retrieverRef?.getStore?.() ?? this.memoryStoreRef, {
            event: 'gwm_keywords_recalled',
            outcome: 'search_failed',
            queryHash: hashQuery(userText) || gwmOriginalQueryHash || '',
            count: 0,
            metadata: {
              memoryCount: 0,
              capsuleCount: 0,
              keywordCount: gwmKeywords.length,
              originalLen: gwmOriginalUserText?.length ?? 0,
              expandedLen: userText.length,
              usedFallback: gwmRecallUsedFallback,
            },
          });
        }
        console.warn('[memory-river] autoRecall retrieval failed:', (err as any)?.message);
      }
    }
  }

  // =========================================================
  // 【Step 4 (原 Step 3): GWM 任務目標維護 (注入陣列底部)】
  // =========================================================
  if (this.gwmRef && this.gwmRef.isActive()) {
    try {
      const sessionState = this.getOrCreateGwmSessionState(sessionIdentity.canonicalKey);
      const lastUserMsg = this.extractLastUserMessage(msgs);
      if (lastUserMsg) sessionState.turnIndex += 1;
      const drift: DriftResult = await this.gwmRef.detectDrift(msgs);
      if (lastUserMsg && sessionState.pendingEpisode) {
        const completedEpisode = sessionState.pendingEpisode;
        const llmIdentity = this.getRecentLlmIdentityForKeys(this.attributionKeysFromIdentity(sessionIdentity));
        this.recordGwmEffectiveness(this.retrieverRef?.getStore?.() ?? this.memoryStoreRef, {
          event: 'gwm_injection_episode',
          outcome: 'next_user_similarity_observed',
          entityId: completedEpisode.episodeId,
          sessionKey: sessionIdentity.sessionKey ?? sessionIdentity.canonicalKey,
          sessionId: sessionIdentity.sessionId ?? '',
          queryHash: hashQuery(lastUserMsg),
          count: completedEpisode.injectionOrdinal,
          score: drift.similarity,
          metadata: {
            llmModel: llmIdentity?.model ?? completedEpisode.llmModel,
            llmProvider: llmIdentity?.provider ?? completedEpisode.llmProvider,
            injectionOrdinal: completedEpisode.injectionOrdinal,
            preInjectDriftRoundCount: completedEpisode.preInjectDriftRoundCount,
            similarityAtInjection: completedEpisode.similarityAtInjection,
            roundsSinceLastInjection: completedEpisode.roundsSinceLastInjection,
            taskDescriptionHash: completedEpisode.taskDescriptionHash,
            nextUserSimilarity: drift.similarity,
            sessionTrackingKey: sessionIdentity.canonicalKey,
            observedOnTurnIndex: sessionState.turnIndex,
          },
        });
        sessionState.pendingEpisode = null;
      }
      if (drift.isDrifting && this.gwmRef.shouldInject()) {
        const reminder = this.gwmRef.getReminderMessage();
        if (reminder) {
          const driftQueryHash = hashQuery(lastUserMsg ?? '');
          const llmIdentity = this.getRecentLlmIdentityForKeys(this.attributionKeysFromIdentity(sessionIdentity));
          const gwmStateBeforeInject = (this.gwmRef as any)?.state;
          const preInjectDriftRoundCount = typeof gwmStateBeforeInject?.driftRoundCount === 'number'
            ? gwmStateBeforeInject.driftRoundCount
            : null;
          const taskDescriptionHash = gwmStateBeforeInject?.taskDescription
            ? hashQuery(gwmStateBeforeInject.taskDescription)
            : '';
          const roundsSinceLastInjection = sessionState.lastInjectionTurnIndex === null
            ? null
            : Math.max(0, sessionState.turnIndex - sessionState.lastInjectionTurnIndex);
          const episodeId = randomUUID();
          sessionState.injectionCount += 1;
          // 放在陣列最後面，確保 LLM 注意力不渙散
          msgs = [...msgs, { role: 'system', content: reminder }];
          this.recordGwmEffectiveness(this.retrieverRef?.getStore?.() ?? this.memoryStoreRef, {
            event: 'gwm_injection_episode',
            outcome: 'injected',
            entityId: episodeId,
            sessionKey: sessionIdentity.sessionKey ?? sessionIdentity.canonicalKey,
            sessionId: sessionIdentity.sessionId ?? '',
            queryHash: driftQueryHash,
            count: sessionState.injectionCount,
            score: drift.similarity,
            metadata: {
              llmModel: llmIdentity?.model ?? null,
              llmProvider: llmIdentity?.provider ?? null,
              injectionOrdinal: sessionState.injectionCount,
              preInjectDriftRoundCount,
              roundsSinceLastInjection,
              taskDescriptionHash,
              nextUserSimilarity: null,
              sessionTrackingKey: sessionIdentity.canonicalKey,
            },
          });
          sessionState.pendingEpisode = {
            episodeId,
            injectionOrdinal: sessionState.injectionCount,
            queryHash: driftQueryHash,
            similarityAtInjection: drift.similarity,
            preInjectDriftRoundCount,
            roundsSinceLastInjection,
            taskDescriptionHash,
            llmModel: llmIdentity?.model ?? null,
            llmProvider: llmIdentity?.provider ?? null,
          };
          sessionState.lastInjectionTurnIndex = sessionState.turnIndex;
          await this.gwmRef.markInjected();
          console.log(`[memory-river] Drift detected: topic changed (similarity: ${drift.similarity.toFixed(2)}); reminder injected`);

          const gwmState = (this.gwmRef as any)?.state;
          this.recordGwmEffectiveness(this.retrieverRef?.getStore?.() ?? this.memoryStoreRef, {
            event: 'gwm_drift_injected',
            outcome: 'injected',
            sessionKey: sessionIdentity.sessionKey ?? sessionIdentity.canonicalKey,
            sessionId: sessionIdentity.sessionId ?? '',
            queryHash: driftQueryHash,
            score: drift.similarity,
            count: gwmState?.keywords?.length ?? 0,
            metadata: {
              similarity: drift.similarity,
              reminderLen: reminder.length,
              messageCount: msgs.length,
              taskName: gwmState?.taskName ?? null,
              keywordCount: gwmState?.keywords?.length ?? 0,
            },
          });
        }
      } else if (drift.isDrifting) {
        console.log(`[memory-river] Drift detected: topic is shifting (similarity: ${drift.similarity.toFixed(2)})`);
      }
    } catch (err) { console.warn('[memory-river] GWM check failed:', err); }
  }

  const sessionFileProbe = this.resolveSessionFile({
    sessionKey: sessionIdentity.sessionKey ?? undefined,
    sessionId: sessionIdentity.sessionId ?? undefined,
  });
  const fallbackProbe = this.deriveSessionFileFromStaticRule({
    sessionId: sessionIdentity.sessionId ?? undefined,
    sessionKey: sessionIdentity.sessionKey ?? undefined,
  });
  console.log(`[sessionMap] assemble probe: canonicalKey=${sessionIdentity.canonicalKey} source=${sessionIdentity.source} cacheHit=${sessionFileProbe.source === 'cache'} fallbackWouldWork=${!!fallbackProbe}`);

  // 把最終組裝好的 msgs 回傳給 Gateway
  return { messages: msgs };
}

  async ingest(...args: any[]): Promise<void> {}

  async archiveTranscript(
    session: { sessionKey?: string; sessionId?: string },
    messages: ContextMessage[],
  ): Promise<ArchiveSnapshotResult> {
    // F5 修復：原本結果被整個丟棄，caller 永遠拿不到失敗訊號。
    return await this.deps.transcriptArchive.archiveSnapshot({
      canonicalKey: session.sessionKey ?? session.sessionId ?? 'global',
      sessionKey: session.sessionKey ?? null,
      sessionId: session.sessionId ?? null,
    }, messages);
  }

  private async archiveSessionFileTail(
    identity: SessionIdentity,
    sessionFile: string,
  ): Promise<string> {
    const logger = console;
    try {
      logger.info(`[memory-river] maintain archive branch check: hasSessionKey=${!!identity.sessionKey} hasSessionFile=${!!sessionFile} canonicalKey=${identity.canonicalKey}`);
      if (!identity.sessionKey) {
        logger.info(`[memory-river] maintain branch: archive skipped hasSessionKey=false hasSessionFile=${!!sessionFile} canonicalKey=${identity.canonicalKey}`);
        return 'archive-skipped-missing-identity-or-file';
      }

      const fss = await import('fs');
      logger.info(`[memory-river] maintain session file read: path=${sessionFile}`);
      if (!fss.existsSync(sessionFile)) {
        logger.info(`[memory-river] maintain branch: sessionFile missing path=${sessionFile} canonicalKey=${identity.canonicalKey}`);
        return 'session-file-missing';
      }

      const rawContent = fss.readFileSync(sessionFile, 'utf-8');
      const rawLines = rawContent.split('\n');
      if (rawContent.endsWith('\n')) rawLines.pop();
      const allLines = rawLines.filter((l: string) => l.trim());
      const hasIncompleteTail = rawContent.length > 0 && !rawContent.endsWith('\n') && rawLines[rawLines.length - 1]?.trim();
      const processableLineCount = hasIncompleteTail ? Math.max(0, allLines.length - 1) : allLines.length;
      logger.info(`[memory-river] maintain session entries loaded: allLines.length=${allLines.length} canonicalKey=${identity.canonicalKey}`);
      const currentSessionId = identity.sessionId ?? 'unknown';
      if (!identity.sessionId) {
        logger.warn(`[memory-river] maintain missing sessionId, using unknown for transcript watermark canonicalKey=${identity.canonicalKey}`);
      }
      const watermark = await this.resolveArchivedLineCount(this.memoryStoreRef, identity.canonicalKey, currentSessionId);
      let prevCount = watermark.lineCount;
      if (watermark.sessionId !== currentSessionId) {
        logger.info(`[memory-river] session changed, reset watermark: prev=${watermark.sessionId ?? '(none)'} new=${currentSessionId} canonicalKey=${identity.canonicalKey}`);
        prevCount = 0;
      }
      logger.info(`[memory-river] maintain archived line count: prevCount=${prevCount} source=resolveArchivedLineCount canonicalKey=${identity.canonicalKey}`);
      logger.info(`[memory-river] maintain early-return check: prevCount=${prevCount} allLines.length=${allLines.length} processableLineCount=${processableLineCount} hit=${prevCount === processableLineCount}`);

      const newLines = allLines.slice(prevCount, processableLineCount);
      logger.info(`[memory-river] maintain new lines: newLines.length=${newLines.length} prevCount=${prevCount} allLines.length=${allLines.length} processableLineCount=${processableLineCount} incompleteTail=${!!hasIncompleteTail}`);
      if (newLines.length === 0) {
        logger.info(`[memory-river] maintain branch: no new lines canonicalKey=${identity.canonicalKey} skippedLineCount=${Math.max(0, allLines.length - prevCount)}`);
        return 'no-new-lines';
      }

      const entries: ContextMessage[] = [];
      let processedLineCount = 0;
      let parseFailureLineNumber: number | null = null;
      for (const line of newLines) {
        try {
          const entry = JSON.parse(line);
          processedLineCount++;
          if (entry.type === 'message' && entry.message?.role && entry.message?.content) {
            const outerTs = typeof entry.timestamp === 'string'
              ? Date.parse(entry.timestamp)
              : typeof entry.timestamp === 'number'
                ? entry.timestamp
                : NaN;
            // Prefer the outer entry timestamp when present/valid; otherwise keep any
            // timestamp the message already carries (do NOT clobber it to undefined —
            // some session formats put the timestamp only on the inner message).
            if (Number.isFinite(outerTs)) entry.message.timestamp = outerTs;
            entries.push(entry.message as ContextMessage);
          }
        } catch {
          parseFailureLineNumber = prevCount + processedLineCount + 1;
          break;
        }
      }
      const watermarkLineCount = prevCount + processedLineCount;
      const skippedLineCount = Math.max(0, allLines.length - watermarkLineCount);
      logger.info(`[memory-river] maintain parsed entries: entries.length=${entries.length} newLines.length=${newLines.length} processedLineCount=${processedLineCount} skippedLineCount=${skippedLineCount} watermarkLineCount=${watermarkLineCount} parseFailureLine=${parseFailureLineNumber ?? '(none)'}`);
      if (entries.length > 0) {
        logger.info(`[memory-river] archiveSnapshot 即將呼叫: entries.length=${entries.length} prevCount=${prevCount}`);
        const archiveResult = this.deps.transcriptArchive.archiveSnapshot(identity, entries);
        logger.info(`[memory-river] archiveSnapshot 回傳: ok=${archiveResult.ok} entries.length=${entries.length} prevCount=${prevCount}`);
        if (!archiveResult.ok) {
          logger.info(`[memory-river] maintain archiveSnapshot returned not ok: entries.length=${entries.length} canonicalKey=${identity.canonicalKey}`);
          return 'archive-returned-not-ok';
        }
        logger.info(`[memory-river] 📝 archiveSnapshot: ${entries.length} 筆新訊息歸檔 (lines ${prevCount}→${watermarkLineCount}) canonicalKey=${identity.canonicalKey}`);
        await this.persistArchivedLineCount(this.memoryStoreRef, identity.canonicalKey, currentSessionId, watermarkLineCount);
        logger.info(`[memory-river] maintain persistArchivedLineCount done: lineCount=${watermarkLineCount} canonicalKey=${identity.canonicalKey}`);
        return 'archive-ok';
      }

      if (processedLineCount > 0) {
        logger.info(`[memory-river] maintain branch: no parsed entries, persist line count=${watermarkLineCount} canonicalKey=${identity.canonicalKey}`);
        await this.persistArchivedLineCount(this.memoryStoreRef, identity.canonicalKey, currentSessionId, watermarkLineCount);
        logger.info(`[memory-river] maintain persistArchivedLineCount done: lineCount=${watermarkLineCount} canonicalKey=${identity.canonicalKey}`);
        return 'no-parsed-entries';
      }

      logger.info(`[memory-river] maintain branch: no processed lines, keep watermark=${prevCount} skippedLineCount=${skippedLineCount} canonicalKey=${identity.canonicalKey}`);
      return 'no-processed-lines';
    } catch (err) {
      const archiveErr = err as any;
      logger.error(`[memory-river] archiveSnapshot 失敗:`, { message: archiveErr?.message, stack: archiveErr?.stack });
      return 'archive-error-non-fatal';
    }
  }

  async maintain(params: any): Promise<any> {
    // B.P0-2：per-session lock，防 concurrent maintain 對同一 session 雙寫 archive
    const identity = resolveSessionIdentity(params);
    const lockKey = identity.canonicalKey;
    const logger = console;
    let exitReason = 'entered';
    const existing = this.maintainLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.maintainLocks.set(lockKey, next);
    await existing;

    try {
    logger.info(`[memory-river] 🛠️ maintain: canonicalKey=${identity.canonicalKey} source=${identity.source} hasSessionFile=${!!params?.sessionFile}`);
    logger.info(`[memory-river] maintain identity: hasIdentity=${!!identity} canonicalKey=${identity.canonicalKey} sessionKey=${identity.sessionKey ?? '(none)'} sessionId=${identity.sessionId ?? '(none)'} source=${identity.source}`);

    if (params?.sessionFile) {
        const record: SessionFileMappingRecord = {
            trackingKey: identity.canonicalKey,
            sessionKey: identity.sessionKey ?? undefined,
            sessionId: identity.sessionId ?? undefined,
            sessionFile: params.sessionFile,
            updatedAt: Date.now(),
            source: 'maintain',
        };
        this.setSessionFileMapping(identity.canonicalKey, record);
        logger.info(`[sessionMap] maintain captured canonicalKey=${identity.canonicalKey} sessionId=${record.sessionId ?? '(none)'} sessionFile=${record.sessionFile}`);
    } else {
        exitReason = 'no-session-file-param';
        logger.info(`[memory-river] maintain branch: no params.sessionFile canonicalKey=${identity.canonicalKey}`);
    }

    // 歸檔原始對話（給 memory_rehydrate 使用）
    // P0-2 修復：只歸檔自上次 maintain 以來新增的行，避免 O(n²) 重複寫入
    // Phase 4-2：lastArchivedLineCount 改為 canonicalKey 為 key；archiveSnapshot 接 identity，
    //          檔名仍由 sessionKey 衍生（Q6 漸進路徑）。
    if (params?.sessionFile) {
        exitReason = await this.archiveSessionFileTail(identity, params.sessionFile);
    } else {
        exitReason = 'archive-skipped-missing-identity-or-file';
        logger.info(`[memory-river] maintain branch: archive skipped hasSessionKey=${!!identity.sessionKey} hasSessionFile=false canonicalKey=${identity.canonicalKey}`);
    }

    if (exitReason === 'entered') exitReason = 'return-success';
    return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
    };
    } finally {
        logger.info(`[memory-river] maintain() exit canonicalKey=${identity.canonicalKey} reason=${exitReason}`);
        release();
        if (this.maintainLocks.get(lockKey) === next) {
            this.maintainLocks.delete(lockKey);
        }
    }
}

  async compact(params: any): Promise<any> {
  const { sessionId, sessionFile, force } = params;
  console.log(`[memory-river] compact() called by Core sessionId=${sessionId} force=${force}`);

  try {
    if (!this.activeConcentrator) {
      console.warn('[memory-river] compact: activeConcentrator not initialized');
      return { ok: false, compacted: false };
    }

    if (!sessionFile) {
      console.warn('[memory-river] compact: sessionFile path missing');
      return { ok: false, compacted: false };
    }

    if (
      this.activePluginConfig.concentration?.asyncCompactRaceGuard !== false &&
      params.expectedLineCount !== undefined &&
      params.expectedSize !== undefined &&
      params.expectedMtime !== undefined
    ) {
      const stat = await fs.promises.stat(sessionFile);
      const currentLineCount = await this.countFileLines(sessionFile);
      const lineDelta = currentLineCount - params.expectedLineCount;
      const sizeDelta = stat.size - params.expectedSize;
      const mtimeDelta = stat.mtimeMs - params.expectedMtime;

      if (lineDelta > 0 || sizeDelta > 0 || mtimeDelta > 100) {
        console.warn(`[compact] race detected: lineDelta=${lineDelta} sizeDelta=${sizeDelta} mtimeDelta=${mtimeDelta}, abort`);
        return { ok: false, compacted: false, aborted: true, reason: 'race-condition' };
      }
    }

    // 讀 jsonl
    const fsPromises = await import('fs/promises');
    const raw = await fsPromises.readFile(sessionFile, 'utf-8');
    const sessionFileSizeBeforeConcentration = Buffer.byteLength(raw, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);

    // 分離 session header 和 message entries
    let sessionHeader = '';
    const msgs: any[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (i === 0 && entry.type === 'session') {
          sessionHeader = lines[i];
          continue;
        }
        if (entry.type === 'message' && entry.message?.role && entry.message?.content) {
          const outerTs = typeof entry.timestamp === 'string'
            ? Date.parse(entry.timestamp)
            : typeof entry.timestamp === 'number'
              ? entry.timestamp
              : NaN;
          // Prefer the outer entry timestamp; otherwise keep any inner message
          // timestamp (do NOT clobber to undefined).
          if (Number.isFinite(outerTs)) entry.message.timestamp = outerTs;
          msgs.push(entry.message);
        }
      } catch { /* skip malformed line */ }
    }

    if (msgs.length === 0) {
      console.warn('[memory-river] compact: no messages available for compaction');
      return { ok: true, compacted: false };
    }

    const identity = resolveSessionIdentity(params);
    const canonicalKey = identity.canonicalKey;
    const mappingRecord: SessionFileMappingRecord = {
      trackingKey: canonicalKey,
      sessionKey: identity.sessionKey ?? undefined,
      sessionId: identity.sessionId ?? undefined,
      sessionFile,
      updatedAt: Date.now(),
      source: 'compact',
    };
    this.setSessionFileMapping(canonicalKey, mappingRecord);
    console.log(`[sessionMap] compact captured canonicalKey=${canonicalKey} sessionId=${mappingRecord.sessionId ?? '(none)'} sessionFile=${mappingRecord.sessionFile}`);
    if (this.wasRecentlyCompacted(canonicalKey)) {
      console.log(`[memory-river] compact: ${canonicalKey} was compacted within 60s; skipping duplicate compaction`);
      return { ok: true, compacted: false, deduped: true };
    }

    const existingArchive = this.maintainLocks.get(canonicalKey) ?? Promise.resolve();
    let releaseArchive!: () => void;
    const archiveLock = new Promise<void>(resolve => { releaseArchive = resolve; });
    this.maintainLocks.set(canonicalKey, archiveLock);
    await existingArchive;
    try {
      await this.archiveSessionFileTail(identity, sessionFile);
    } finally {
      releaseArchive();
      if (this.maintainLocks.get(canonicalKey) === archiveLock) {
        this.maintainLocks.delete(canonicalKey);
      }
    }

    // 執行濃縮（dryRun=false, force=true）
    const result = await this.activeConcentrator.concentrate(msgs, false, true, { sessionIdentity: identity });

    if (!result?.wasConcentrated || !result.messages) {
      console.warn('[memory-river] compact: compaction failed or returned no result');
      return { ok: true, compacted: false };
    }

    // 寫回 sessionFile（保留 header + 壓縮後的 messages）
    const newLines: string[] = [];
    if (sessionHeader) newLines.push(sessionHeader);

    for (const msg of result.messages) {
      newLines.push(JSON.stringify({
        type: 'message',
        timestamp: new Date().toISOString(),
        message: msg,
      }));
    }

    if ((await fsPromises.stat(sessionFile)).size > sessionFileSizeBeforeConcentration) {
      console.warn('[memory-river] compact: session file grew during concentration; skipping write-back');
      return { ok: true, compacted: false };
    }

    // P0-1 修復：原子寫入（先寫 .tmp 再 rename，防 crash 丟失資料）
    const tmpFile = `${sessionFile}.tmp-${process.pid}-${Date.now()}`;
    await fsPromises.writeFile(tmpFile, newLines.join('\n') + '\n', 'utf-8');
    await fsPromises.rename(tmpFile, sessionFile);

    console.log(`[memory-river] compact() complete; wrote back ${result.messages.length} messages`);
    this.markRecentlyCompacted(canonicalKey);
    const compactedTokens = this.activeConcentrator.estimateTokens(result.messages);
    this.setCompactWatermark(canonicalKey, compactedTokens);
    this.setWatermark(canonicalKey, compactedTokens);

    // P0-2 修復：compact 重寫了 sessionFile，重置歸檔 offset
    // Phase 4-2：archive offset map 統一以 canonicalKey 為 key
    this.lastArchivedLineCount.delete(canonicalKey);

    return { ok: true, compacted: true };

  } catch (err) {
    console.error('[memory-river] compact failed:', err);
    return { ok: false, compacted: false };
  }
}
}
