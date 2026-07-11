/**
 * LanceDB Store - RAM + SSD Dual-Write Architecture with WAL
 * memory-river v4
 *
 * 核心原則:
 * - RAM Disk (/dev/shm) 為主要讀寫目標(極速)
 * - SSD 為異步備份(持久化)
 * - WAL (Write-Ahead Log) 保護 update/delete 一致性
 * - store() WAL + RAM 同步，SSD 異步寫入
 * - update/delete 必須 WAL 先行 → 雙寫 → WAL commit
 * - 讀取全部走 RAM(速度優先)
 * - crash recovery replays every WAL change at-least-once, including unacknowledged deletes
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Schema, Field, Int64, Utf8, Bool, Float64 } from "apache-arrow";
import type {
  ConcentratorStat,
  MemoryCategory,
  MemoryEntry,
  MemorySearchResult,
  MemoryHealth,
  SkillCapsule,
  StatusAuditRow,
  SubsystemEffectivenessEvent,
  SubsystemEffectivenessQueryFilter,
  SubsystemEffectivenessRow,
  TranscriptWatermarkRow,
} from "../types.js";
import {
  optimizeAuxTablesInConnection,
  recordAuxTableWrite,
} from "./aux-table-maintenance.js";

// 動態載入 jieba
let jieba: any = null;

const loadJieba = async (): Promise<any> => {
  if (jieba) return jieba;
  const module = await import("nodejieba");
  jieba = module.default ?? module;
  return jieba;
};

let lancedbImportPromise: Promise<any> | null = null;

const loadLanceDB = async (): Promise<any> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  return await lancedbImportPromise;
};

// ============================================================================
// LanceDB Store - RAM + SSD Dual-Write
// ============================================================================

const TABLE_NAME = "memories";
const SUBSYSTEM_EFFECTIVENESS_TABLE = "subsystem_effectiveness";
const CONCENTRATOR_STATS_TABLE = "concentrator_stats";
const CONFLICT_STATS_TABLE = "conflict_stats";
const NIGHT_CONSOLIDATION_STATS_TABLE = "night_consolidation_stats";
const WAL_METADATA_TABLE = "wal_metadata";
const STATUS_AUDIT_LOG_TABLE = "status_audit_log";
const TRANSCRIPT_WATERMARK_TABLE = "transcript_watermark";
const SSD_FAILURE_THRESHOLD = 5;
const DEFAULT_SSD_RECOVERY_PROBE_INTERVAL_MS = 60_000;
const VISIBILITY_OVERFETCH = 20;
const verifiedFtsLabels = new Set<string>();

export class SchemaViolationError extends Error {
  constructor(
    message: string,
    public readonly violations: string[],
  ) {
    super(message);
    this.name = "SchemaViolationError";
  }
}

// 預設健康度配置
const DEFAULT_HEALTH_CONFIG = {
  initialScore: 100,
  coreCategories: ["identity", "constraint", "business", "core_rule"],
  coreImportanceThreshold: 0.85,
  skillDecayFactor: 0.25,
};

const STRING_UPDATE_FIELDS = new Set([
  "id",
  "text",
  "textTokens",
  "category",
  "parentId",
  "metadata",
  "slotKey",
  "slotValue",
  "extractionDomain",
  "supersedes",
  "sessionId",
  "status",
]);

const BOOLEAN_UPDATE_FIELDS = new Set([
  "hasHooks",
]);

const NUMERIC_UPDATE_FIELDS = new Set([
  "importance",
  "createdAt",
  "updatedAt",
  "confidence",
  "lineCount",
  "lastConcentratedAt",
  "usageCount",
  "lastUsedAt",
]);

export function sqlStringLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function normalizeLanceUpdateValues(values: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;

    if (value === null) {
      normalized[key] = "NULL";
      continue;
    }

    if (STRING_UPDATE_FIELDS.has(key)) {
      normalized[key] = sqlStringLiteral(String(value));
      continue;
    }

    if (NUMERIC_UPDATE_FIELDS.has(key)) {
      const numeric = typeof value === "number" ? value : Number(value);
      normalized[key] = Number.isFinite(numeric) ? String(numeric) : "NULL";
      continue;
    }

    if (BOOLEAN_UPDATE_FIELDS.has(key)) {
      normalized[key] = value ? "TRUE" : "FALSE";
      continue;
    }

    if (typeof value === "string") {
      normalized[key] = sqlStringLiteral(value);
      continue;
    }

    if (typeof value === "number") {
      normalized[key] = Number.isFinite(value) ? String(value) : "NULL";
      continue;
    }

    if (typeof value === "boolean") {
      normalized[key] = value ? "TRUE" : "FALSE";
      continue;
    }

    normalized[key] = value;
  }

  return normalized;
}

function isValidRowId(row: any): row is { id: string } {
  return row != null && typeof row.id === 'string' && row.id.length > 0;
}

function isVisibleStatus(topStatus?: string, metaStatus?: string): boolean {
  const hiddenStatuses = new Set(["superseded", "deprecated", "trashed", "archived"]);
  return !hiddenStatuses.has(topStatus || "active") && !hiddenStatuses.has(metaStatus || "active");
}

function isLanceTableNotFoundError(err: any): boolean {
  const code = String(err?.code ?? "");
  const name = String(err?.name ?? "");
  const message = String(err?.message ?? err);
  return /TableNotFound/i.test(code)
    || /TableNotFound/i.test(name)
    || /not\s*found|does\s*not\s*exist|TableNotFound/i.test(message);
}

function metadataHasHooks(metadata: unknown): boolean {
  let meta: any = {};
  if (typeof metadata === "string") {
    if (metadata.trim() === "") return false;
    try {
      meta = JSON.parse(metadata);
    } catch {
      return false;
    }
  } else if (metadata && typeof metadata === "object") {
    meta = metadata;
  }
  return Array.isArray(meta?.hooks) && meta.hooks.length > 0;
}

type DecayOptions = {
  coreCategories?: string[];
  coreImportanceThreshold?: number;
  skillCapsuleProtection?: boolean;
  dryRun?: boolean;
  deleteWith?: (id: string) => Promise<boolean>;
  maxDelete?: number;
  maxDecay?: number;
};

type StoreEntryInput = Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "textTokens"> & {
  creationAuditSource?: string | null;
  creationAuditMeta?: Record<string, unknown>;
};

type ConcentratorStatInput = Omit<ConcentratorStat, "id" | "createdAt"> & {
  id?: string;
  createdAt?: number;
};

type ConflictStatInput = {
  ts?: number;
  operationName: string;
  callerPath?: string | null;
  attempt: number;
  finalOutcome: string;
  fragmentId?: string | number | null;
};

type NightConsolidationStatInput = {
  id?: string;
  runId: string;
  phase: string;
  ts?: number;
  outcome?: string | null;
  durationMs?: number | null;
  candidateCount?: number | null;
  scannedCount?: number | null;
  decisionCount?: number | null;
  mergeCount?: number | null;
  deleteCount?: number | null;
  deprecatedCount?: number | null;
  updateCount?: number | null;
  keepCount?: number | null;
  attemptedCount?: number | null;
  failedCount?: number | null;
  batchIndex?: number | null;
  batchSize?: number | null;
  driftMs?: number | null;
  scheduledFor?: number | null;
  errorMessage?: string | null;
  metadata?: string | Record<string, unknown> | null;
};

export class MemoryStore {
  // ── 雙寫連接 ────────────────────────────────────────────
  private ramDb: any = null;
  private ramTable: any = null;
  private ssdDb: any = null;
  private ssdTable: any = null;
  private subsystemEffectivenessRamTable: any = null;
  private subsystemEffectivenessSsdTable: any = null;
  private concentratorStatsRamTable: any = null;
  private concentratorStatsSsdTable: any = null;
  private conflictStatsRamTable: any = null;
  private conflictStatsSsdTable: any = null;
  private nightConsolidationStatsRamTable: any = null;
  private nightConsolidationStatsSsdTable: any = null;
  private walMetadataRamTable: any = null;
  private walMetadataSsdTable: any = null;
  private statusAuditLogRamTable: any = null;
  private statusAuditLogSsdTable: any = null;
  private transcriptWatermarkRamTable: any = null;
  private transcriptWatermarkSsdTable: any = null;
  private shutdownHooks: Array<() => Promise<void>> = [];

  private initPromise: Promise<void> | null = null;
  private healthConfig = DEFAULT_HEALTH_CONFIG;
  private readonly _embedder?: { embed(text: string): Promise<number[]> };

  // ── WAL 相關 ────────────────────────────────────────────
  private readonly walDir: string;
  private readonly walPath: string;
  private walRecovered = false; // WAL recovery 只執行一次
  private walTxnCounter = 0; // 單調遞增 transaction ID(精確控制 replay 順序)
  private lastCheckpointTxnId = 0;
  private walCheckpointInitialized = false;
  private walCheckpointUpdateQueue: Promise<void> = Promise.resolve();

  // ── RAM-Only Mode ───────────────────────────────────────
  private ssdAvailable = true;
  private ssdConsecutiveFailures = 0;
  private ssdRecoveryProbeTimer: NodeJS.Timeout | null = null;
  private ssdRecoveryProbeInFlight = false;
  private ftsAvailable = false;
  private readonly ssdFallback: boolean;

  constructor(
    private readonly dbPath: string,      // SSD 持久化路徑
    private readonly ramDbPath: string,    // RAM Disk 路徑
    private readonly vectorDim: number,
    walFileOrHealthConfig?: string | typeof DEFAULT_HEALTH_CONFIG,
    healthConfigOrEmbedder?: typeof DEFAULT_HEALTH_CONFIG | { embed(text: string): Promise<number[]> },
    embedder?: { embed(text: string): Promise<number[]> },
    private readonly ssdRecoveryProbeIntervalMs = DEFAULT_SSD_RECOVERY_PROBE_INTERVAL_MS,
  ) {
    this.ssdFallback = path.resolve(dbPath) === path.resolve(ramDbPath);
    const hasInjectedWal = typeof walFileOrHealthConfig === "string";
    const healthConfig = hasInjectedWal
      ? healthConfigOrEmbedder as typeof DEFAULT_HEALTH_CONFIG | undefined
      : walFileOrHealthConfig;
    this._embedder = hasInjectedWal
      ? embedder
      : healthConfigOrEmbedder as { embed(text: string): Promise<number[]> } | undefined;
    this.walPath = hasInjectedWal
      ? walFileOrHealthConfig
      : path.join(path.dirname(dbPath), "wal.jsonl");
    this.walDir = path.dirname(this.walPath);

    if (healthConfig) {
      this.healthConfig = { ...DEFAULT_HEALTH_CONFIG, ...healthConfig };
    }
  }

  // ── HookStats 持久化所需的公開 API ─────────────────────────────────────────

  public get db(): any {
    return this.ramDb;
  }

  /** SSD 持久化連接（供 GraphStore 共用） */
  public get ssd(): any {
    return this.ssdDb;
  }

  public onShutdown(fn: () => Promise<void>): void {
    this.shutdownHooks.push(fn);
  }

  public async ensureInitialized(): Promise<void> {
    if (this.ramTable) return;
    if (this.initPromise) return this.initPromise;
    (this as any)._ftsRetokenizingTables ??= new Set<any>();

    this.initPromise = this.doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    console.log(`[MemoryStore] Initializing... RAM=${this.ramDbPath} SSD=${this.dbPath}`);

    // ── Step 1: 確保 RAM 目錄存在 ──────────────────────
    const ramDir = this.ramDbPath;
    try {
      fs.mkdirSync(ramDir, { recursive: true });
    } catch (err: any) {
      console.error(`[MemoryStore] Failed to create RAM directory ${ramDir}:`, err.message);
      throw err;
    }

    // ── Step 2: 確保 WAL 目錄存在 ─────────────────────
    try {
      fs.mkdirSync(this.walDir, { recursive: true });
    } catch {}

    // ── Step 3: Hydration - 如果 RAM 是空的,從 SSD 拷貝 ─
    const ramContents = fs.readdirSync(ramDir);
    if (this.ssdFallback) {
      console.log('[MemoryStore] SSD fallback active; using one persistent store');
    } else if (ramContents.length === 0) {
      console.log('[MemoryStore] RAM directory is empty; starting hydration from SSD...');
      if (fs.existsSync(this.dbPath)) {
        fs.cpSync(this.dbPath, ramDir, { recursive: true });
        console.log('[MemoryStore] Hydration complete');
      } else {
        console.log('[MemoryStore] SSD path does not exist; creating a new database');
        // 確保 SSD 目錄也存在
        fs.mkdirSync(this.dbPath, { recursive: true });
      }
    } else {
      console.log(`[MemoryStore] RAM directory contains data; using it without hydration`);
    }

    // ── Step 4: 建立雙連接 ──────────────────────────────
    const lancedb = await loadLanceDB();

     this.ramDb = await lancedb.connect(this.ramDbPath);
     this.ssdDb = this.ssdFallback ? this.ramDb : await lancedb.connect(this.dbPath);
     if (this.ssdFallback) this.ssdAvailable = false;

    // ── Step 5: 開啟雙 Table ────────────────────────────
    this.ramTable = await this.initTable(this.ramDb, "ram");
    this.ssdTable = this.ssdFallback ? this.ramTable : await this.initTable(this.ssdDb, "ssd");
    await this.ensureWalMetadataTables();
    await this.cleanupLegacyWalMetadataRow();
    await this.restoreWalTxnCounter();

    // ── Step 6: WAL Recovery(只執行一次)──────────────
    if (!this.walRecovered) {
      console.log('[MemoryStore] Checking WAL recovery...');
      await this.recoverFromWal();
      this.walRecovered = true;
    }

    // ── Step 7: Migration - 修複 parentId 欄位(只執行一次)─
    if (!(this as any)._parentIdMigrationDone) {
      console.log('[MemoryStore] Running parentId field repair...');
      try {
        const all = await this.queryAll(10000);
        let fixed = 0;
        for (const entry of all) {
          if (entry.parentId) continue; // already has value
          try {
            const meta = typeof entry.metadata === 'string'
              ? JSON.parse(entry.metadata)
              : (entry.metadata || {});
            if (meta?.parentId) {
              await this.update(entry.id, { parentId: meta.parentId });
              fixed++;
            }
          } catch { /* ignore */ }
        }
        console.log(`[MemoryStore] parentId field repair complete: ${fixed} records repaired`);
      } catch (err: any) {
        console.warn('[MemoryStore] parentId field repair failed (non-fatal):', err.message);
      }
      (this as any)._parentIdMigrationDone = true;
    }

    await this.initSubsystemEffectivenessTable();
    await this.ensureConcentratorStatsTables();
    await this.ensureConflictStatsTables();
    await this.ensureNightConsolidationStatsTables().catch((err: any) => {
      console.warn("[MemoryStore] night_consolidation_stats initialization failed:", err?.message ?? err);
    });
    await this.ensureStatusAuditLogTables();
    await this.ensureTranscriptWatermarkTables();

    // ── Step 9: 確保 memories table 有 status column（P0-3 schema migration）─
    await this.ensureStatusColumn();

    console.log('[MemoryStore] Initialization complete');
  }

  private async initTable(db: any, label: string): Promise<any> {
    const tables = await db.tableNames();
    let table: any;

    if (tables.includes(TABLE_NAME)) {
      table = await db.openTable(TABLE_NAME);
      console.log(`[MemoryStore] [${label}] Opened existing table`);
    } else {
      console.log(`[MemoryStore] [${label}] Creating new table...`);
      const initialData = [{
        id: "init_00000000000000000000000000000000",
        text: "_SYSTEM_INIT_",
        textTokens: "_SYSTEM_INIT_",
        vector: Array(this.vectorDim).fill(0),
        importance: 0.0,
        category: "other",
        parentId: "",
        metadata: "{}",
        createdAt: 0,
        updatedAt: 0,
        slotKey: "",
        slotValue: "",
        confidence: 0.0,
        extractionDomain: "",
        supersedes: "[]",  // JSON string,與 LanceDB addColumns 保持一致
        hasHooks: false,
      }];
      table = await db.createTable(TABLE_NAME, initialData);
      console.log(`[MemoryStore] [${label}] New table created`);
    }

    // 確保 FTS index
    await this.ensureFtsIndex(table, label);
    await this.ensureHasHooksColumnAndIndex(table, label);
    return table;
  }

  private async ensureHasHooksColumnAndIndex(table: any, label: string): Promise<void> {
    const lancedb = await loadLanceDB();
    try {
      const currentSchema = await table.schema();
      const hasColumn = currentSchema.fields.some((field: any) => field.name === "hasHooks");
      if (!hasColumn) {
        await table.addColumns([{ name: "hasHooks", valueSql: "false" }]);
        console.log(`[MemoryStore] [${label}] hasHooks column added (default false)`);
      }

      const existingIndices = await (table as any).listIndices();
      const hasIndex = existingIndices.some((index: any) => index.columns?.includes("hasHooks"));
      if (!hasIndex) {
        await (table as any).createIndex("hasHooks", {
          config: lancedb.Index.btree(),
          replace: true,
        });
        console.log(`[MemoryStore] [${label}] hasHooks scalar index created`);
      }
    } catch (err: any) {
      console.warn(`[MemoryStore] [${label}] hasHooks column/index migration failed (non-fatal): ${err?.message ?? err}`);
    }
  }

  private async ensureFtsIndex(table: any, label: string): Promise<void> {
    const lancedb = await loadLanceDB();
    try {
      const existingIndices = await (table as any).listIndices();
      const hasTextTokensFts = existingIndices.some(
        (index: any) => index.indexType === "FTS" && index.columns?.includes("textTokens"),
      );
      if (!hasTextTokensFts) {
        const idx = lancedb.Index.fts();
        await (table as any).createIndex("textTokens", {
          config: idx,
          replace: true,
        });
      }

      // 立刻驗證(index 名稱為 column 名 + "_idx")
      const indices = await (table as any).listIndices();
      const textTokensIdx = indices.find((i: any) => i.columns?.includes("textTokens"));
      if (!textTokensIdx) {
        throw new Error(`FTS index on column 'textTokens' not found. Available: ${JSON.stringify(indices)}`);
      }
      if (textTokensIdx.indexType !== "FTS") {
        throw new Error(`FTS index type mismatch: expected FTS, got ${textTokensIdx.indexType}`);
      }
      if (!verifiedFtsLabels.has(label)) {
        console.log(`[MemoryStore] [${label}] FTS index validation passed (name=${textTokensIdx.name}, FTS)`);
        verifiedFtsLabels.add(label);
      }
      this.ftsAvailable = true;

      if (!hasTextTokensFts) {
        const retokenizingTables: Set<any> = (this as any)._ftsRetokenizingTables ??= new Set<any>();
        if (!retokenizingTables.has(table)) {
          retokenizingTables.add(table);
          void (async () => {
            const batchSize = 50;
            let offset = 0;
            let scannedRows = 0;
            let migratedRows = 0;
            console.log(`[MemoryStore] [${label}] Background multilingual FTS retokenization started`);
            try {
              await new Promise<void>(resolve => setImmediate(resolve));
              while (true) {
                const rows = await (table as any).query()
                  .select(["id", "text", "textTokens"])
                  .offset(offset)
                  .limit(batchSize)
                  .toArray();
                if (rows.length === 0) break;

                for (const row of rows) {
                  const textTokens = await this.tokenizeChinese(String(row.text ?? ""));
                  if (textTokens === String(row.textTokens ?? "")) continue;
                  await (table as any).update({
                    values: { textTokens },
                    where: `\`id\` = ${sqlStringLiteral(String(row.id))}`,
                  });
                  migratedRows++;
                }

                scannedRows += rows.length;
                offset += rows.length;
                console.log(
                  `[MemoryStore] [${label}] Background FTS retokenization progress: ` +
                  `scanned=${scannedRows} updated=${migratedRows}`,
                );
                if (rows.length < batchSize) break;
                await new Promise<void>(resolve => setImmediate(resolve));
              }
              console.log(
                `[MemoryStore] [${label}] Background multilingual FTS retokenization complete: ` +
                `scanned=${scannedRows} updated=${migratedRows}`,
              );
            } catch (err: any) {
              console.warn(
                `[MemoryStore] [${label}] Background FTS retokenization stopped:`,
                err?.message ?? err,
              );
            } finally {
              retokenizingTables.delete(table);
            }
          })();
        }
      }
    } catch (err: any) {
      console.error(`[MemoryStore] [${label}] Failed to create FTS index:`);
      console.error('  error:', err);
      console.error('  message:', err?.message);
      console.error('  stack:', err?.stack);
      throw err; // 驗證失敗直接拋,不要吞
    }
  }

  // ============================================================================
  // WAL 系統
  // ============================================================================

  /**
   * 寫入一筆 WAL 條目,自動附加單調遞增的 txnId。
   * ⚠️ txnId 是精確的 replay 順序控制依據,不可重複使用。
   */
  private async appendWal(entry: object): Promise<number> {
    const txnId = ++this.walTxnCounter;
    try {
      const line = JSON.stringify({ ...entry, txnId, timestamp: Date.now() }) + '\n';
      const fh = await fs.promises.open(this.walPath, 'a');
      try {
        await fh.appendFile(line, 'utf-8');
        await fh.datasync();
      } finally {
        await fh.close();
      }
    } catch (err: any) {
      console.error('[MemoryStore] WAL append failed:', err.message);
      throw err;
    }
    return txnId;
  }

  private async restoreWalTxnCounter(): Promise<void> {
    let maxWalTxnId = 0;
    if (fs.existsSync(this.walPath)) {
      try {
        const content = await fs.promises.readFile(this.walPath, 'utf-8');
        for (const line of content.trim().split('\n').filter(Boolean)) {
          try {
            const txnId = Number(JSON.parse(line).txnId ?? 0);
            if (txnId > maxWalTxnId) maxWalTxnId = txnId;
          } catch {}
        }
      } catch {}
    }

    const lastCommitted = await this.getLastCommittedTxnId();
    this.lastCheckpointTxnId = lastCommitted;
    this.walCheckpointInitialized = true;
    this.walTxnCounter = Math.max(this.walTxnCounter, maxWalTxnId, lastCommitted);
  }

  /**
   * 更新 wal_metadata 表的 last_committed_txn_id。
   * 寫入後即表示這筆 txnId 及之前的操作已安全落地。
   * ⚠️ 必須在 WAL commit line 寫入磁碟成功後才能更新(嚴格 ordered)。
   */
  private async updateWalMetadata(lastTxnId: number): Promise<void> {
    const update = this.walCheckpointUpdateQueue.then(async () => {
      const nextCheckpointTxnId = Math.max(lastTxnId, this.lastCheckpointTxnId);
      if (this.walCheckpointInitialized && nextCheckpointTxnId === this.lastCheckpointTxnId) {
        return;
      }

      try {
        await this.ensureWalMetadataTables();
        const now = Date.now();
        const metaRow = {
          id: "checkpoint",
          last_committed_txn_id: nextCheckpointTxnId,
          updatedAt: now,
        };
        const lancedb = await loadLanceDB();
        const arrowTable = (lancedb as any).makeArrowTable
          ? (lancedb as any).makeArrowTable([metaRow], {
              schema: new Schema([
                new Field("id", new Utf8(), false),
                new Field("last_committed_txn_id", new Int64()),
                new Field("updatedAt", new Int64()),
              ]),
            })
          : [metaRow];

        // RAM / SSD 都保留同一份 checkpoint。現行 recovery 先從 SSD hydrate 到 RAM，
        // 再由 RAM 進行讀取；雙寫可避免兩側 checkpoint 漂移。
        await this.walMetadataRamTable
          .mergeInsert(["id"])
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(arrowTable as any);
        await recordAuxTableWrite(this.walMetadataRamTable, "ram:wal_metadata");

        if (this.ssdAvailable && this.walMetadataSsdTable) {
          await this.walMetadataSsdTable
            .mergeInsert(["id"])
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll()
            .execute(arrowTable as any);
          await recordAuxTableWrite(this.walMetadataSsdTable, "ssd:wal_metadata");
        }
        this.lastCheckpointTxnId = nextCheckpointTxnId;
        this.walCheckpointInitialized = true;
        console.log(`[MemoryStore] [debug] WAL checkpoint persisted: txnId=${nextCheckpointTxnId}`);
      } catch (err: any) {
        console.error('[MemoryStore] WAL checkpoint persistence failed:', err.message);
      }
    });
    this.walCheckpointUpdateQueue = update;
    await update;
  }

  /**
   * 查詢目前已 commit 的最大 txnId(用於 recovery 起點)。
   * 回傳 0 表示尚無任何 commit 記錄。
   */
  private async getLastCommittedTxnId(): Promise<number> {
    try {
      await this.ensureWalMetadataTables();
      const result = await this.walMetadataRamTable
        .query()
        .where('id = "checkpoint"')
        .limit(1)
        .toArray();
      if (result.length > 0 && result[0].last_committed_txn_id !== undefined) {
        return Number(result[0].last_committed_txn_id);
      }
    } catch {}
    return 0;
  }

  private async commitWal(id: string, txnId: number): Promise<void> {
    try {
      const line = JSON.stringify({ action: "commit", id, txnId, timestamp: Date.now() }) + '\n';
      const fh = await fs.promises.open(this.walPath, 'a');
      try {
        await fh.appendFile(line, 'utf-8');
        await fh.datasync();
      } finally {
        await fh.close();
      }
      await this.updateWalMetadata(txnId);
    } catch (err: any) {
      console.error('[MemoryStore] WAL commit failed:', err.message);
      throw err;
    }
  }

  /**
   * WAL Recovery - 從上次已知的安全 checkpoint 開始 replay。
   *
   * At-least-once recovery:
   * 1. 所有已進 WAL 的變更都以冪等方式 replay（包括尚未 ack 的操作）
   * 2. 每筆 replay 成功後,立即更新 last_committed_txn_id(寫入 wal_metadata)
   * 3. 若 replay 到一半再次當機,下次重啟會重試保留的 WAL 條目
   *
   * ⚠️ txnId 小的先 replay(嚴格ordered),避免因果鏈順序錯亂。
   */
  private async recoverFromWal(): Promise<void> {
    try {
      if (!fs.existsSync(this.walPath)) {
        return;
      }

      const content = await fs.promises.readFile(this.walPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        return;
      }

      // 讀取上次已確認的 checkpoint
      const lastCommitted = await this.getLastCommittedTxnId();
      this.lastCheckpointTxnId = lastCommitted;
      this.walCheckpointInitialized = true;
      console.log(`[MemoryStore] WAL recovery: ${lines.length} records, previous checkpoint txnId=${lastCommitted}`);

      // 解析並依 txnId 排序(嚴格 ordered replay)
      const entries: any[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch {}
      }
      entries.sort((a, b) => (a.txnId ?? 0) - (b.txnId ?? 0));

      let replayCount = 0;
      let newLastCommitted = lastCommitted;
      let replayFailed = false;
      let failedTxnId = 0;

      for (const entry of entries) {
        const txnId = entry.txnId ?? 0;

        // 單筆操作的 checkpoint 會在 SSD fire-and-forget 完成前推進，因此即使 txn 已
        // checkpoint，仍須以 idempotent replay 確認 RAM/SSD 都已套用。
        if (txnId <= lastCommitted && entry.action === 'batch_update') {
          continue;
        }

        // commit 條目:更新 checkpoint
        if (entry.action === 'commit') {
          newLastCommitted = Math.max(newLastCommitted, txnId);
          await this.updateWalMetadata(newLastCommitted);
          console.log(`[MemoryStore] WAL commit checkpoint: txnId=${txnId}`);
          continue;
        }

        // insert/update/delete/batch_update:執行 replay
        const op = entry as any;
        try {
          console.log(`[MemoryStore] Replaying [${op.action}] id=${op.id || 'batch'} txnId=${txnId}...`);
          if (op.action === 'insert') {
            this.validateId(op.id);
            if (!op.row || op.row.id !== op.id) {
              throw new Error(`Invalid WAL insert row for id=${op.id}`);
            }
            const addIfMissing = async (table: any) => {
              const existingRows = await table.countRows(`id = '${op.id}'`);
              if (existingRows === 0) {
                const row = { ...op.row };
                try {
                  const schema = await table.schema?.();
                  if (schema?.fields?.some((field: any) => field.name === "hasHooks")) {
                    row.hasHooks = metadataHasHooks(row.metadata);
                  }
                } catch {}
                await table.add([row]);
              }
            };

            await addIfMissing(this.ramTable);
            if (!this.ssdAvailable && !this.ssdFallback) {
              throw new Error('SSD unavailable during insert replay');
            }
            if (!this.ssdFallback) {
              await addIfMissing(this.ssdTable);
            }
          } else if (op.action === 'update') {
            this.validateId(op.id);
            // F2:WAL 的 update values 可能含 vector 原始陣列——vector 必須走
            // values 多載、其餘欄位走 SQL 表達式多載,且同一張表的兩次 update
            // 要序列化(同 update() 本體,避免互搶 dataset version)。
            const { vector: replayVector, ...restReplayValues } = (op.values ?? {}) as Record<string, unknown>;
            const replayValues = normalizeLanceUpdateValues(restReplayValues);
            if (!this.ssdAvailable && !this.ssdFallback) {
              throw new Error('SSD unavailable during update replay');
            }
            const applyUpdate = async (table: any) => {
              await table.update(replayValues, { where: `id = '${op.id}'` });
              if (Array.isArray(replayVector)) {
                await table.update({ where: `id = '${op.id}'`, values: { vector: replayVector } });
              }
            };
            if (this.ssdFallback) {
              await applyUpdate(this.ramTable);
            } else {
              await Promise.all([
                applyUpdate(this.ramTable),
                applyUpdate(this.ssdTable),
              ]);
            }
          } else if (op.action === 'delete') {
            this.validateId(op.id);
            if (!this.ssdAvailable && !this.ssdFallback) {
              throw new Error('SSD unavailable during delete replay');
            }
            if (this.ssdFallback) {
              await this.ramTable.delete(`id = '${op.id}'`);
            } else {
              await Promise.all([
                this.ramTable.delete(`id = '${op.id}'`),
                this.ssdTable.delete(`id = '${op.id}'`),
              ]);
            }
          } else if (op.action === 'batch_update' && Array.isArray(op.entries)) {
            // P1 Fix #5: batch_update recovery
            const failedIds: string[] = [];
            for (const batchEntry of op.entries) {
              try {
                this.validateId(batchEntry.id);
                const replayValues = normalizeLanceUpdateValues({
                  metadata: batchEntry.metadata,
                  hasHooks: metadataHasHooks(batchEntry.metadata),
                  updatedAt: Date.now(),
                });
                await this.ramTable.update(
                  replayValues,
                  { where: `id = '${batchEntry.id}'` }
                );
                if (this.ssdAvailable) {
                  await this.ssdTable.update(
                    replayValues,
                    { where: `id = '${batchEntry.id}'` }
                  );
                }
              } catch (batchErr: any) {
                failedIds.push(batchEntry.id);
                console.warn(`[MemoryStore] batch_update replay failed for entry id=${batchEntry.id}:`, batchErr.message);
              }
            }
            if (failedIds.length > 0) {
              throw new Error(`batch_update replay failed for ids: ${failedIds.join(', ')}`);
            }
          }
          // replay 成功,立即更新 checkpoint(下次當機從這裡繼續)
          newLastCommitted = Math.max(newLastCommitted, txnId);
          await this.updateWalMetadata(newLastCommitted);
          console.log(`[MemoryStore] Replay succeeded [${op.action}] id=${op.id} txnId=${txnId}, checkpoint updated to ${newLastCommitted}`);
          replayCount++;
        } catch (err: any) {
          // replay 失敗停在這裡,下次重啟會再試
          console.error(`[MemoryStore] Replay failed [${op.action}] id=${op.id} txnId=${txnId}: ${err.message}`);
          console.error('[MemoryStore] Stopping recovery; the next restart will resume from the checkpoint');
          replayFailed = true;
          failedTxnId = txnId;
          break;
        }
      }

      if (replayFailed) {
        const remainingEntries = entries.filter((entry) => (entry.txnId ?? 0) >= failedTxnId);
        await this.rewriteWal(remainingEntries);
        console.log(`[MemoryStore] WAL recovery incomplete, keeping ${remainingEntries.length} records for next retry`);
        return;
      }

      if (replayCount === 0) {
        console.log('[MemoryStore] All WAL operations executed or confirmed; clearing WAL');
      } else {
        console.log(`[MemoryStore] WAL recovery complete; replayed ${replayCount} records`);
      }

      await this.clearWal();
    } catch (err: any) {
      console.error('[MemoryStore] WAL recovery error:', err.message);
    }
  }

  private async rewriteWal(entries: any[]): Promise<void> {
    const content = entries.length > 0
      ? entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
      : '';
    const tempPath = `${this.walPath}.recovery-${process.pid}-${Date.now()}`;
    try {
      const fh = await fs.promises.open(tempPath, 'wx');
      try {
        await fh.writeFile(content, 'utf-8');
        await fh.datasync();
      } finally {
        await fh.close();
      }
      await fs.promises.rename(tempPath, this.walPath);
    } catch (err) {
      await fs.promises.rm(tempPath, { force: true });
      throw err;
    }
  }

  private async clearWal(): Promise<void> {
    try {
      await fs.promises.writeFile(this.walPath, '', 'utf-8');
    } catch {}
  }

  // ============================================================================
  // RAM-Only Mode Handler
  // ============================================================================

  private handleSsdSuccess(): void {
    this.ssdConsecutiveFailures = 0;
  }

  private handleSsdError(err: any, operation: string): void {
    if (!this.ssdAvailable) return;
    this.ssdConsecutiveFailures++;
    if (this.ssdConsecutiveFailures < SSD_FAILURE_THRESHOLD) {
      console.warn(
        `[MemoryStore] SSD operation failed (${operation}); consecutive failures ${this.ssdConsecutiveFailures}/${SSD_FAILURE_THRESHOLD}. Error: ${err?.message ?? err}`,
      );
      return;
    }

    this.ssdAvailable = false;
    console.log(
      `[MemoryStore] SSD failed ${SSD_FAILURE_THRESHOLD} consecutive times; switching to RAM-Only Mode. Last operation: ${operation}. Error: ${err?.message ?? err}`,
    );
    this.startSsdRecoveryProbe();
    // TODO: 未來可發送 Discord 警告
  }

  private startSsdRecoveryProbe(): void {
    if (this.ssdRecoveryProbeTimer) return;

    this.ssdRecoveryProbeTimer = setInterval(() => {
      void this.probeSsdRecovery();
    }, this.ssdRecoveryProbeIntervalMs);
    this.ssdRecoveryProbeTimer.unref();
  }

  private async probeSsdRecovery(): Promise<void> {
    if (this.ssdAvailable || this.ssdRecoveryProbeInFlight || !this.ssdTable) return;

    this.ssdRecoveryProbeInFlight = true;
    try {
      await this.ssdTable.countRows();
      this.ssdAvailable = true;
      this.handleSsdSuccess();
      this.stopSsdRecoveryProbe();
      console.log('[MemoryStore] SSD recovery probe succeeded; leaving RAM-Only Mode');
    } catch (err: any) {
      console.warn(`[MemoryStore] SSD recovery probe failed; retries will continue. Error: ${err?.message ?? err}`);
    } finally {
      this.ssdRecoveryProbeInFlight = false;
    }
  }

  private stopSsdRecoveryProbe(): void {
    if (!this.ssdRecoveryProbeTimer) return;
    clearInterval(this.ssdRecoveryProbeTimer);
    this.ssdRecoveryProbeTimer = null;
  }

  private async ensureConcentratorStatsTable(db: any, cached: any, label: string): Promise<any> {
    if (cached) return cached;

    const tableName = CONCENTRATOR_STATS_TABLE;
    const schema = new Schema([
      new Field("id", new Utf8(), false),
      new Field("canonicalKey", new Utf8(), false),
      new Field("sessionId", new Utf8(), true),
      new Field("provider", new Utf8(), false),
      new Field("outcome", new Utf8(), false),
      new Field("attemptedProviders", new Utf8(), false),
      new Field("inputTokens", new Int64(), false),
      new Field("outputTokens", new Int64(), true),
      new Field("durationMs", new Int64(), false),
      new Field("failureReason", new Utf8(), true),
      new Field("createdAt", new Int64(), false),
    ]);

    try {
      const table = await db.openTable(tableName);
      const currentSchema = await table.schema();
      const existingFields = new Set(currentSchema.fields.map((field: any) => field.name));
      const missingColumns = [
        { name: "canonicalKey", valueSql: "'unknown'" },
        { name: "sessionId", valueSql: "CAST(NULL AS string)" },
        { name: "provider", valueSql: "'all_failed'" },
        { name: "attemptedProviders", valueSql: "'[]'" },
        { name: "inputTokens", valueSql: "0" },
        { name: "outputTokens", valueSql: "CAST(NULL AS BIGINT)" },
        { name: "durationMs", valueSql: "0" },
        { name: "failureReason", valueSql: "CAST(NULL AS string)" },
        { name: "createdAt", valueSql: "0" },
      ].filter((column) => !existingFields.has(column.name));

      if (missingColumns.length > 0) {
        await table.addColumns(missingColumns);
        console.log(`[MemoryStore] [${label}] concentrator_stats columns added: ${missingColumns.map(c => c.name).join(",")}`);
        return await db.openTable(tableName);
      }
      return table;
    } catch (err: any) {
      if (!isLanceTableNotFoundError(err)) throw err;
      await db.createEmptyTable(tableName, schema);
      const table = await db.openTable(tableName);
      console.log(`[MemoryStore] [${label}] concentrator_stats table created`);
      return table;
    }
  }

  private async ensureConcentratorStatsTables(): Promise<void> {
    this.concentratorStatsRamTable = await this.ensureConcentratorStatsTable(
      this.ramDb,
      this.concentratorStatsRamTable,
      "ram",
    );

    if (this.ssdAvailable) {
      try {
        this.concentratorStatsSsdTable = await this.ensureConcentratorStatsTable(
          this.ssdDb,
          this.concentratorStatsSsdTable,
          "ssd",
        );
        this.handleSsdSuccess();
      } catch (err: any) {
        this.handleSsdError(err, "ensure_concentrator_stats_table");
      }
    }
  }

  private async ensureConflictStatsTable(db: any, cached: any, label: string): Promise<any> {
    if (cached) return cached;

    const schema = new Schema([
      new Field("ts", new Int64(), false),
      new Field("operationName", new Utf8(), false),
      new Field("callerPath", new Utf8(), false),
      new Field("attempt", new Int64(), false),
      new Field("finalOutcome", new Utf8(), false),
      new Field("fragmentId", new Utf8(), true),
    ]);

    try {
      return await db.openTable(CONFLICT_STATS_TABLE);
    } catch (err: any) {
      if (!isLanceTableNotFoundError(err)) throw err;
      await db.createEmptyTable(CONFLICT_STATS_TABLE, schema);
      const table = await db.openTable(CONFLICT_STATS_TABLE);
      console.log(`[MemoryStore] [${label}] conflict_stats table created`);
      return table;
    }
  }

  private async ensureConflictStatsTables(): Promise<void> {
    this.conflictStatsRamTable = await this.ensureConflictStatsTable(
      this.ramDb,
      this.conflictStatsRamTable,
      "ram",
    );

    if (this.ssdAvailable) {
      try {
        this.conflictStatsSsdTable = await this.ensureConflictStatsTable(
          this.ssdDb,
          this.conflictStatsSsdTable,
          "ssd",
        );
        this.handleSsdSuccess();
      } catch (err: any) {
        this.handleSsdError(err, "ensure_conflict_stats_table");
      }
    }
  }

  private async ensureNightConsolidationStatsTable(db: any, cached: any, label: string): Promise<any> {
    if (cached) return cached;

    const schema = new Schema([
      new Field("id", new Utf8(), false),
      new Field("runId", new Utf8(), false),
      new Field("phase", new Utf8(), false),
      new Field("ts", new Int64(), false),
      new Field("outcome", new Utf8(), true),
      new Field("durationMs", new Int64(), true),
      new Field("candidateCount", new Int64(), true),
      new Field("scannedCount", new Int64(), true),
      new Field("decisionCount", new Int64(), true),
      new Field("mergeCount", new Int64(), true),
      new Field("deleteCount", new Int64(), true),
      new Field("deprecatedCount", new Int64(), true),
      new Field("updateCount", new Int64(), true),
      new Field("keepCount", new Int64(), true),
      new Field("attemptedCount", new Int64(), true),
      new Field("failedCount", new Int64(), true),
      new Field("batchIndex", new Int64(), true),
      new Field("batchSize", new Int64(), true),
      new Field("driftMs", new Int64(), true),
      new Field("scheduledFor", new Int64(), true),
      new Field("errorMessage", new Utf8(), true),
      new Field("metadata", new Utf8(), true),
    ]);

    try {
      return await db.openTable(NIGHT_CONSOLIDATION_STATS_TABLE);
    } catch (err: any) {
      if (!isLanceTableNotFoundError(err)) throw err;
      await db.createEmptyTable(NIGHT_CONSOLIDATION_STATS_TABLE, schema);
      const table = await db.openTable(NIGHT_CONSOLIDATION_STATS_TABLE);
      console.log(`[MemoryStore] [${label}] night_consolidation_stats table created`);
      return table;
    }
  }

  private async ensureNightConsolidationStatsTables(): Promise<void> {
    this.nightConsolidationStatsRamTable = await this.ensureNightConsolidationStatsTable(
      this.ramDb,
      this.nightConsolidationStatsRamTable,
      "ram",
    );

    if (this.ssdAvailable) {
      try {
        this.nightConsolidationStatsSsdTable = await this.ensureNightConsolidationStatsTable(
          this.ssdDb,
          this.nightConsolidationStatsSsdTable,
          "ssd",
        );
        this.handleSsdSuccess();
      } catch (err: any) {
        this.handleSsdError(err, "ensure_night_consolidation_stats_table");
      }
    }
  }

  private async ensureWalMetadataTable(db: any, cached: any, label: string): Promise<any> {
    if (cached) return cached;

    let table: any;
    try {
      table = await db.openTable(WAL_METADATA_TABLE);
    } catch {
      const schema = new Schema([
        new Field("id", new Utf8(), false),
        new Field("last_committed_txn_id", new Int64()),
        new Field("updatedAt", new Int64()),
      ]);
      await db.createEmptyTable(WAL_METADATA_TABLE, schema);
      table = await db.openTable(WAL_METADATA_TABLE);
      console.log(`[MemoryStore] [${label}] wal_metadata table created`);
    }

    return table;
  }

  private async ensureWalMetadataTables(): Promise<void> {
    this.walMetadataRamTable = await this.ensureWalMetadataTable(
      this.ramDb,
      this.walMetadataRamTable,
      "ram",
    );

    if (this.ssdAvailable) {
      try {
        this.walMetadataSsdTable = await this.ensureWalMetadataTable(
          this.ssdDb,
          this.walMetadataSsdTable,
          "ssd",
        );
        this.handleSsdSuccess();
      } catch (err: any) {
        this.handleSsdError(err, "ensure_wal_metadata_table");
      }
    }
  }

  private async cleanupLegacyWalMetadataRow(): Promise<void> {
    try {
      await this.ramTable.delete('id = "_wal_metadata"');
      if (this.ssdAvailable) {
        await this.ssdTable.delete('id = "_wal_metadata"');
      }
      console.log("[WAL] cleaned legacy _wal_metadata row from memories table");
    } catch (err: any) {
      console.warn("[WAL] legacy _wal_metadata cleanup skipped:", err.message);
    }
  }

  // ============================================================================
  // 工具方法
  // ============================================================================

  private async tokenizeChinese(text: string): Promise<string> {
    const spans = text.match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) ?? [];
    let jiebaModule: any = null;
    try {
      jiebaModule = await loadJieba();
    } catch {
      // Optional dependency: the fallback below still preserves ASCII words.
    }

    return spans.flatMap(span => {
      if (!/^\p{Script=Han}+$/u.test(span)) return [span];
      if (jiebaModule) {
        return jiebaModule.cut(span)
          .map((token: unknown) => String(token).trim())
          .filter(Boolean);
      }
      return [...span];
    }).join(" ");
  }

  private toJsVector(vector: any): number[] {
    if (!vector) return [];
    if (Array.isArray(vector)) return vector;
    if (vector.values && vector.values instanceof Float32Array) {
      return Array.from(vector.values);
    }
    try { return Array.from(vector); } catch { return []; }
  }

  private parseMetadata(metaStr: string | undefined): any {
    if (!metaStr) return {};
    try {
      return typeof metaStr === 'string' ? JSON.parse(metaStr) : metaStr;
    } catch {
      return {};
    }
  }

  private hasHooksFromMetadata(metadata: unknown): boolean {
    return metadataHasHooks(metadata);
  }

  // ========================================================================
  // CRUD Operations(雙寫架構)
  // ========================================================================

  /**
   * 🛡️ LanceDB Optimistic Concurrency 緩解器
   * 遇到 'Commit conflict' 時,隨機等待後重試 (Jitter Backoff)
   * 這對於雙寫與頻繁背景任務至關重要。
   */
  private async lancedbRetry<T>(operationName: string, fn: () => Promise<T>, maxRetries = 5): Promise<T> {
    let attempt = 1;
    const MAX_TOTAL_BACKOFF_MS = 5000;
    let totalWaited = 0;
    while (true) {
      try {
        return await fn();
      } catch (err: any) {
        const errMsg = err.message || String(err);
        if (errMsg.includes('Commit conflict') || errMsg.includes('concurrent commit')) {
          if (attempt >= maxRetries || totalWaited >= MAX_TOTAL_BACKOFF_MS) {
            this.recordConflictStatBestEffort({
              operationName,
              callerPath: this.extractCallerPath(),
              attempt,
              finalOutcome: "failed",
              fragmentId: this.extractFragmentId(errMsg),
            });
            throw new Error(`[MemoryStore] ${operationName} 遭遇 Commit Conflict,超過重試上限 (${maxRetries} 次 / ${MAX_TOTAL_BACKOFF_MS}ms): ${errMsg}`);
          }
          this.recordConflictStatBestEffort({
            operationName,
            callerPath: this.extractCallerPath(),
            attempt,
            finalOutcome: "retry",
            fragmentId: this.extractFragmentId(errMsg),
          });
          const backoff = Math.min(
            Math.floor(Math.random() * 200) + attempt * 150,
            MAX_TOTAL_BACKOFF_MS - totalWaited,
          );
          console.warn(`[MemoryStore] ${operationName} encountered a concurrency conflict; waiting ${backoff}ms before retry attempt ${attempt}...`);
          await new Promise(r => setTimeout(r, backoff));
          totalWaited += backoff;
          attempt++;
        } else {
          throw err;
        }
      }
    }
  }

  private extractFragmentId(message: string): string | null {
    const match = message.match(/Fragment\s*\{\s*id:\s*(\d+)/);
    return match?.[1] ?? null;
  }

  private extractCallerPath(): string {
    const stack = new Error().stack || "";
    const frames = stack.split("\n").slice(1);
    for (const frame of frames) {
      const match = frame.match(/\(([^()]+):\d+:\d+\)/) || frame.match(/\s+at\s+([^\s]+):\d+:\d+/);
      const file = match?.[1];
      if (!file) continue;
      if (file.includes("store-v4.")) continue;
      if (file.includes("node:") || file.includes("node_modules")) continue;
      if (!/(src|dist)\//.test(file)) continue;
      return file;
    }
    return "unknown";
  }

  private extractCallerPathFrames(limit = 2): string {
    const stack = new Error().stack || "";
    const frames: string[] = [];
    for (const frame of stack.split("\n").slice(1)) {
      const match = frame.match(/\(([^()]+):\d+:\d+\)/) || frame.match(/\s+at\s+([^\s]+):\d+:\d+/);
      const file = match?.[1];
      if (!file) continue;
      if (file.includes("store-v4.")) continue;
      if (file.includes("node:") || file.includes("node_modules")) continue;
      if (!/(src|dist|scripts|tests)\//.test(file)) continue;
      frames.push(file);
      if (frames.length >= limit) break;
    }
    return frames.length > 0 ? frames.join(">") : "unknown";
  }

  private recordConflictStatBestEffort(stat: ConflictStatInput): void {
    this.recordConflictStatRow(stat).catch((err: any) => {
      console.warn("[MemoryStore] Failed to write conflict_stats:", err?.message ?? err);
    });
  }

  private async recordConflictStatRow(stat: ConflictStatInput): Promise<void> {
    if (!this.ramDb) return;
    await this.ensureConflictStatsTables();

    const row = {
      ts: stat.ts ?? Date.now(),
      operationName: stat.operationName,
      callerPath: stat.callerPath || "unknown",
      attempt: Math.max(0, Math.floor(stat.attempt || 0)),
      finalOutcome: stat.finalOutcome,
      fragmentId: stat.fragmentId === undefined || stat.fragmentId === null ? null : String(stat.fragmentId),
    };

    await this.conflictStatsRamTable.add([row]);
    await recordAuxTableWrite(this.conflictStatsRamTable, "ram:conflict_stats");
    if (this.ssdAvailable && this.conflictStatsSsdTable) {
      await this.conflictStatsSsdTable.add([row])
        .then(async () => {
          this.handleSsdSuccess();
          await recordAuxTableWrite(this.conflictStatsSsdTable, "ssd:conflict_stats");
        })
        .catch((err: any) => {
          this.handleSsdError(err, "record_conflict_stat");
        });
    }
  }

  async recordConflictStat(stat: ConflictStatInput): Promise<void> {
    await this.ensureInitialized();
    await this.recordConflictStatRow(stat);
  }

  async recordNightConsolidationStat(stat: NightConsolidationStatInput): Promise<void> {
    try {
      await this.ensureInitialized();
      await this.ensureNightConsolidationStatsTables();

      const nullableInt = (value: number | null | undefined): number | null => {
        if (value === null || value === undefined) return null;
        const numeric = Number(value);
        return Number.isFinite(numeric) ? Math.floor(numeric) : null;
      };
      const metadata = stat.metadata && typeof stat.metadata !== "string"
        ? JSON.stringify(stat.metadata)
        : (stat.metadata ?? null);

      const row = {
        id: stat.id ?? randomUUID(),
        runId: stat.runId,
        phase: stat.phase,
        ts: nullableInt(stat.ts) ?? Date.now(),
        outcome: stat.outcome ?? null,
        durationMs: nullableInt(stat.durationMs),
        candidateCount: nullableInt(stat.candidateCount),
        scannedCount: nullableInt(stat.scannedCount),
        decisionCount: nullableInt(stat.decisionCount),
        mergeCount: nullableInt(stat.mergeCount),
        deleteCount: nullableInt(stat.deleteCount),
        deprecatedCount: nullableInt(stat.deprecatedCount),
        updateCount: nullableInt(stat.updateCount),
        keepCount: nullableInt(stat.keepCount),
        attemptedCount: nullableInt(stat.attemptedCount),
        failedCount: nullableInt(stat.failedCount),
        batchIndex: nullableInt(stat.batchIndex),
        batchSize: nullableInt(stat.batchSize),
        driftMs: nullableInt(stat.driftMs),
        scheduledFor: nullableInt(stat.scheduledFor),
        errorMessage: stat.errorMessage ? String(stat.errorMessage).slice(0, 500) : null,
        metadata,
      };

      await this.nightConsolidationStatsRamTable.add([row]);
      await recordAuxTableWrite(this.nightConsolidationStatsRamTable, "ram:night_consolidation_stats");
      if (this.ssdAvailable && this.nightConsolidationStatsSsdTable) {
        await this.nightConsolidationStatsSsdTable.add([row])
          .then(async () => {
            this.handleSsdSuccess();
            await recordAuxTableWrite(this.nightConsolidationStatsSsdTable, "ssd:night_consolidation_stats");
          })
          .catch((err: any) => {
            this.handleSsdError(err, "record_night_consolidation_stat");
          });
      }
    } catch (err: any) {
      console.warn("[MemoryStore] Failed to write night_consolidation_stats:", err?.message ?? err);
    }
  }

  private validateEntrySchema(entry: any): string[] {
    const violations: string[] = [];
    const isMsTimestamp = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value >= 1e12;
    const isUnitInterval = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

    if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
      violations.push("id-missing");
    } else if (!MemoryStore.UUID_RE.test(entry.id)) {
      violations.push("id-invalid");
    }
    if (!isMsTimestamp(entry.createdAt)) violations.push("createdAt-not-ms");
    if (!isMsTimestamp(entry.updatedAt)) violations.push("updatedAt-not-ms");
    if (!isUnitInterval(entry.importance)) violations.push("importance-out-of-range");
    if (entry.confidence !== null && entry.confidence !== undefined && !isUnitInterval(entry.confidence)) {
      violations.push("confidence-out-of-range");
    }
    if (typeof entry.text !== "string" || entry.text.trim().length === 0) {
      violations.push("text-empty");
    }
    if (!Array.isArray(entry.vector) || entry.vector.length !== this.vectorDim) {
      violations.push("vector-invalid");
    } else if (entry.vector.some((value: unknown) => typeof value !== "number" || !Number.isFinite(value))) {
      violations.push("vector-non-finite");
    }

    let metadata: any = {};
    try {
      metadata = typeof entry.metadata === "string" ? JSON.parse(entry.metadata) : entry.metadata;
    } catch {
      violations.push("metadata-invalid-json");
    }
    const health = metadata?.health;
    if (!health || typeof health !== "object") {
      violations.push("metadata-health-missing");
    } else {
      if (typeof health.healthScore !== "number" || !Number.isFinite(health.healthScore)) {
        violations.push("metadata-healthScore-invalid");
      }
      if (typeof health.accessCount !== "number" || !Number.isFinite(health.accessCount)) {
        violations.push("metadata-accessCount-invalid");
      }
      if (!isMsTimestamp(health.lastAccessedAt)) {
        violations.push("metadata-lastAccessedAt-not-ms");
      }
    }

    return violations;
  }

  private async rejectSchemaViolation(entry: any, violations: string[]): Promise<never> {
    const id = typeof entry?.id === "string" && MemoryStore.UUID_RE.test(entry.id) ? entry.id : "<missing-id>";
    const callerPath = `${this.extractCallerPathFrames(2)} violations=${violations.join(",")}`;
    const message = `[MemoryStore] schema violation rejected id=${id} violations=${violations.join(",")}`;
    console.error(message);
    try {
      await this.recordConflictStatRow({
        operationName: "schema_violation",
        callerPath,
        attempt: 0,
        finalOutcome: "rejected",
        fragmentId: id,
      });
    } catch (metricErr: any) {
      console.error("[MemoryStore] schema violation metric write failed:", metricErr?.message ?? metricErr);
    }
    throw new SchemaViolationError(message, violations);
  }

  /**
   * store() - append-only,風險最低
   * RAM 同步寫(快),SSD 異步寫(fire-and-forget)
   * WAL 在回應前同步落地，SSD 若未完成可於重啟時補寫
   */
  private static readonly MAX_TEXT_LENGTH = 50_000; // 50K chars ≈ ~12K tokens

async store(entry: StoreEntryInput): Promise<MemoryEntry> {
    await this.ensureInitialized();

    // 文字長度邊界:超長輸入截斷而非崩潰
    if (entry.text && entry.text.length > MemoryStore.MAX_TEXT_LENGTH) {
      console.warn(`[MemoryStore] Text exceeds limit (${entry.text.length} chars); truncating to ${MemoryStore.MAX_TEXT_LENGTH}`);
      entry = { ...entry, text: entry.text.slice(0, MemoryStore.MAX_TEXT_LENGTH) };
    }

    // 🛡️ 終極防爆閥:檢查空值、長度不對、以及陣列裡面是不是裝滿了垃圾 (null/NaN)
    const vec = (entry as any).vector;

    // 1. 基本存在檢查
    if (!vec || !Array.isArray(vec)) {
      throw new Error(`Invalid vector rejected: not an array`);
    }

    // 2. 維度長度檢查 (這非常重要,必須符合你在 index.ts 設定的 1024 維)
    if (vec.length !== this.vectorDim) {
      throw new Error(`Invalid vector rejected: expected length ${this.vectorDim}, got ${vec.length}`);
    }

    // 3. 內容合法性檢查 (抓出幽靈!檢查是不是第一個元素就是 null, undefined 或 NaN)
    if (vec[0] == null || isNaN(vec[0])) {
      const preview = (entry.text || '').slice(0, 50);
      console.error(`[MemoryStore] Invalid vector rejected for "${preview}...": content contains NaN or null`);
      throw new Error(`Invalid vector rejected for: ${preview}`);
    }


    const textTokens = await this.tokenizeChinese(entry.text);
    const nowMs = Date.now();

    const metaObj = this.parseMetadata(entry.metadata);
    if (!metaObj.status) {
      this.initializeCreationStatus(metaObj);
    }

    const isCore = this.healthConfig.coreCategories.includes(entry.category) ||
                   entry.importance >= this.healthConfig.coreImportanceThreshold;
    const isCapsule = !!(metaObj as any)?.capsuleType;
    const healthScore = isCore ? 100 : isCapsule ? 30 : this.healthConfig.initialScore;

    if (!metaObj.health) {
      metaObj.health = { healthScore, lastAccessedAt: nowMs, decayCount: 0, accessCount: 0, lastDecayedAt: nowMs };
    }

    // supersedes 是 string[],LanceDB 存成 JSON string
    // slotValue 可能是 object/array,也需要 JSON string
    const rawImportance = typeof entry.importance === 'number'
        ? entry.importance
        : parseFloat(entry.importance as any);
    const parsedImportance = Number.isFinite(rawImportance) ? rawImportance : 0.5;
    const sanitizedImportance = Math.max(0, Math.min(1, parsedImportance));
    if (sanitizedImportance !== parsedImportance) {
      console.warn(`[MemoryStore] importance out of range (${parsedImportance}), clamped to ${sanitizedImportance}`);
    }

    const sanitizedConfidence = entry.confidence !== undefined
        ? (typeof entry.confidence === 'number' && !isNaN(entry.confidence)
            ? entry.confidence
            : parseFloat(entry.confidence as any) || undefined)
        : undefined;

    // 🛡️ 根治 LanceDB Arrow 崩潰:只挑選 LanceDB schema 已知的欄位 🛡️
    // 且強制將所有 string 欄位轉型,如果收到 [] 陣列(LLM 幻覺)也能順利存入
    const safeString = (val: any) => {
      if (val === null || val === undefined) return val;
      if (typeof val === 'object') return JSON.stringify(val);
      return String(val);
    };

    const fullEntry: any = {
      id: randomUUID(),
      text: safeString(entry.text) || "",
      textTokens: safeString(textTokens),
      vector: entry.vector,
      importance: sanitizedImportance,
      category: safeString(entry.category) || "free_text",
      parentId: entry.parentId ? safeString(entry.parentId) : null,
      metadata: JSON.stringify(metaObj),
      createdAt: nowMs,
      updatedAt: nowMs,
      // 🛡️ LanceDB Node Binding Bug: Any dynamically added column that is OMITTED or set to undefined
      // triggers a Rust Panic or an Arrow Utf8 0-byte buffer overflow in subsequent batches!
      // The ONLY safe way to handle missing optional fields is to explicitly pass `null`.
      confidence: sanitizedConfidence !== undefined ? sanitizedConfidence : null,
      slotKey: entry.slotKey ? safeString(entry.slotKey) : null,
      slotValue: entry.slotValue !== undefined
          ? (typeof entry.slotValue === 'object' ? JSON.stringify(entry.slotValue) : entry.slotValue)
          : null,
      extractionDomain: entry.extractionDomain ? safeString(entry.extractionDomain) : null,
      supersedes: Array.isArray(entry.supersedes) && entry.supersedes.length > 0
          ? JSON.stringify(entry.supersedes)
          : null,
      lastConcentratedAt: entry.lastConcentratedAt ?? null,
      sessionId: entry.sessionId ? safeString(entry.sessionId) : null,
      // P0-3: 新記憶建立時直接以 active 寫入，避免 NOT NULL status schema 與二段補寫衝突。
      status: safeString(metaObj.status) || 'active',
      hasHooks: this.hasHooksFromMetadata(metaObj),
    };

    const schemaViolations = this.validateEntrySchema(fullEntry);
    if (schemaViolations.length > 0) {
      await this.rejectSchemaViolation(fullEntry, schemaViolations);
    }

    // WAL 先行，完整 row（含 vector）必須在回應前落地。
    const txnId = await this.appendWal({ action: "insert", id: fullEntry.id, row: fullEntry });

    // RAM 同步寫(主要)
    await this.lancedbRetry('store:ram', () => this.ramTable.add([fullEntry]));

    // SSD 異步寫(備份,fire-and-forget)
    if (this.ssdAvailable) {
      this.lancedbRetry('store:ssd', () => this.ssdTable.add([fullEntry]))
        .then(() => this.handleSsdSuccess())
        .catch((err: any) => {
          this.handleSsdError(err, 'store');
        });
    }

    // RAM 寫入成功後標記 transaction committed；SSD 可由 recovery 冪等補寫。
    await this.commitWal(fullEntry.id, txnId);

    await this.safeRecordCreationAudit({
      memoryId: fullEntry.id,
      source: entry.creationAuditSource ?? 'memory-store.store',
      meta: entry.creationAuditMeta,
    });

    return fullEntry;
  }

  /**
   * update() - 危險操作,WAL 先行
   * 1. append WAL(先寫 log)
   * 2. RAM + SSD 同時更新
   * 3. WAL commit
   */
  // newVector：F2 修復 — 改字不改向量。updates 物件本身仍禁止帶 vector（FORBIDDEN 檢查
  // 原樣保留，外部 caller 無法透過 updates 塞 vector），caller 需重新嵌入後經這個獨立參數傳入。
  async update(
    id: string,
    updates: Partial<Omit<MemoryEntry, "id" | "createdAt">>,
    newVector?: number[],
  ): Promise<boolean> {
    await this.ensureInitialized();

    const FORBIDDEN_UPDATE_FIELDS = ['id', 'textTokens', 'vector', 'createdAt'];
    for (const k of FORBIDDEN_UPDATE_FIELDS) {
      if (k in updates) {
        throw new Error(`update() rejected: cannot modify immutable field '${k}'`);
      }
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) throw new Error(`Invalid memory ID format: ${id}`);

    let values: any = { ...updates, updatedAt: Date.now() };

    if (updates.text) {
      values.textTokens = await this.tokenizeChinese(updates.text);
      values.text = updates.text;
    }
    if (updates.parentId !== undefined) values.parentId = updates.parentId || '';
    if (updates.metadata !== undefined) {
        // 如果 metadata 內有 parentId,同步更新 parentId 欄位
        try {
            const meta = typeof updates.metadata === 'string'
                ? JSON.parse(updates.metadata)
                : updates.metadata;
            if (meta?.parentId) {
                values.parentId = meta.parentId;
            }
        } catch { /* ignore parse errors */ }
        values.hasHooks = this.hasHooksFromMetadata(updates.metadata);
    }
    if (updates.importance !== undefined) values.importance = Number(values.importance);
    if (newVector !== undefined) values.vector = newVector;

    // 1. WAL 先行(取得 txnId)：values 含 vector（若有）一併落地
    const txnId = await this.appendWal({ action: "update", id, values });

    // vector 必須走 LanceDB update() 的 values 多載（吃原始陣列），
    // 其餘欄位沿用既有的 valuesSql 多載（SQL literal 字串），兩者不可混用同一次呼叫。
    const { vector: _vectorForWal, ...restValues } = values;
    const lanceValues = normalizeLanceUpdateValues(restValues);

    // 2. RAM 同步更新(主要),SSD 異步降級(備份)
    await this.lancedbRetry('update:ram', () => this.ramTable.update(lanceValues, { where: `id = '${id}'` }));
    if (newVector !== undefined) {
      await this.lancedbRetry('update:ram-vector', () => this.ramTable.update({ where: `id = '${id}'`, values: { vector: newVector } }));
    }
    if (this.ssdAvailable) {
      // 兩個 SSD update 呼叫必須序列化（不能同時對同一張 LanceDB table 並發送出兩個
      // update commit），否則會互相搶 dataset version 造成 commit 失敗。
      let ssdChain = this.lancedbRetry('update:ssd', () => this.ssdTable.update(lanceValues, { where: `id = '${id}'` }));
      if (newVector !== undefined) {
        ssdChain = ssdChain.then(() =>
          this.lancedbRetry('update:ssd-vector', () => this.ssdTable.update({ where: `id = '${id}'`, values: { vector: newVector } }))
        );
      }
      ssdChain
        .then(() => this.handleSsdSuccess?.())
        .catch((err: any) => {
          this.handleSsdError(err, 'update');
        });
    }


    // 3. WAL commit(含 txnId,更新 checkpoint metadata)
    await this.commitWal(id, txnId);

    return true;
  }

  /**
   * delete() - 危險操作,WAL 先行
   * 1. WAL 先行
   * 2. RAM + SSD 同時刪
   * 3. WAL commit
   */
  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();
    this.validateId(id);

    // 1. WAL 先行(取得 txnId)
    const txnId = await this.appendWal({ action: "delete", id });

    // 2. RAM 同步刪除(主要),SSD 異步降級(備份)
    await this.lancedbRetry('delete:ram', () => this.ramTable.delete(`id = '${id}'`));
    if (this.ssdAvailable) {
      this.lancedbRetry('delete:ssd', () => this.ssdTable.delete(`id = '${id}'`))
        .then(() => this.handleSsdSuccess())
        .catch((err: any) => {
          this.handleSsdError(err, 'delete');
        });
    }


    // 3. WAL commit(含 txnId,更新 checkpoint metadata)
    await this.commitWal(id, txnId);

    return true;
  }

  // ========================================================================
  // 讀取操作(全部只讀 RAM - 速度優先)
  // ========================================================================

  private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private validateId(id: string): void {
    if (!MemoryStore.UUID_RE.test(id)) {
      throw new Error(`[MemoryStore] Invalid id format: ${id.slice(0, 40)}`);
    }
  }

  async getById(id: string, includeAllStatus = false): Promise<MemoryEntry | null> {
    await this.ensureInitialized();
    this.validateId(id);
    const results = await this.ramTable.query().where(`id = '${id}'`).limit(1).toArray();
    if (results.length === 0) return null;

    const row = includeAllStatus
      ? results[0]
      : results.find((candidate: any) => {
          const topStatus = (candidate.status as string) || 'active';
          const metaStatus = (() => { try { const m = this.parseMetadata(candidate.metadata); return m?.status; } catch { return undefined; } })();
          return topStatus === 'active' && (metaStatus == null || metaStatus === 'active');
        });
    if (!row) return null;

    return {
      id: row.id as string,
      text: row.text as string,
      textTokens: row.textTokens as string,
      vector: this.toJsVector(row.vector),
      importance: row.importance as number,
      category: row.category as MemoryCategory,
      parentId: row.parentId as string | null,
      metadata: row.metadata as string || '{}',
      createdAt: Number(row.createdAt) || Date.now(),
      updatedAt: Number(row.updatedAt) || Date.now(),
    };
  }

  async getByIds(ids: string[], includeAllStatus = false): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    if (ids.length === 0) return [];

    const uniqueIds: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      this.validateId(id);
      if (!seen.has(id)) {
        seen.add(id);
        uniqueIds.push(id);
      }
    }
    if (uniqueIds.length === 0) return [];

    const rowsById = new Map<string, any>();
    const chunkSize = 200;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const chunk = uniqueIds.slice(i, i + chunkSize);
      const predicate = `\`id\` IN (${chunk.map(sqlStringLiteral).join(", ")})`;
      const rows = await this.ramTable.query()
        .where(predicate)
        .limit(chunk.length)
        .toArray();

      for (const row of rows) {
        const id = row.id as string;
        if (rowsById.has(id)) continue;
        if (!includeAllStatus) {
          const topStatus = (row.status as string) || 'active';
          const metaStatus = (() => { try { const m = this.parseMetadata(row.metadata); return m?.status; } catch { return undefined; } })();
          if (topStatus !== 'active' || (metaStatus != null && metaStatus !== 'active')) continue;
        }
        rowsById.set(id, row);
      }
    }

    const entries: MemoryEntry[] = [];
    for (const id of uniqueIds) {
      const row = rowsById.get(id);
      if (!row) continue;
      entries.push({
        id: row.id as string,
        text: row.text as string,
        textTokens: row.textTokens as string,
        vector: this.toJsVector(row.vector),
        importance: row.importance as number,
        category: row.category as MemoryCategory,
        parentId: row.parentId as string | null,
        metadata: row.metadata as string || '{}',
        createdAt: Number(row.createdAt) || Date.now(),
        updatedAt: Number(row.updatedAt) || Date.now(),
      });
    }

    return entries;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return await this.ramTable.countRows();
  }

  private async ensureSubsystemEffectivenessTable(db: any, cached: any, label: string): Promise<any> {
    if (cached) return cached;

    const schema = new Schema([
      new Field("id", new Utf8(), false),
      new Field("ts", new Utf8(), false),
      new Field("subsystem", new Utf8(), false),
      new Field("event", new Utf8(), false),
      new Field("entityId", new Utf8(), false),
      new Field("relatedId", new Utf8(), false),
      new Field("sessionKey", new Utf8(), false),
      new Field("sessionId", new Utf8(), false),
      new Field("queryHash", new Utf8(), false),
      new Field("outcome", new Utf8(), false),
      new Field("count", new Int64(), false),
      new Field("score", new Float64(), false),
      new Field("durationMs", new Int64(), false),
      new Field("metadata", new Utf8(), false),
    ]);

    try {
      return await db.openTable(SUBSYSTEM_EFFECTIVENESS_TABLE);
    } catch (err: any) {
      if (!isLanceTableNotFoundError(err)) throw err;
      await db.createEmptyTable(SUBSYSTEM_EFFECTIVENESS_TABLE, schema);
      const table = await db.openTable(SUBSYSTEM_EFFECTIVENESS_TABLE);
      console.log(`[MemoryStore] [${label}] subsystem_effectiveness table created`);
      return table;
    }
  }

  async initSubsystemEffectivenessTable(): Promise<void> {
    if (this.ramDb) {
      this.subsystemEffectivenessRamTable = await this.ensureSubsystemEffectivenessTable(
        this.ramDb,
        this.subsystemEffectivenessRamTable,
        "ram",
      );
    }

    if (this.ssdAvailable) {
      try {
        this.subsystemEffectivenessSsdTable = await this.ensureSubsystemEffectivenessTable(
          this.ssdDb,
          this.subsystemEffectivenessSsdTable,
          "ssd",
        );
        this.handleSsdSuccess();
      } catch (err: any) {
        this.handleSsdError(err, "ensure_subsystem_effectiveness_table");
      }
    }
  }

  async recordSubsystemEffectiveness(event: SubsystemEffectivenessEvent): Promise<void> {
    await this.ensureInitialized();
    await this.initSubsystemEffectivenessTable();

    const metadata = event.metadata === null || event.metadata === undefined
      ? ""
      : typeof event.metadata === "string"
        ? event.metadata
        : JSON.stringify(event.metadata);

    const row: SubsystemEffectivenessRow = {
      id: event.id ?? randomUUID(),
      ts: event.ts ?? new Date().toISOString(),
      subsystem: event.subsystem ?? "",
      event: event.event ?? "",
      entityId: event.entityId ?? "",
      relatedId: event.relatedId ?? "",
      sessionKey: event.sessionKey ?? "",
      sessionId: event.sessionId ?? "",
      queryHash: event.queryHash ?? "",
      outcome: event.outcome ?? "",
      count: Math.max(0, Math.floor(event.count || 0)),
      score: Number.isFinite(event.score) ? event.score as number : 0,
      durationMs: Math.max(0, Math.floor(event.durationMs || 0)),
      metadata,
    };

    await this.lancedbRetry("record_subsystem_effectiveness:ram", () => this.subsystemEffectivenessRamTable.add([row]));
    await recordAuxTableWrite(this.subsystemEffectivenessRamTable, "ram:subsystem_effectiveness");
    if (this.ssdAvailable && this.subsystemEffectivenessSsdTable) {
      await this.lancedbRetry("record_subsystem_effectiveness:ssd", () => this.subsystemEffectivenessSsdTable.add([row]))
        .then(async () => {
          this.handleSsdSuccess();
          await recordAuxTableWrite(this.subsystemEffectivenessSsdTable, "ssd:subsystem_effectiveness");
        })
        .catch((err: any) => {
          this.handleSsdError(err, "record_subsystem_effectiveness");
        });
    }
  }

  async querySubsystemEffectiveness(
    filter: SubsystemEffectivenessQueryFilter = {},
  ): Promise<SubsystemEffectivenessRow[]> {
    await this.ensureInitialized();
    await this.initSubsystemEffectivenessTable();

    const conditions: string[] = [];
    if (filter.subsystem) conditions.push(`subsystem = ${sqlStringLiteral(filter.subsystem)}`);
    if (filter.event) conditions.push(`event = ${sqlStringLiteral(filter.event)}`);
    if (filter.outcome) conditions.push(`outcome = ${sqlStringLiteral(filter.outcome)}`);
    if (filter.since) conditions.push(`ts >= ${sqlStringLiteral(filter.since)}`);

    let query = this.subsystemEffectivenessRamTable.query();
    if (conditions.length > 0) {
      query = query.where(conditions.join(" AND "));
    }

    const limit = Math.max(1, Math.floor(filter.limit ?? 100));
    const rows = await query.limit(limit).toArray();

    return rows.map((row: any) => ({
      id: String(row.id || ""),
      ts: String(row.ts || ""),
      subsystem: String(row.subsystem || ""),
      event: String(row.event || ""),
      entityId: String(row.entityId || ""),
      relatedId: String(row.relatedId || ""),
      sessionKey: String(row.sessionKey || ""),
      sessionId: String(row.sessionId || ""),
      queryHash: String(row.queryHash || ""),
      outcome: String(row.outcome || ""),
      count: Number(row.count) || 0,
      score: Number(row.score) || 0,
      durationMs: Number(row.durationMs) || 0,
      metadata: String(row.metadata || ""),
    }));
  }

  async recordConcentratorStat(
    stat: ConcentratorStatInput
  ): Promise<void> {
    await this.ensureInitialized();
    await this.ensureConcentratorStatsTables();

    const row = {
      id: stat.id ?? randomUUID(),
      canonicalKey: stat.canonicalKey?.trim() || "unknown",
      sessionId: stat.sessionId ?? null,
      provider: stat.provider,
      outcome: stat.outcome,
      attemptedProviders: stat.attemptedProviders,
      inputTokens: Math.max(0, Math.floor(stat.inputTokens || 0)),
      outputTokens: stat.outputTokens === null || stat.outputTokens === undefined ? null : Math.max(0, Math.floor(stat.outputTokens)),
      durationMs: Math.max(0, Math.floor(stat.durationMs || 0)),
      failureReason: stat.failureReason ?? null,
      createdAt: stat.createdAt ?? Date.now(),
    };

    const addRow = async (table: any): Promise<void> => {
      const currentSchema = await table.schema();
      const fieldNames = new Set(currentSchema.fields.map((field: any) => field.name));
      let attemptedProvidersForMeta: unknown = [];
      try {
        attemptedProvidersForMeta = JSON.parse(row.attemptedProviders || "[]");
      } catch {}
      const legacyFields = {
        timestamp: row.createdAt,
        sessionKey: row.canonicalKey,
        source: "concentrate",
        reason: row.failureReason,
        meta: JSON.stringify({
          provider: row.provider,
          attemptedProviders: attemptedProvidersForMeta,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
        }),
      };
      const compatibleRow = Object.fromEntries(
        Object.entries({ ...row, ...legacyFields }).filter(([key]) => fieldNames.has(key)),
      );
      await table.add([compatibleRow]);
    };

    await this.lancedbRetry("record_concentrator_stat:ram", () => addRow(this.concentratorStatsRamTable));
    await recordAuxTableWrite(this.concentratorStatsRamTable, "ram:concentrator_stats");
    if (this.ssdAvailable && this.concentratorStatsSsdTable) {
      await this.lancedbRetry("record_concentrator_stat:ssd", () => addRow(this.concentratorStatsSsdTable))
        .then(async () => {
          this.handleSsdSuccess();
          await recordAuxTableWrite(this.concentratorStatsSsdTable, "ssd:concentrator_stats");
        })
        .catch((err: any) => {
          this.handleSsdError(err, "record_concentrator_stat");
        });
    }
  }

  async queryConcentratorStats(opts: {
    since?: number;
    provider?: ConcentratorStat["provider"];
    outcome?: ConcentratorStat["outcome"];
    canonicalKey?: string;
    limit?: number;
  } = {}): Promise<ConcentratorStat[]> {
    await this.ensureInitialized();
    await this.ensureConcentratorStatsTables();

    const conditions: string[] = [];
    if (opts.since !== undefined) conditions.push(`\`createdAt\` >= ${Math.floor(opts.since)}`);
    if (opts.provider) conditions.push(`provider = ${sqlStringLiteral(opts.provider)}`);
    if (opts.outcome) conditions.push(`outcome = ${sqlStringLiteral(opts.outcome)}`);
    if (opts.canonicalKey) conditions.push(`\`canonicalKey\` = ${sqlStringLiteral(opts.canonicalKey)}`);

    let query = this.concentratorStatsRamTable.query();
    if (conditions.length > 0) {
      query = query.where(conditions.join(" AND "));
    }

    const limit = Math.max(1, opts.limit ?? 100);
    const rows = await query.limit(limit).toArray();

    return rows.map((row: any) => ({
      id: String(row.id),
      canonicalKey: String(row.canonicalKey || row.sessionKey || "unknown"),
      sessionId: row.sessionId === null || row.sessionId === undefined ? null : String(row.sessionId),
      provider: String(row.provider || "all_failed") as ConcentratorStat["provider"],
      outcome: row.outcome as ConcentratorStat["outcome"],
      attemptedProviders: typeof row.attemptedProviders === "string" ? row.attemptedProviders : "[]",
      inputTokens: Number(row.inputTokens) || 0,
      outputTokens: row.outputTokens === null || row.outputTokens === undefined ? null : Number(row.outputTokens),
      durationMs: Number(row.durationMs) || 0,
      failureReason: row.failureReason ? String(row.failureReason) as ConcentratorStat["failureReason"] : null,
      createdAt: Number(row.createdAt || row.timestamp) || 0,
    }));
  }

  async getRecentConcentratorStats(limit = 100): Promise<ConcentratorStat[]> {
    return this.queryConcentratorStats({ limit });
  }

  // ========================================================================
  // Status Audit Log（P0-3: 記憶狀態變更 audit trail）
  // ========================================================================

  private async ensureStatusAuditLogTable(db: any, cached: any, label: string): Promise<any> {
    if (cached) return cached;

    const tableName = STATUS_AUDIT_LOG_TABLE;
    let table: any;
    const schema = new Schema([
      new Field("id", new Utf8(), false),
      new Field("timestamp", new Int64(), false),
      new Field("memoryId", new Utf8(), false),
      new Field("fromStatus", new Utf8(), true),      // nullable: 首次建立時為 null
      new Field("toStatus", new Utf8(), false),
      new Field("reason", new Utf8(), false),
      new Field("source", new Utf8(), false),
      new Field("supersededBy", new Utf8(), true),     // nullable
      new Field("meta", new Utf8(), true),             // nullable: JSON
      new Field("canonicalKey", new Utf8(), true),     // nullable: session 識別
      new Field("partial", new Bool(), false),         // NOT NULL: fail-safe 標記
    ]);

    try {
      table = await db.openTable(tableName);
      const currentSchema = await table.schema();
      const schemaMatches = currentSchema.fields.length === schema.fields.length
        && currentSchema.fields.every((field: any, index: number) => {
          const expected = schema.fields[index];
          return field.name === expected.name
            && field.nullable === expected.nullable
            && String(field.type) === String(expected.type);
        });

      if (!schemaMatches) {
        await db.dropTable(tableName);
        table = await db.createEmptyTable(tableName, schema);
        table = await db.openTable(tableName);
        console.log(`[MemoryStore] [${label}] status_audit_log schema rebuilt`);
      }
    } catch {
      await db.createEmptyTable(tableName, schema);
      table = await db.openTable(tableName);
      console.log(`[MemoryStore] [${label}] status_audit_log table created`);
    }

    return table;
  }

  private async ensureStatusAuditLogTables(): Promise<void> {
    this.statusAuditLogRamTable = await this.ensureStatusAuditLogTable(
      this.ramDb,
      this.statusAuditLogRamTable,
      "ram",
    );

    if (this.ssdAvailable) {
      try {
        this.statusAuditLogSsdTable = await this.ensureStatusAuditLogTable(
          this.ssdDb,
          this.statusAuditLogSsdTable,
          "ssd",
        );
        this.handleSsdSuccess();
      } catch (err: any) {
        this.handleSsdError(err, "ensure_status_audit_log_table");
      }
    }
  }

  /**
   * P0-3 Schema Migration: 確保 memories table 有 `status` column (Utf8, nullable)。
   * 舊資料全部預設為 'active'。使用 LanceDB addColumns API，idempotent。
   */
  private async ensureStatusColumn(): Promise<void> {
    const addIfMissing = async (table: any, label: string) => {
      try {
        const currentSchema = await table.schema();
        const hasStatus = currentSchema.fields.some((f: any) => f.name === 'status');
        if (hasStatus) return;

        await table.addColumns([{ name: 'status', valueSql: "'active'" }]);
        console.log(`[MemoryStore] [${label}] status column added (default 'active')`);
      } catch (err: any) {
        console.warn(`[MemoryStore] [${label}] status column migration failed (non-fatal): ${err.message}`);
      }
    };

    await addIfMissing(this.ramTable, 'ram');
    if (this.ssdAvailable && this.ssdTable) {
      await addIfMissing(this.ssdTable, 'ssd');
    }
  }

  async recordStatusAudit(
    audit: Omit<StatusAuditRow, "id" | "timestamp"> & { id?: string; timestamp?: number }
  ): Promise<string> {
    await this.ensureInitialized();
    await this.ensureStatusAuditLogTables();

    const id = audit.id ?? randomUUID();
    const row = {
      id,
      timestamp: audit.timestamp ?? Date.now(),
      memoryId: audit.memoryId,
      fromStatus: audit.fromStatus ?? null,
      toStatus: audit.toStatus,
      reason: audit.reason,
      source: audit.source,
      supersededBy: audit.supersededBy ?? null,
      meta: audit.meta ?? null,
      canonicalKey: audit.canonicalKey ?? null,
      partial: audit.partial ?? false,
    };

    await this.lancedbRetry("record_status_audit:ram", () => this.statusAuditLogRamTable.add([row]));
    await recordAuxTableWrite(this.statusAuditLogRamTable, "ram:status_audit_log");
    if (this.ssdAvailable && this.statusAuditLogSsdTable) {
      await this.lancedbRetry("record_status_audit:ssd", () => this.statusAuditLogSsdTable.add([row]))
        .then(async () => {
          this.handleSsdSuccess();
          await recordAuxTableWrite(this.statusAuditLogSsdTable, "ssd:status_audit_log");
        })
        .catch((err: any) => {
          this.handleSsdError(err, "record_status_audit");
        });
    }

    return id;
  }

  async recordCreationAudit(req: {
    memoryId: string;
    source: string;
    meta?: Record<string, unknown>;
  }): Promise<string> {
    return this.recordStatusAudit({
      memoryId: req.memoryId,
      fromStatus: null,
      toStatus: 'active',
      reason: 'created',
      source: req.source,
      supersededBy: null,
      meta: req.meta ? JSON.stringify(req.meta) : null,
      canonicalKey: null,
      partial: false,
    });
  }

  /**
   * 查詢 status_audit_log（觀測用）。
   *
   * @note volatile — 只讀 RAM，重啟後遺失歷史。
   *   長期 audit 查詢需另開 P1 任務支援 readFromSsd 選項。
   */
  async queryStatusAudit(opts: {
    memoryId?: string;
    since?: number;
    source?: string;
    limit?: number;
  } = {}): Promise<StatusAuditRow[]> {
    await this.ensureInitialized();
    await this.ensureStatusAuditLogTables();

    const conditions: string[] = [];
    if (opts.memoryId) conditions.push(`\`memoryId\` = ${sqlStringLiteral(opts.memoryId)}`);
    if (opts.since !== undefined) conditions.push(`timestamp >= ${Math.floor(opts.since)}`);
    if (opts.source) conditions.push(`source = ${sqlStringLiteral(opts.source)}`);

    let query = this.statusAuditLogRamTable.query();
    if (conditions.length > 0) {
      query = query.where(conditions.join(" AND "));
    }

    const limit = Math.max(1, opts.limit ?? 100);
    const rows = await query.limit(limit).toArray();

    return rows.map((row: any) => ({
      id: String(row.id),
      timestamp: Number(row.timestamp) || 0,
      memoryId: String(row.memoryId),
      fromStatus: row.fromStatus ? String(row.fromStatus) : null,
      toStatus: String(row.toStatus),
      reason: String(row.reason),
      source: String(row.source),
      supersededBy: row.supersededBy ? String(row.supersededBy) : null,
      meta: row.meta ? String(row.meta) : null,
      canonicalKey: row.canonicalKey ? String(row.canonicalKey) : null,
      partial: Boolean(row.partial),
    }));
  }

  private initializeCreationStatus(metaObj: Record<string, any>): void {
    // 建立路徑必須在單次 insert 帶入 active，避免新表 status 欄位缺值；audit 於 insert 成功後補寫。
    metaObj.status = 'active';
  }

  private async safeRecordCreationAudit(req: {
    memoryId: string;
    source: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.recordCreationAudit(req);
    } catch (err: any) {
      console.warn(`[MemoryStore] Failed to write creation audit (memoryId=${req.memoryId}): ${err.message}`);
    }
  }

  // ========================================================================
  // Transcript Watermark（P0-1.5 A: archive line-count persistence）
  // ========================================================================

  private async ensureTranscriptWatermarkTable(db: any, cached: any, label: string): Promise<any> {
    if (cached) return cached;

    const schema = new Schema([
      new Field("canonicalKey", new Utf8(), false),
      new Field("sessionId", new Utf8(), true),
      new Field("lineCount", new Int64(), false),
      new Field("updatedAt", new Int64(), false),
    ]);

    let table: any;
    try {
      table = await db.openTable(TRANSCRIPT_WATERMARK_TABLE);
    } catch (err: any) {
      if (!isLanceTableNotFoundError(err)) throw err;
      await db.createEmptyTable(TRANSCRIPT_WATERMARK_TABLE, schema);
      table = await db.openTable(TRANSCRIPT_WATERMARK_TABLE);
      console.log(`[MemoryStore] [${label}] transcript_watermark table created (was not found)`);
      return table;
    }

    const currentSchema = await table.schema();
    const hasSessionId = currentSchema.fields.some((field: any) => field.name === "sessionId");
    if (!hasSessionId) {
      await table.addColumns([{ name: "sessionId", valueSql: "CAST(NULL AS VARCHAR)" }]);
      table = await db.openTable(TRANSCRIPT_WATERMARK_TABLE);
      console.log(`[MemoryStore] [${label}] transcript_watermark sessionId column added`);
    }
    const migratedSchema = await table.schema();
    const schemaMatches = migratedSchema.fields.length === schema.fields.length
      && schema.fields.every((expected: any) => {
        const field = migratedSchema.fields.find((candidate: any) => candidate.name === expected.name);
        return !!field
          && field.nullable === expected.nullable
          && String(field.type) === String(expected.type);
      });

    if (!schemaMatches) {
      console.warn(`[MemoryStore] [${label}] schema mismatch, skip drop+recreate to avoid race`); return table;
      table = await db.createEmptyTable(TRANSCRIPT_WATERMARK_TABLE, schema);
      table = await db.openTable(TRANSCRIPT_WATERMARK_TABLE);
      console.log(`[MemoryStore] [${label}] transcript_watermark schema rebuilt`);
    }

    return table;
  }

  private async ensureTranscriptWatermarkTables(): Promise<void> {
    this.transcriptWatermarkRamTable = await this.ensureTranscriptWatermarkTable(
      this.ramDb,
      this.transcriptWatermarkRamTable,
      "ram",
    );

    if (this.ssdAvailable) {
      try {
        this.transcriptWatermarkSsdTable = await this.ensureTranscriptWatermarkTable(
          this.ssdDb,
          this.transcriptWatermarkSsdTable,
          "ssd",
        );
        this.handleSsdSuccess();
      } catch (err: any) {
        this.handleSsdError(err, "ensure_transcript_watermark_table");
      }
    }
  }

  async setTranscriptWatermark(canonicalKey: string, sessionId: string | null, lineCount: number): Promise<void> {
    await this.ensureInitialized();
    await this.ensureTranscriptWatermarkTables();

    const row = {
      canonicalKey,
      sessionId,
      lineCount,
      updatedAt: Date.now(),
    };
    const where = `\`canonicalKey\` = ${sqlStringLiteral(canonicalKey)}`;
    const values = normalizeLanceUpdateValues({
      sessionId: row.sessionId,
      lineCount: row.lineCount,
      updatedAt: row.updatedAt,
    });

    const upsert = async (table: any): Promise<void> => {
      const existing = await table.query().where(where).limit(1).toArray();
      if (existing.length > 0) {
        await table.update(values, { where });
      } else {
        await table.add([row]);
      }
    };

    await this.lancedbRetry("set_transcript_watermark:ram", () => upsert(this.transcriptWatermarkRamTable));
    await recordAuxTableWrite(this.transcriptWatermarkRamTable, "ram:transcript_watermark");
    if (this.ssdAvailable && this.transcriptWatermarkSsdTable) {
      await this.lancedbRetry("set_transcript_watermark:ssd", () => upsert(this.transcriptWatermarkSsdTable))
        .then(async () => {
          this.handleSsdSuccess();
          await recordAuxTableWrite(this.transcriptWatermarkSsdTable, "ssd:transcript_watermark");
        })
        .catch((err: any) => {
          this.handleSsdError(err, "set_transcript_watermark");
        });
    }
  }

  async getTranscriptWatermark(canonicalKey: string): Promise<(TranscriptWatermarkRow & { sessionId: string | null }) | null> {
    await this.ensureInitialized();
    await this.ensureTranscriptWatermarkTables();

    const where = `\`canonicalKey\` = ${sqlStringLiteral(canonicalKey)}`;
    const readOne = async (table: any): Promise<(TranscriptWatermarkRow & { sessionId: string | null }) | null> => {
      if (!table) return null;
      const rows = await table.query().where(where).limit(1).toArray();
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        canonicalKey: String(row.canonicalKey),
        sessionId: row.sessionId === null || row.sessionId === undefined ? null : String(row.sessionId),
        lineCount: Number(row.lineCount) || 0,
        updatedAt: Number(row.updatedAt) || 0,
      };
    };

    const ramRow = await readOne(this.transcriptWatermarkRamTable);
    if (ramRow) return ramRow;

    if (this.ssdAvailable && this.transcriptWatermarkSsdTable) {
      return await readOne(this.transcriptWatermarkSsdTable);
    }

    return null;
  }

  async vectorSearch(vector: number[], limit = 5): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // 🛡️ 空向量防禦:避免空向量打到 LanceDB 觸發 Arrow Float64 崩潰
    if (!vector || !Array.isArray(vector) || vector.length === 0) {
      return [];
    }

    try {
      const fetchLimit = Math.max(limit + VISIBILITY_OVERFETCH, limit * 3);
      const results = await this.ramTable.search(vector).limit(fetchLimit).toArray();

      // H1: 過濾非 active 狀態(同時檢查 row.status 與 metadata.status)
      const activeResults = results.filter((row: any) => {
        const topStatus = (row.status as string) || 'active';
        const metaStatus = (() => { try { const m = this.parseMetadata(row.metadata); return m?.status; } catch { return undefined; } })();
        return isVisibleStatus(topStatus, metaStatus);
      }).slice(0, limit);

      return activeResults.map((row: any) => ({
        entry: {
          id: row.id as string,
          text: row.text as string,
          textTokens: row.textTokens as string,
          vector: this.toJsVector(row.vector),
          importance: row.importance as number,
          category: row.category as MemoryCategory,
          parentId: row.parentId as string | null,
          metadata: row.metadata as string || '{}',
          createdAt: Number(row.createdAt) || Date.now(),
          updatedAt: Number(row.updatedAt) || Date.now(),
        },
        vectorScore: 1 / (1 + (row._distance ?? 0)),
        rankScore: 1 / (1 + (row._distance ?? 0)),
        rawDistance: row._distance ?? 0,
        bm25Score: 0, fusedScore: 0,
      }));
    } catch (err: any) {
      // 🛡️ LanceDB Arrow 錯誤防禦(通常是資料庫中有損壞的空向量記錄)
      const msg = String(err?.message || '');
      if (msg.includes('Float64') || msg.includes('Arrow') || msg.includes('buffers')) {
        console.warn(`[MemoryStore] vectorSearch Arrow error (possibly corrupted record); returning empty results: ${msg.slice(0, 100)}`);
        return [];
      }
      throw err;
    }
  }

  async ftsSearch(query: string, limit = 5): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();
    if (!this.ftsAvailable) {
      console.warn('[MemoryStore] FTS index unavailable; returning empty results');
      return [];
    }

    try {
      const fetchLimit = Math.max(limit + VISIBILITY_OVERFETCH, limit * 3);
      const tokenizedQuery = await this.tokenizeChinese(query);
      if (!tokenizedQuery) return [];
      const results = await this.ramTable
        .search(tokenizedQuery, "fts", ["textTokens"])
        .limit(fetchLimit)
        .toArray();
      const activeResults = results
        .filter((row: any) => Number.isFinite(row._score) && row._score > 0)
        .filter((row: any) => {
          const topStatus = (row.status as string) || 'active';
          const metaStatus = (() => { try { const m = this.parseMetadata(row.metadata); return m?.status; } catch { return undefined; } })();
          return isVisibleStatus(topStatus, metaStatus);
        })
        .slice(0, limit);
      return activeResults.map((row: any) => ({
        entry: {
          id: row.id as string,
          text: row.text as string,
          textTokens: row.textTokens as string,
          vector: this.toJsVector(row.vector),
          importance: row.importance as number,
          category: row.category as MemoryCategory,
          parentId: row.parentId as string | null,
          metadata: row.metadata as string || '{}',
          createdAt: Number(row.createdAt) || Date.now(),
          updatedAt: Number(row.updatedAt) || Date.now(),
        },
        vectorScore: 0,
        rankScore: 0,
        rawDistance: Number.POSITIVE_INFINITY,
        bm25Score: row._score ?? 0,
        fusedScore: 0,
      }));
    } catch (err: any) {
      console.warn('[MemoryStore] FTS search failed:', err.message);
      return [];
    }
  }

  /**
   * hybridVectorSearch - 統一混合搜尋(向量 + FTS + RRF Fusion)
   * 替代所有純向量搜尋調用
   */
  async hybridVectorSearch(query: string, limit = 5): Promise<MemorySearchResult[]> {
    const RRF_K = 60;
    await this.ensureInitialized();

    const poolSize = limit * 2;
    let queryVector: number[];
    let embeddingFailed = false;
    try {
      queryVector = await this._embed(query);
    } catch (err: any) {
      console.warn('[MemoryStore] Embedding failed; falling back to FTS:', err?.message ?? err);
      queryVector = [];
      embeddingFailed = true;
    }
    let vectorResults: any[] = [];
    if (!queryVector || queryVector.length === 0) {
      if (!embeddingFailed) {
        console.warn(`[MemoryStore] Vector generation failed (API 503); skipping vector matching and falling back to FTS`);
      }
    } else {
      vectorResults = await this.vectorSearch(queryVector, poolSize);
    }
    const ftsResults = this.ftsAvailable ? await this.ftsSearch(query, poolSize) : [];

    // RRF Fusion
    const fused = new Map<string, MemorySearchResult>();
    vectorResults.forEach((r, i) => {
      const score = 1 / (RRF_K + i + 1);
      fused.set(r.entry.id, {
        ...r,
        vectorScore: score,
        rankScore: score,
        bm25Score: 0,
        fusedScore: 0,
      });
    });
    ftsResults.forEach((r, i) => {
      const score = 1 / (RRF_K + i + 1);
      if (fused.has(r.entry.id)) {
        fused.get(r.entry.id)!.bm25Score = score;
      } else {
        fused.set(r.entry.id, {
          ...r,
          vectorScore: 0,
          rankScore: 0,
          rawDistance: Number.POSITIVE_INFINITY,
          bm25Score: score,
          fusedScore: 0,
        });
      }
    });

    const results = Array.from(fused.values());
    if (results.length === 0) return results;

    let existingIds: Set<string> | null = null;
    try {
      const ids = [...new Set(results.map(r => r.entry.id).filter(Boolean))];
      if (ids.length > 0) {
        const predicate = `\`id\` IN (${ids.map(sqlStringLiteral).join(", ")})`;
        const rows = await this.ramTable.query()
          .where(predicate)
          .select(["id"])
          .limit(ids.length)
          .toArray();
        existingIds = new Set(rows.map((row: any) => String(row.id)));
      }
    } catch (err: any) {
      console.warn("[PR-XR-1] stale candidate existence check failed:", err?.message ?? err);
    }

    // PR-XR-1: 先排除 current memories 不存在的 stale candidate,再排除非 active 狀態。
    return results.filter(r => {
      if (existingIds && !existingIds.has(r.entry.id)) return false;
      try {
        const meta = this.parseMetadata(r.entry.metadata);
        return isVisibleStatus(undefined, meta?.status);
      } catch { return true; }
    }).slice(0, limit);
  }

  // ── Internal helper: embed via injected embedder ────────────────────────
  private async _embed(text: string): Promise<number[]> {
    if ((this as any)._embedder) {
      return await (this as any)._embedder.embed(text);
    }
    return Array(this.vectorDim).fill(0);
  }

  /**
   * hybridSkillCapsuleSearch - 技能膠囊混合搜尋(hybridVectorSearch + keyword match)
   * 用於 autoRecall 結果組裝階段
   */
  async hybridSkillCapsuleSearch(
    query: string,
    limit = 3,
    filters: { capsuleVersion?: number; status?: string } = {},
  ): Promise<SkillCapsule[]> {
    if (!query.trim()) return [];

    // 直接用 hybridVectorSearch 搜 memories table
    const results = await this.hybridVectorSearch(query, limit * 3);

    // 篩選出帶 skillName metadata 的記憶
    const capsules: SkillCapsule[] = [];
    for (const r of results) {
      try {
        const meta = this.parseMetadata(r.entry.metadata);
        if (!meta?.skillName) continue;
        if (filters.capsuleVersion !== undefined && meta.capsuleVersion !== filters.capsuleVersion) continue;
        if (filters.status !== undefined && meta.status !== filters.status) continue;

        capsules.push({
          id: r.entry.id,
          skillName: meta.skillName,
          triggerConditions: meta.triggerConditions || [],
          executionSteps: meta.executionSteps || [],
          summary: r.entry.text.slice(0, 200),
          confidence: meta.confidence ?? r.entry.importance * 100,
          category: r.entry.category,
          createdAt: r.entry.createdAt,
          updatedAt: r.entry.updatedAt,
          usageCount: meta.usageCount ?? 0,
          lastUsedAt: meta.lastUsedAt ?? null,
          status: meta.status ?? 'active',
        });

        if (capsules.length >= limit) break;
      } catch { /* ignore parsing errors */ }
    }

    return capsules;
  }

  async query(predicate: string, limit = 100, includeAllStatus = false): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    const results = await this.ramTable.query().where(predicate).limit(limit).toArray();
    const visibleResults = includeAllStatus
      ? results
      : results.filter((row: any) => {
          const topStatus = (row.status as string) || 'active';
          const metaStatus = (() => { try { const m = this.parseMetadata(row.metadata); return m?.status; } catch { return undefined; } })();
          return topStatus === 'active' && (metaStatus == null || metaStatus === 'active');
        });

    return visibleResults.map((row: any) => ({
      id: row.id as string,
      text: row.text as string,
      textTokens: row.textTokens as string,
      vector: this.toJsVector(row.vector),
      importance: row.importance as number,
      category: row.category as MemoryCategory,
      parentId: row.parentId as string | null,
      metadata: row.metadata as string || '{}',
      createdAt: Number(row.createdAt) || Date.now(),
      updatedAt: Number(row.updatedAt) || Date.now(),
    }));
  }

  async queryAll(limit = 10000): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    const results = await this.ramTable.query().limit(limit).toArray();

    return results.map((row: any) => ({
      id: row.id as string,
      text: row.text as string,
      textTokens: row.textTokens as string,
      vector: this.toJsVector(row.vector),
      importance: row.importance as number,
      category: row.category as MemoryCategory,
      parentId: row.parentId as string | null,
      metadata: row.metadata as string || '{}',
      createdAt: Number(row.createdAt) || Date.now(),
      updatedAt: Number(row.updatedAt) || Date.now(),
      status: row.status as any,
    }));
  }

  async queryHookBearing(): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    const results = await this.ramTable.query()
      .where("`hasHooks` = true")
      .select([
        "id",
        "text",
        "textTokens",
        "metadata",
        "importance",
        "category",
        "parentId",
        "createdAt",
        "updatedAt",
        "status",
      ])
      .toArray();

    return results.map((row: any) => ({
      id: row.id as string,
      text: row.text as string,
      textTokens: row.textTokens as string,
      vector: [],
      importance: row.importance as number,
      category: row.category as MemoryCategory,
      parentId: row.parentId as string | null,
      metadata: row.metadata as string || '{}',
      createdAt: Number(row.createdAt) || Date.now(),
      updatedAt: Number(row.updatedAt) || Date.now(),
      status: row.status as any,
    }));
  }

  async queryAllWithMeta(limit = 10000): Promise<Array<MemoryEntry & { metadataObj: Record<string, any> }>> {
    const all = await this.queryAll(limit);
    return all.map(entry => ({
      ...entry,
      metadataObj: this.parseMetadata(entry.metadata),
    }));
  }

  async recordMemoryRecalls(
    entries: Array<MemoryEntry | { id: string }>,
    recalledAt: number = Date.now(),
  ): Promise<void> {
    await this.ensureInitialized();

    const ids = Array.from(new Set(
      entries
        .map(entry => entry?.id)
        .filter((id): id is string => typeof id === "string" && MemoryStore.UUID_RE.test(id)),
    ));
    if (ids.length === 0) return;

    const predicate = ids.map(id => `id = '${id.replace(/'/g, "''")}'`).join(" OR ");
    const rows = await this.ramTable.query()
      .where(predicate)
      .limit(ids.length)
      .toArray();

    const updates = rows.map((row: any) => {
      const id = row.id as string;
      const metaObj = this.parseMetadata(row.metadata as string);
      const currentCount = Number(metaObj.recallCount);
      metaObj.lastRecalledAt = recalledAt;
      metaObj.recallCount = Number.isFinite(currentCount) && currentCount > 0
        ? Math.floor(currentCount) + 1
        : 1;

      return { id, metadata: JSON.stringify(metaObj) };
    });

    await this.batchUpdateMemories(updates);
  }

  async getRecallStats(memoryId: string): Promise<{
    lastRecalledAt: number | null;
    recallCount: number;
    ageInDays: number;
    dormancyInDays: number | null;
  } | null> {
    const entry = await this.getById(memoryId);
    if (!entry) return null;

    const now = Date.now();
    const metaObj = this.parseMetadata(entry.metadata);
    const lastRecalledAt = Number(metaObj.lastRecalledAt);
    const recallCount = Number(metaObj.recallCount);
    const normalizedLastRecalledAt = Number.isFinite(lastRecalledAt) && lastRecalledAt > 0
      ? lastRecalledAt
      : null;

    return {
      lastRecalledAt: normalizedLastRecalledAt,
      recallCount: Number.isFinite(recallCount) && recallCount > 0 ? Math.floor(recallCount) : 0,
      ageInDays: Math.max(0, (now - entry.createdAt) / 86400000),
      dormancyInDays: normalizedLastRecalledAt === null
        ? null
        : Math.max(0, (now - normalizedLastRecalledAt) / 86400000),
    };
  }

  /**
   * searchBySlotKey - 精準查詢同 slotKey 的所有版本
   * 用於 Structured Slot 的 supersedes 鏈查找
   */
  async searchBySlotKey(slotKey: string): Promise<MemoryEntry[]> {
    await this.ensureInitialized();
    if (!slotKey) return [];

    const escaped = `'${slotKey.replace(/'/g, "''")}'`;
    const results = await this.ramTable.query()
      .where(`\`slotKey\` = ${escaped}`)
      .limit(100)
      .toArray();

    return results.map((row: any) => ({
      id: row.id as string,
      text: row.text as string,
      textTokens: row.textTokens as string,
      vector: this.toJsVector(row.vector),
      importance: row.importance as number,
      category: row.category as MemoryCategory,
      parentId: row.parentId as string | null,
      metadata: row.metadata as string || '{}',
      createdAt: Number(row.createdAt) || Date.now(),
      updatedAt: Number(row.updatedAt) || Date.now(),
      slotKey: row.slotKey as string | undefined,
      slotValue: row.slotValue as number | string | boolean | undefined,
      supersedes: row.supersedes ? JSON.parse(row.supersedes as string) as string[] : undefined,
      confidence: row.confidence as number | undefined,
      extractionDomain: row.extractionDomain as "technical" | "identity" | "preference" | "free_text" | undefined,
    }));
  }

  // ========================================================================
  // 🧠 數位新陈代谢系統(走 RAM table,decayMemories 內部用 delete() - 有 WAL 保護)
  // ========================================================================

  async boostHealth(id: string): Promise<boolean> {
    await this.ensureInitialized();

    const entry = await this.getById(id);
    if (!entry) return false;
    const textTokens = await this.tokenizeChinese(entry.text);
    const nowMs = Date.now();
    const metaObj = this.parseMetadata(entry.metadata);

    const isCore = this.healthConfig.coreCategories.includes(entry.category) ||
                   entry.importance >= this.healthConfig.coreImportanceThreshold;

    if (isCore) return true;

    const health = metaObj.health || { healthScore: 100, accessCount: 0, decayCount: 0, lastDecayedAt: Date.now() };

    const oldScore = typeof health.healthScore === 'number' ? health.healthScore : 100;
    health.accessCount = (health.accessCount || 0) + 1;
    const frequencyBonus = health.accessCount * 5;
    const baseBoost = 20;

    health.healthScore = Math.min(100, oldScore + baseBoost + frequencyBonus);
    health.lastAccessedAt = Date.now();
    metaObj.health = health;

    await this.update(id, { metadata: JSON.stringify(metaObj) });

    return true;
  }

  /**
   * 批次更新多筆記錄的 metadata(不走一筆一筆 WAL,直接寫 table + 單筆 batch WAL entry)。
   * 用於 decayMemories 批次收集完後一次性寫入,減少 O(N) WAL I/O。
   *
   * ⚠️ 犧牲了逐筆 WAL entry 的精細度,但換來批次效能。
   *   萬一寫入中途當機,batch 內部分記錄可能未落地,需靠下次 recovery 重跑。
   */
  async batchUpdateMemories(updates: Array<{ id: string; metadata: string }>): Promise<void> {
    if (updates.length === 0) return;
    await this.ensureInitialized();

    // 單筆 WAL entry 代表整個 batch(含逐筆 values,支援 recovery replay)
    const txnId = await this.appendWal({
      action: "batch_update",
      ids: updates.map(u => u.id),
      count: updates.length,
      entries: updates, // P1 Fix #5: 記錄每筆的 id + metadata,讓 recovery 能 replay
    });


    // 直接對 RAM table 批次寫入(繞過逐筆 WAL overhead)
    const failedIds: string[] = [];
    for (const { id, metadata } of updates) {
      this.validateId(id);
      try {
        const lanceValues = normalizeLanceUpdateValues({
          metadata,
          hasHooks: this.hasHooksFromMetadata(metadata),
          updatedAt: Date.now(),
        });
        await this.lancedbRetry('batch_update:ram', () => this.ramTable.update(
          lanceValues,
          { where: `id = '${id}'` }
        ));
        if (this.ssdAvailable) {
          await this.lancedbRetry('batch_update:ssd', () => this.ssdTable.update(
            lanceValues,
            { where: `id = '${id}'` }
          ));
        }
      } catch (err: any) {
        // 靜音處理,避免 LanceDB 底層警告洗頻,只在真出錯時才印
        if (!err.message?.includes('Fragment')) {
           console.warn(`[MemoryStore] Batch update failed for entry (id=${id}):`, err.message);
        }
        failedIds.push(id);
      }
    }

    if (failedIds.length > 0) {
      throw new Error(`batch_update failed for ids: ${failedIds.join(', ')}`);
    }
    await this.commitWal("batch", txnId);

  }

  async decayMemories(decayPerRun: number = 5, deleteThreshold: number = 0, options: DecayOptions = {}): Promise<{
    decayed: number; deleted: number; coreProtected: number; wouldDecay: number; wouldDelete: number;
    deferredDecay: number; deferredDelete: number;
    deleteCandidateSummary: { count: number; firstId: string | null; lastId: string | null; minCreatedAt: number | null; maxCreatedAt: number | null; createdAtByDay: Record<string, number> };
  }> {
    await this.ensureInitialized();

    const allMemories = await this.ramTable.query().limit(10000).toArray();
    let decayed = 0, deleted = 0, coreProtected = 0, wouldDecay = 0, wouldDelete = 0;
    let deferredDecay = 0, deferredDelete = 0;
    const effectiveCoreCategories = options.coreCategories ?? this.healthConfig.coreCategories;
    const effectiveCoreImportanceThreshold = options.coreImportanceThreshold ?? this.healthConfig.coreImportanceThreshold;
    const protectSkillCapsules = options.skillCapsuleProtection ?? true;
    const isDryRun = options.dryRun ?? false;
    const maxDelete = options.maxDelete === undefined ? Infinity : Math.max(0, Math.floor(options.maxDelete));
    const maxDecay = options.maxDecay === undefined ? Infinity : Math.max(0, Math.floor(options.maxDecay));
    const deleteCandidateSummary = {
      count: 0,
      firstId: null as string | null,
      lastId: null as string | null,
      minCreatedAt: null as number | null,
      maxCreatedAt: null as number | null,
      createdAtByDay: {} as Record<string, number>,
    };

    // P1 批次 WAL:先收集所有更新,最後一次性寫入
    const pendingUpdates: Array<{ id: string; metadata: string }> = [];

    for (const row of allMemories) {
      if (!isValidRowId(row)) {
        console.warn('[decayMemories] skipping row with invalid id:', {
          idType: typeof row?.id,
          idValue: row?.id,
          text: typeof row?.text === 'string' ? row.text.slice(0, 50) : null,
          createdAt: row?.createdAt,
        });
        continue;
      }
      const memoryRow = row as any;
      const id = memoryRow.id;
      if (id.startsWith("init_")) continue;

      const isCore = effectiveCoreCategories.includes(memoryRow.category as string) ||
                     (memoryRow.importance as number) >= effectiveCoreImportanceThreshold;

      if (isCore) {
        coreProtected++;
        continue;
      }

      // 技能膠囊不參與灰塵清理(只響應用戶明確刪除)
      const metaObj = this.parseMetadata(memoryRow.metadata as string);
      if (protectSkillCapsules && metaObj?.capsuleType === 'skill_capsule') {
        continue;
      }

      const health = metaObj.health || { healthScore: 100, lastAccessedAt: memoryRow.createdAt || Date.now(), accessCount: 0, decayCount: 0 };
      const currentHealth = typeof health.healthScore === 'number' ? health.healthScore : 100;

      const lastDecayedAt = health.lastDecayedAt || health.lastAccessedAt || memoryRow.createdAt || Date.now();
      const hoursPassed = (Date.now() - lastDecayedAt) / (1000 * 60 * 60);

      let hpLost = hoursPassed * 0.15;

      // P3: accessCount 連動 - 存取頻率越高,損耗越慢(最低 0.2)
      const accessFactor = Math.max(0.2, 1 - (health.accessCount || 0) * 0.01);
      hpLost = hpLost * accessFactor;

      if (metaObj?.capsuleVersion === 2 && metaObj?.status === 'active') {
        hpLost = hpLost * this.healthConfig.skillDecayFactor;
      }

      const newScore = Math.max(0, Math.round(currentHealth - hpLost));

      if (newScore === currentHealth && newScore > 0) {
        continue;
      }

      if (newScore <= deleteThreshold) {
        wouldDelete++;
        deleteCandidateSummary.count++;
        deleteCandidateSummary.firstId ??= id;
        deleteCandidateSummary.lastId = id;
        const createdAt = Number(memoryRow.createdAt ?? 0);
        if (Number.isFinite(createdAt) && createdAt > 0) {
          deleteCandidateSummary.minCreatedAt = deleteCandidateSummary.minCreatedAt === null ? createdAt : Math.min(deleteCandidateSummary.minCreatedAt, createdAt);
          deleteCandidateSummary.maxCreatedAt = deleteCandidateSummary.maxCreatedAt === null ? createdAt : Math.max(deleteCandidateSummary.maxCreatedAt, createdAt);
          const day = new Date(createdAt).toISOString().slice(0, 10);
          deleteCandidateSummary.createdAtByDay[day] = (deleteCandidateSummary.createdAtByDay[day] ?? 0) + 1;
        }
        if (!isDryRun) {
          if (deleted >= maxDelete) {
            deferredDelete++;
          } else if (options.deleteWith) {
            const deletedViaHook = await options.deleteWith(id);
            if (deletedViaHook) {
              deleted++;
            }
          } else {
            await this.delete(id); // delete 仍個別呼叫(WAL 保護刪除)
            deleted++;
          }
        }
      } else {
        wouldDecay++;
        health.healthScore = newScore;
        health.decayCount = (health.decayCount || 0) + 1;
        health.lastDecayedAt = Date.now();
        metaObj.health = health;

        // P1: 收集到批次陣列,最後一次性寫入
        if (!isDryRun) {
          if (decayed >= maxDecay) {
            deferredDecay++;
            continue;
          }
          pendingUpdates.push({ id, metadata: JSON.stringify(metaObj) });
          decayed++;
        }
      }
    }

    // P1: 最後一次性批次寫入(單筆 WAL entry)
    if (!isDryRun && pendingUpdates.length > 0) {
      await this.batchUpdateMemories(pendingUpdates);
    }

    // 🧹 在經歷了大量的 update 與 delete 之後,執行碎片重組 (Compaction)
    try {
      if (isDryRun) {
        console.log(`[Decay] Dry run: skipping optimize`);
        return { decayed, deleted, coreProtected, wouldDecay, wouldDelete, deferredDecay, deferredDelete, deleteCandidateSummary };
      }
      console.log(`[Decay] Optimizing storage...`);
      await this.ramTable.optimize();
      if (this.ssdAvailable) {
        await this.ssdTable.optimize();
      }
      console.log(`[Decay] Storage optimization complete`);
    } catch (err: any) {
      console.warn(`[Decay] Storage optimization failed (non-fatal):`, err.message);
    }

    await optimizeAuxTablesInConnection(this.ramDb, "ram");
    if (this.ssdAvailable) {
      await optimizeAuxTablesInConnection(this.ssdDb, "ssd");
    }

    console.log(`[Decay] decayed=${decayed} deleted=${deleted} coreProtected=${coreProtected} wouldDecay=${wouldDecay} wouldDelete=${wouldDelete} dryRun=${isDryRun}`);
    return { decayed, deleted, coreProtected, wouldDecay, wouldDelete, deferredDecay, deferredDelete, deleteCandidateSummary };
  }

  async getHealthStats(): Promise<any> {
    await this.ensureInitialized();
    const allMemories = await this.ramTable.query().limit(10000).toArray();
    let core = 0, healthy = 0, decaying = 0, critical = 0;

    for (const row of allMemories) {
      if (!isValidRowId(row)) {
        console.warn('[getHealthStats] skipping row with invalid id:', {
          idType: typeof row?.id,
          idValue: row?.id,
          text: typeof row?.text === 'string' ? row.text.slice(0, 50) : null,
          createdAt: row?.createdAt,
        });
        continue;
      }
      const memoryRow = row as any;
      if (memoryRow.id.startsWith("init_")) continue;

      const isCore = this.healthConfig.coreCategories.includes(memoryRow.category as string) ||
                     (memoryRow.importance as number) >= this.healthConfig.coreImportanceThreshold;

      if (isCore) {
        core++;
        continue;
      }

      const metaObj = this.parseMetadata(memoryRow.metadata as string);
      const score = typeof metaObj.health?.healthScore === 'number' ? metaObj.health.healthScore : 100;

      if (score >= 80) healthy++;
      else if (score >= 30) decaying++;
      else critical++;
    }

    return { total: allMemories.length, core, healthy, decaying, critical };
  }

  // ========================================================================
  // Graceful Shutdown
  // ========================================================================

  public async shutdown(): Promise<void> {
    console.log('[MemoryStore] Closing connections...');
    this.stopSsdRecoveryProbe();

    // 1. 先序列跑所有 shutdown hooks（HooksEngine 的 flush 在 WAL 關閉前執行）
    for (const hook of this.shutdownHooks) {
      try {
        await hook();
      } catch (err: any) {
        console.error('[MemoryStore] Shutdown hook failed:', err.message);
      }
    }

    try {
      if (this.ramDb) {
        await this.ramDb.close();
        console.log('[MemoryStore] RAM connection closed');
      }
      if (this.ssdDb) {
        await this.ssdDb.close();
        console.log('[MemoryStore] SSD connection closed');
      }
      console.log('[MemoryStore] Graceful shutdown complete');
    } catch (err: any) {
      console.error('[MemoryStore] Error during shutdown:', err.message);
    }
  }
}

export type { MemoryEntry, MemorySearchResult, MemoryHealth, SkillCapsule };
