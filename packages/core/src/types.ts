/**
 * Unified Types - memory-river
 * Merged from v4/types.ts + context-river/concentrator.ts
 */
export type MemoryCategory =
  | "preference"
  | "fact"
  | "decision"
  | "entity"
  | "constraint"
  | "identity"
  | "business"
  | "knowledge"
  | "skill"
  | "other";

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "constraint",
  "identity",
  "business",
  "knowledge",
  "skill",
  "other",
] as const;

export const PROTECTED_CATEGORIES: MemoryCategory[] = [
  "constraint",
  "identity",
  "business",
];

export type HookWeight = "high" | "medium" | "low";

export interface MemoryHook {
  keyword: string;
  weight: HookWeight;
  weightScore: number; // high=1.0, medium=0.7, low=0.4
}

export interface HealthConfig {
  initialScore: number;
  decayPerRun: number;
  decayIntervalMs: number;
  deleteThreshold: number;
  coreCategories: string[];
  coreImportanceThreshold: number;
  skillDecayFactor: number;
}

export interface MemoryHealth {
  healthScore: number;
  lastAccessedAt: number;
  decayCount: number;
  accessCount: number;
  lastDecayedAt?: number;
  /** 記憶生命週期狀態 */
  status?: 'active' | 'superseded' | 'deprecated' | 'trashed';
  /** 標記為 deprecated 的時間戳（ms） */
  deprecatedAt?: number;
}

export interface MemoryEntry {
  id: string;
  text: string;
  textTokens?: string;
  vector: number[];
  importance: number;
  category: MemoryCategory;
  parentId: string | null;
  metadata?: string;
  createdAt: number;
  updatedAt: number;
  // ── Structured Slot 强索引（可選）──────────────────
  /** Slot key，格式：category:param，例如 "memory:drift_threshold" */
  slotKey?: string;
  /** Slot 值（僅 simple value：number | string | boolean） */
  slotValue?: number | string | boolean;
  /** 此記錄覆寫了哪些 id（建立更新鏈） */
  supersedes?: string[];
  /** LLM結構化抽取可靠性指標（0.0-1.0），未結構化時可省略 */
  confidence?: number;
  /** 抽取時的 domain 分類 */
  extractionDomain?: "technical" | "identity" | "preference" | "free_text";
  /** Unix ms timestamp of when this memory was last concentrated */
  lastConcentratedAt?: number;
  /** Unix ms timestamp of when this memory was last included in retrieval results */
  lastRecalledAt?: number;
  /** Number of times this memory has been included in retrieval results */
  recallCount?: number;
  /** Which session this was distilled from */
  sessionId?: string;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  /** @deprecated Use rankScore for ranking or rawDistance for distance thresholds. */
  vectorScore: number;
  /** Rank-based score used by hybrid retrieval. */
  rankScore: number;
  /** Original vector distance. Infinity when no vector result is available. */
  rawDistance: number;
  bm25Score: number;
  fusedScore: number;
  /** CRAG / reranker 評估後的最終分數 */
  finalScore?: number;
}

export interface EnumerationPlan {
  anchors: string[];
  setMode: 'union' | 'intersection' | 'compare';
  relationText?: string;
  direction?: 'out' | 'in' | 'both';
}

export interface EnumerationAnswer {
  entity: string;
  evidenceTriples: import('./store/graph-store.js').GraphTriple[];
  sourceMemoryIds: string[];
}

export interface EnumerationResult {
  answers: EnumerationAnswer[];
  truncated: boolean;
  fallbackUsed: boolean;
}

export type SubsystemEffectivenessSubsystem =
  | "causal_chain"
  | "hooks"
  | "gwm"
  | "plugin"
  | "conflict"
  | "skill_capsule"
  | (string & {});

export interface SubsystemEffectivenessEvent {
  id?: string;
  ts?: string;
  subsystem?: SubsystemEffectivenessSubsystem;
  event?: string;
  entityId?: string;
  relatedId?: string;
  sessionKey?: string;
  sessionId?: string;
  queryHash?: string;
  outcome?: string;
  count?: number;
  score?: number;
  durationMs?: number;
  metadata?: string | Record<string, unknown> | null;
}

