import { resolvePaths } from './paths.js';
import { resolveRamDbPath, type StorageMode } from './storage.js';
import type {
  EmbeddingProvider,
  LlmClient,
  Logger,
  Notifier,
  SessionFileAccess,
} from './ports.js';
import { MemoryRiverEngine, type MemoryRiverEngineDeps } from './engine.js';
import { rehydrate as rehydrateByIds, rehydrateByTime, type TranscriptEntry } from './transcript/rehydrate.js';
import { rehydrateByKeyword } from './transcript/rehydrate-keyword.js';
import { createTranscriptArchive, type ArchiveSnapshotResult } from './transcript/transcript-archive.js';
import {
  DEFAULT_CONFIG,
  type ContextMessage,
  type EnumerationPlan,
  type MemoryEntry,
  type MemorySearchResult,
  type PluginConfig,
  type SkillCapsuleV2,
  type SkillDef,
  type SkillIndexEntry,
  type StatusChangeRequest,
  type StatusChangeResult,
} from './types.js';

export type { EnumerationPlan } from './types.js';

export interface MemoryRiverConfig {
  dataDir: string;
  ramDir: string;
  storageMode?: StorageMode;
  embedding?: Partial<PluginConfig['embedding']>;
  retrieval?: PluginConfig['retrieval'];
  cleanup?: PluginConfig['cleanup'];
  cleanupEngine?: PluginConfig['cleanupEngine'];
  autoRecall?: boolean;
  driftThreshold?: number;
  health?: PluginConfig['health'];
  hooks?: PluginConfig['hooks'];
  causalEngine?: PluginConfig['causalEngine'];
  concentration?: PluginConfig['concentration'];
}

export interface MemoryRiverDeps {
  embedder: EmbeddingProvider;
  llm?: LlmClient;
  logger?: Logger;
  notifier?: Notifier;
  sessionFiles?: SessionFileAccess;
}

export interface SessionHint {
  sessionKey?: string;
  sessionId?: string;
}

export interface AssembleContextOptions {
  onAutoRecallResults?(event: { query: string; results: MemorySearchResult[] }): void;
}

export type RehydrateRequest =
  | { mode: 'entry_ids'; sessionKey: string; entryIds: number[]; bleed?: number; limit?: number }
  | { mode: 'time_range'; sessionKey: string; timestamp: string; windowMinutes?: number; limit?: number }
  | { mode: 'keyword'; keyword: string; sessionKey?: string; limit?: number; offset?: number };

export type MemoryUpdate = Partial<Pick<MemoryEntry, 'text' | 'category' | 'importance' | 'metadata'>>;

export interface MemoryRiver {
  start(): Promise<void>;
  stop(): Promise<void>;
  remember(text: string, opts?: { category?: string; importance?: number; metadata?: object }): Promise<void>;
  updateMemory(id: string, updates: MemoryUpdate): Promise<boolean>;
  setMemoryStatus(req: StatusChangeRequest): Promise<StatusChangeResult>;
  recall(query: string, limit?: number): Promise<MemorySearchResult[]>;
  enumerate(plan: EnumerationPlan, limit?: number): Promise<MemorySearchResult[]>;
  searchMemory(query: string, limit?: number): Promise<MemorySearchResult[]>;
  skills: {
    save(def: SkillDef): Promise<{ id: string }>;
    search(query: string, limit?: number): Promise<SkillIndexEntry[]>;
    load(name: string): Promise<SkillCapsuleV2 | null>;
    list(): Promise<SkillIndexEntry[]>;
  };
  rehydrate(req: RehydrateRequest): Promise<TranscriptEntry[]>;
  assembleContext(
    messages: ContextMessage[],
    session?: SessionHint,
    options?: AssembleContextOptions,
  ): Promise<{ messages: ContextMessage[] }>;
  archiveTranscript(session: SessionHint, messages: ContextMessage[]): Promise<ArchiveSnapshotResult>;
  compactSessionFile(session: SessionHint, opts?: object): Promise<{ ok: boolean; compacted: boolean }>;
  gwm: {
    on(name: string, desc: string, kw?: string[]): Promise<string>;
    off(): Promise<string>;
    status(): string;
    update(update: object): Promise<string>;
  };
  maintenance: {
    runCleanup(): Promise<object>;
    runNightConsolidation(): Promise<object>;
  };
}

const consoleLogger: Logger = {
  info: (msg, meta) => meta === undefined ? console.info(msg) : console.info(msg, meta),
  warn: (msg, meta) => meta === undefined ? console.warn(msg) : console.warn(msg, meta),
  error: (msg, meta) => meta === undefined ? console.error(msg) : console.error(msg, meta),
};
const noopNotifier: Notifier = { async notify() {} };