export interface SubsystemEffectivenessRow {
  id: string;
  ts: string;
  subsystem: string;
  event: string;
  entityId: string;
  relatedId: string;
  sessionKey: string;
  sessionId: string;
  queryHash: string;
  outcome: string;
  count: number;
  score: number;
  durationMs: number;
  metadata: string;
}

export interface SubsystemEffectivenessQueryFilter {
  subsystem?: string;
  event?: string;
  outcome?: string;
  since?: string;
  limit?: number;
}

// ============================================================================
// Status Manager Types（P0-3: 記憶狀態單一所有人）
// ============================================================================

/** 記憶生命週期狀態 */
export type MemoryStatus =
  | 'active'      // 正常記憶
  | 'superseded'  // Skill Capsule 被同名新版取代
  | 'deprecated'  // 被覆寫/失效，還可被 rehydrate 找到
  | 'archived'    // NightConsolidator 整合後的歸檔
  | 'trashed';    // 等待物理刪除

/** 狀態變更原因（audit log 用） */
export type StatusChangeReason =
  | 'created'
  | 'slot_supersedes'
  | 'causal_update'
  | 'conflict_detected'
  | 'night_consolidation'
  | 'cleanup_decay'
  | 'saveSkill_supersede_rollback'
  | 'manual';

/** 狀態變更請求 */
export interface StatusChangeRequest {
  memoryId: string;
  toStatus: MemoryStatus;
  reason: StatusChangeReason;
  source: string;          // 寫入者名稱（audit 用）
  supersededBy?: string;   // 若是 deprecated，新版本 id
  meta?: Record<string, unknown>;  // 額外 audit 資訊
}

/** 狀態變更結果 */
export interface StatusChangeResult {
  ok: boolean;
  memoryId: string;
  fromStatus: MemoryStatus | null;
  toStatus: MemoryStatus;
  auditRowId: string;
  error?: string;
}

/** 狀態 audit log row（寫入 status_audit_log table） */
export interface StatusAuditRow {
  id: string;
  timestamp: number;
  memoryId: string;
  fromStatus: string | null;    // null = 首次建立
  toStatus: string;
  reason: string;
  source: string;
  supersededBy: string | null;
  meta: string | null;          // JSON
  canonicalKey: string | null;  // session 識別，nullable
  partial: boolean;             // true = metadata 寫入成功但 row.status 補寫失敗
}

export interface TranscriptWatermarkRow {
  canonicalKey: string;
  lineCount: number;
  updatedAt: number;
}

export type ConcentratorProvider = "gemini" | "deepseek" | "all_failed";
export type ConcentratorStatOutcome = "success" | "partial" | "failure";
export type ConcentratorFailureReason = "broken_json" | "timeout" | "quota" | "other";

export interface ConcentratorStat {
  id: string;
  canonicalKey: string;
  sessionId: string | null;
  provider: ConcentratorProvider;
  outcome: ConcentratorStatOutcome;
  attemptedProviders: string;
  inputTokens: number;
  outputTokens: number | null;
  durationMs: number;
  failureReason: ConcentratorFailureReason | null;
  createdAt: number;
}

export interface ContextMessage {
  role: "user" | "assistant" | "system";
  content: string | Array<{ type?: string; text?: string; [key: string]: unknown }>;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface RememberOptions {
  source?: "user" | "system" | "tool" | "capsule";
  urgency?: "low" | "normal" | "high";
  category?: string;
  importance?: number;
  tags?: string[];
}

export interface RecallOptions {
  limit?: number;
  categories?: string[];
}

export interface MemoryResult {
  id: string;
  text: string;
  source: "short" | "long";
  relevance: number;
  category: string;
  timestamp: number;
  health: number;
}

export interface RouteDecision {
  targets: ("short" | "long")[];
  category: string;
  importance: number;
  reason: string;
}

export interface RoutingContext {
  text: string;
  source: "user" | "system" | "tool" | "capsule";
  urgency: "low" | "normal" | "high";
  manualCategory?: string;
}

export type CapsuleType = "working_memory" | "skill_capsule";

export interface CapsuleSourceEntryRange {
  firstEntryId: number;
  lastEntryId: number;
  count: number;
}

export interface CapsuleMetadata {
  sourceEntryIds?: number[];
  sourceEntryRange?: CapsuleSourceEntryRange;
  lastRecalledAt?: number;
  recallCount?: number;
  [key: string]: unknown;
}

export interface CapsulePayload {
  summary: string;
  mode: "engineering" | "relationship";
  turnCount: number;
  truncatedAt: number;
}

export interface SkillCapsuleEntry extends MemoryEntry {
  capsuleType: CapsuleType;
  skillName: string;
  triggerConditions: string[];
  executionSteps: string[];
  confidence: number;
  sourcePatterns: number;
}

export interface InboxWriteOptions {
  category: string;
  importance: number;
  tags?: string[];
  metadata?: CapsuleMetadata;
}

/**
 * =============================================================================
 * 📋 Provider / Model 職責對照表（2026-04 現況）
 * =============================================================================
 *
 * 各模組實際使用的 Embedding Provider / Model 不一致，統一記錄於此，
 * 避免日後重構時踩到不相容的維度組合（Gemini 3072d vs Qwen 1024d）。
 *
 * ┌─────────────────────────┬──────────────┬──────────────────────────────────────────────┬─────────────┐
 * │ 模組                     │ Provider     │ Model                                       │ 向量維度    │
 * ├─────────────────────────┼──────────────┼──────────────────────────────────────────────┼─────────────┤
 * │ embedder-v4.legacy.ts   │ Gemini (硬綁)│ gemini-embedding-001                        │ 3072d       │
 * │ embedder-v5.ts (目前主力)│ Ollama (本地)│ hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF       │ 1024d ⚠️    │
 * │ causal-engine.ts        │ (引用 embedder-v5) 同上                                    │ 1024d ⚠️    │
 * │ concentrator-adapter.ts │ Gemini → DeepSeek（濃縮用，非 embedding）                    │ N/A         │
 * └─────────────────────────┴──────────────┴──────────────────────────────────────────────┴─────────────┘
 *
 * ⚠️ 向量維度不相容：v4 (Gemini 3072d) 和 v5 (Qwen 1024d) 使用不同的 LanceDB 实例。
 *    types.ts DEFAULT_CONFIG.embedding.provider="minimax" 僅為相容性宣告，
 *    實際 embedder-v5.ts 使用 Ollama，不受此欄位影響。
 *
 * Concentration（濃縮）Provider 順序：
 *   - 預設：Gemini → DeepSeek
 *   - Gemini 若連續 3 次 503：冷卻 90 秒，期間直接跳過 Gemini
 *   - concentrate() 全失敗時仍由 ConcentratorAdapter 走 deterministic fallback capsule
 *
 * =============================================================================
 */

export interface PluginConfig {
  embedding: {
    provider: "gemini" | "openai" | "ollama" | "minimax";
    apiKey?: string;
    minimaxApiKey?: string;
    model: string;
    dimensions?: number;
  };
  dbPath: string;
  ramDbPath?: string;
  storageMode?: 'auto' | 'ram' | 'ssd';
  inboxPath?: string;
  retrieval?: {
    vectorWeight?: number;
    bm25Weight?: number;
    candidatePoolMultiplier?: number;
  };
  cleanup?: {
    enabled?: boolean;
    decayDays?: number;
    deleteBelow?: number;
    trashRetentionDays?: number;
  };
  cleanupEngine?: {
    enabled?: boolean;
    decayDays?: number;
    deleteBelow?: number;
    trashRetentionDays?: number;
    coreCategories?: string[];
    coreImportanceThreshold?: number;
    skillCapsuleProtection?: boolean;
    useTrash?: boolean;
    dryRun?: boolean;
    maxStartupDelete?: number;
    maxStartupDecay?: number;
  };
  autoRecall?: boolean;
  driftThreshold?: number;
  health?: {
    initialScore?: number;
    decayPerRun?: number;
    decayIntervalMs?: number;
    deleteThreshold?: number;
    coreCategories?: string[];
    coreImportanceThreshold?: number;
    skillDecayFactor?: number;
  };
  hooks?: {
    enabled?: boolean;
    maxHooksPerMemory?: number;
    maxTriggerDepth?: number;
    minTriggerScore?: number;
    cooldownMs?: number;
  };
  causalEngine?: {
    updateThreshold?: number;
    causalThreshold?: number;
    embeddingModel?: string;
  };
  concentration?: {
    model?: string;
    provider?: 'gemini' | 'deepseek';
    geminiApiKey?: string;
    maxTokens?: number;
    deepseekApiKey?: string;
    deepseekModel?: string;
    asyncCompactAfterAssemble?: boolean;
    asyncCompactConcurrency?: number;
    asyncCompactRaceGuard?: boolean;
  };
}

export const DEFAULT_CONFIG: Omit<Required<PluginConfig>, 'dbPath' | 'ramDbPath' | 'inboxPath'> = {
  embedding: {
    provider: "minimax",
    model: "hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF",
    dimensions: 1024,
    apiKey: "",
    minimaxApiKey: "",
  },
  retrieval: {
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    candidatePoolMultiplier: 2,
  },
  cleanup: {
    enabled: true,
    decayDays: 30,
    deleteBelow: 0.1,
    trashRetentionDays: 7,
  },
  cleanupEngine: {
    enabled: true,
    decayDays: 30,
    deleteBelow: 0.1,
    trashRetentionDays: 7,
    coreCategories: ["identity", "preference", "constraint", "business", "decision", "core_rule"],
    coreImportanceThreshold: 0.75,
    skillCapsuleProtection: true,
    useTrash: true,
    dryRun: false,
    maxStartupDelete: 20,
    maxStartupDecay: 50,
  },
  autoRecall: true,
  storageMode: 'auto',
  driftThreshold: 0.78,
  health: {
    initialScore: 100,
    decayPerRun: 5,
    decayIntervalMs: 24 * 60 * 60 * 1000,
    deleteThreshold: 0,
    coreCategories: ["identity", "preference", "constraint", "business", "core_rule"],
    coreImportanceThreshold: 0.8,
    skillDecayFactor: 0.25,
  },
  hooks: {
    enabled: true,
    maxHooksPerMemory: 3,
    maxTriggerDepth: 1,
    minTriggerScore: 0.5,
    cooldownMs: 3600000,
  },
  causalEngine: {
    updateThreshold: 0.28,
    causalThreshold: 0.32,
    embeddingModel: "hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF",
  },
concentration: {
    model: 'gemini-2.5-flash-lite',
    /**
     * @deprecated 此欄位已失效。實際 fallback 順序由 concentrator-adapter.ts 內定
     *             （Gemini → DeepSeek），不受 config 影響。
     *             保留欄位以避免破壞既有宿主設定，請勿依賴其值。
     */
    provider: 'gemini',
    geminiApiKey: "",
    maxTokens: 8192,
    deepseekApiKey: "",
    deepseekModel: 'deepseek-v4-flash',
    asyncCompactAfterAssemble: false,
    asyncCompactConcurrency: 1,
    asyncCompactRaceGuard: true,
  },
};

export const CATEGORY_DESCRIPTIONS: Record<MemoryCategory, string> = {
  preference: "老闆的偏好、習慣、溝通風格",
  fact: "客觀事實、技術規格、數據",
  decision: "做過的決定、選擇",
  entity: "人物、組織、產品等實體",
  constraint: "鐵律、限制、紅線",
  identity: "身份認同、個人特徵",
  business: "商務營運、原創IP",
  knowledge: "其他知識",
  skill: "顯式保存的技能流程",
  other: "其他",
};

// ============================================================================
// Skill Capsule（技能膠囊）系統
// ============================================================================

export interface SkillDef {
  name: string;
  summary: string;
  triggers: string[];
  steps: string[];
}

export interface SkillIndexEntry {
  name: string;
  triggerConditions: string[];
  summary: string;
}

export interface SkillCapsuleV2 extends SkillIndexEntry {
  id: string;
  executionSteps: string[];
  category: "skill";
  importance: 0.7;
  capsuleVersion: 2;
  usageCount: number;
  lastUsedAt: number | null;
  status: "active" | "superseded";
  createdAt: number;
  updatedAt: number;
}

export interface SkillCapsule {
  id: string;
  skillName: string;
  triggerConditions: string[];
  executionSteps: string[];
  summary: string;
  confidence: number;
  category: string;
  createdAt: number;
  updatedAt: number;
  usageCount: number;
  lastUsedAt: number | null;
  status: "active" | "deprecated" | "trashed";
}

export interface HookStats {
  keyword: string;
  totalTriggers: number;
  successfulTriggers: number;
  failedTriggers: number;
  lastTriggeredAt: number | null;
}

// ─── Global Working Memory (GWM) ───────────────────────────────────────────
// GwmState is exported from global-working-memory.ts