function mergeConfig(config: MemoryRiverConfig, dimensions: number): Required<PluginConfig> {
  const paths = resolvePaths(config);
  const storage = resolveRamDbPath({
    dbPath: paths.dbDir,
    ramDbPath: paths.ramDbDir!,
    storageMode: config.storageMode,
  });
  return {
    ...DEFAULT_CONFIG,
    ...config,
    embedding: { ...DEFAULT_CONFIG.embedding, ...config.embedding, dimensions },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...config.retrieval },
    cleanup: { ...DEFAULT_CONFIG.cleanup, ...config.cleanup },
    cleanupEngine: { ...DEFAULT_CONFIG.cleanupEngine, ...config.cleanupEngine },
    health: { ...DEFAULT_CONFIG.health, ...config.health },
    hooks: { ...DEFAULT_CONFIG.hooks, ...config.hooks },
    causalEngine: { ...DEFAULT_CONFIG.causalEngine, ...config.causalEngine },
    concentration: { ...DEFAULT_CONFIG.concentration, ...config.concentration },
    dbPath: paths.dbDir,
    ramDbPath: storage.ramDbPath,
    storageMode: config.storageMode ?? 'auto',
    inboxPath: paths.inboxDir,
  };
}

function textFromToolResult(result: any): string {
  return result?.content?.find?.((part: any) => part?.type === 'text')?.text ?? '';
}

export function createMemoryRiver(config: MemoryRiverConfig, deps: MemoryRiverDeps): MemoryRiver {
  const paths = resolvePaths(config);
  const transcriptArchive = createTranscriptArchive(paths.transcriptsDir);
  const sessionFiles = deps.sessionFiles ?? null;
  const engineDeps: MemoryRiverEngineDeps = {
    paths,
    transcriptArchive,
    embedder: deps.embedder,
    llm: deps.llm,
    logger: deps.logger ?? consoleLogger,
    notifier: deps.notifier ?? noopNotifier,
    deriveSessionFile: identity => sessionFiles?.resolveSessionFile(identity) ?? null,
    ollamaUrl: '',
    geminiApiKey: '',
    deepseekApiKey: '',
  };
  const engineConfig = mergeConfig(config, deps.embedder.getDimensions());
  const engine = new MemoryRiverEngine(engineConfig, engineDeps);
  engine.configure(engineConfig, engineDeps);

  return {
    async start() {
      engine.start();
      await engine.init();
    },
    async stop() {
      await engine.stop();
    },
    async remember(text, opts) {
      await engine.remember(text, opts);
    },
    updateMemory(id, updates) {
      return engine.updateMemory(id, updates);
    },
    setMemoryStatus(req) {
      return engine.setMemoryStatus(req);
    },
    recall(query, limit) {
      return engine.recall(query, limit);
    },
    enumerate(plan, limit) {
      return engine.enumerate(plan, limit);
    },
    searchMemory(query, limit) {
      return engine.searchMemory(query, limit);
    },
    skills: {
      save(def) {
        return engine.saveSkill(def);
      },
      search(query, limit) {
        return engine.searchSkills(query, limit);
      },
      load(name) {
        return engine.loadSkill(name);
      },
      list() {
        return engine.listSkills();
      },
    },
    async rehydrate(req) {
      if (req.mode === 'entry_ids') {
        return (await rehydrateByIds(
          transcriptArchive.getTranscriptPath(req.sessionKey),
          req.entryIds,
          req.bleed,
        )).slice(0, req.limit);
      }
      if (req.mode === 'time_range') {
        return (await rehydrateByTime(
          transcriptArchive.getTranscriptPath(req.sessionKey),
          req.timestamp,
          req.windowMinutes,
        )).slice(0, req.limit);
      }

      return rehydrateByKeyword(paths.transcriptsDir, req.keyword, {
        sessionKey: req.sessionKey,
        limit: req.limit,
        offset: req.offset,
      });
    },
    assembleContext(messages, session, options) {
      return engine.assemble({ messages, ...session, ...options });
    },
    async archiveTranscript(session, messages) {
      return await engine.archiveTranscript(session, messages);
    },
    async compactSessionFile(session, opts = {}) {
      const sessionFile = sessionFiles?.resolveSessionFile(session) ?? null;
      if (!sessionFile) return { ok: true, compacted: false };
      return engine.compact({ ...session, ...opts, sessionFile });
    },
    gwm: {
      async on(name, desc, kw) {
        return textFromToolResult(await engine.executeGwmOn({
          taskName: name,
          taskDescription: desc,
          keywords: kw,
        }));
      },
      async off() {
        return textFromToolResult(await engine.executeGwmOff());
      },
      status() {
        return textFromToolResult(engine.executeGwmStatus());
      },
      async update(update) {
        return textFromToolResult(await engine.executeGwmUpdate(update));
      },
    },
    maintenance: {
      async runCleanup() {
        await engine.init();
        await engine.runCleanupEngineNow('session-end');
        return { ok: true };
      },
      async runNightConsolidation() {
        await engine.init();
        await engine.runNightConsolidatorNow();
        return { ok: true };
      },
    },
  };
}
