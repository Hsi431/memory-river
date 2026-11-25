/**
 * Cleanup - 記憶代謝 (V4 升級版)
 * memory-lance-v4
 * * 核心原則：
 * - 廢棄舊版扣減 importance 的邏輯
 * - 統一轉交由 store-v4.ts 內的 decayMemories 執行 (基於 Health 系統)
 * - 管理員指令直接與 V4 健康度生態系掛鉤
 * - 刪除的記憶進入注入的回收桶，N 天後自動清除
 */

import * as fs from "fs";
import * as path from "path";
import { MemoryStore } from "../store/store-v4.js";

type GraphStoreInvalidator = {
  deleteTriplesByMemoryId(memoryId: string): Promise<void>;
};

export interface CleanupEngineConfig {
  enabled: boolean;
  decayDays: number;
  deleteBelow: number;
  coreCategories?: string[];
  coreImportanceThreshold?: number;
  skillCapsuleProtection?: boolean;
  useTrash?: boolean;
  dryRun?: boolean;
  /** 回收桶路徑 */
  trashPath: string;
  /** 回收桶保留天數（預設 7 天） */
  trashRetentionDays?: number;
  /** 是否啟用回收桶自動清除（預設 true） */
  enableTrashAutoPurge?: boolean;
}

export interface CleanupRunOptions {
  dryRunOverride?: boolean;
  maxDelete?: number;
  maxDecay?: number;
}

export interface CleanupRunResult {
  deleted: number;
  updated: number;
  wouldDelete: number;
  wouldDecay: number;
  deferredDelete: number;
  deferredDecay: number;
  deleteCandidateSummary: {
    count: number;
    firstId: string | null;
    lastId: string | null;
    minCreatedAt: number | null;
    maxCreatedAt: number | null;
    createdAtByDay: Record<string, number>;
  };
  dryRun: boolean;
  /** 因為已有另一輪清理在執行而被跳過（沒有動到任何資料）。 */
  skipped?: boolean;
}

export class CleanupEngine {
  private static _instance: CleanupEngine | null = null;

  /**
   * 同一時間只允許一輪清理。
   * daily-schedule 與 session-end 曾在 0.8 秒內雙觸發，兩份 Optimize 並行
   * 把整台機器的記憶體吃光（2026-09-16 死機，LanceDB 留下 307 個截斷的版本檔）。
   */
  private inFlight: Promise<CleanupRunResult> | null = null;

  private readonly trashPath: string;
  private readonly trashRetentionDays: number;
  private readonly enableTrashAutoPurge: boolean;
  private readonly useTrash: boolean;
  private readonly dryRun: boolean;
  private graphStore?: GraphStoreInvalidator;

  constructor(
    private store: MemoryStore,
    private config: CleanupEngineConfig,
    graphStore?: GraphStoreInvalidator,
  ) {
    this.trashPath = config.trashPath;
    this.trashRetentionDays = config.trashRetentionDays ?? 7;
    this.enableTrashAutoPurge = config.enableTrashAutoPurge ?? true;
    this.useTrash = config.useTrash ?? true;
    this.dryRun = config.dryRun ?? false;
    this.graphStore = graphStore;

    // 確保 trash 目錄存在（idempotent）
    if (!fs.existsSync(this.trashPath)) {
      fs.mkdirSync(this.trashPath, { recursive: true });
    }
  }

  setGraphStore(graphStore: GraphStoreInvalidator | null): void {
    this.graphStore = graphStore ?? undefined;
  }

  static getInstance(): CleanupEngine {
    if (!CleanupEngine._instance) {
      throw new Error('[CleanupEngine] getInstance() called before initialize(). Call CleanupEngine.getInstance() only after register() has instantiated it.');
    }
    return CleanupEngine._instance;
  }

  static setInstance(inst: CleanupEngine): void {
    CleanupEngine._instance = inst;
  }

  /**
   * Session 結束鉤子 — 由 index.ts 的 session:end hook 觸發。
   * 非同步、不阻塞：以 fire-and-forget 方式驅動健康度衰退。
   */
  onSessionEnd(sessionId: string, _messages: unknown[], source: string = 'session-end'): void {
    console.log(`[CleanupEngine] session_end triggered, sessionId=${sessionId}, source=${source}`);
    void this.runSmartCleanup(source).catch((err) =>
      console.warn(`[CleanupEngine] onSessionEnd cleanup failed for ${sessionId}:`, err)
    );
  }

  /**
   * 執行智能清理 (調用 V4 核心代謝引擎)
   */
  async runSmartCleanup(source: string = 'manual', options: CleanupRunOptions = {}): Promise<CleanupRunResult> {
    if (!this.config.enabled) {
      return this.noopResult({ dryRun: true });
    }

    if (this.inFlight) {
      console.warn(`[CleanupEngine] run skipped: another cleanup is still in progress, source=${source}`);
      return this.noopResult({ dryRun: options.dryRunOverride ?? this.dryRun, skipped: true });
    }

    const run = this.runSmartCleanupInner(source, options);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  private noopResult({ dryRun, skipped }: { dryRun: boolean; skipped?: boolean }): CleanupRunResult {
    return {
      deleted: 0,
      updated: 0,
      wouldDelete: 0,
      wouldDecay: 0,
      deferredDelete: 0,
      deferredDecay: 0,
      deleteCandidateSummary: { count: 0, firstId: null, lastId: null, minCreatedAt: null, maxCreatedAt: null, createdAtByDay: {} },
      dryRun,
      ...(skipped ? { skipped: true } : {}),
    };
  }

  private async runSmartCleanupInner(source: string, options: CleanupRunOptions): Promise<CleanupRunResult> {
    const effectiveDryRun = options.dryRunOverride ?? this.dryRun;
    const result = await this.store.decayMemories(5, this.config.deleteBelow, {
      coreCategories: this.config.coreCategories,
      coreImportanceThreshold: this.config.coreImportanceThreshold,
      skillCapsuleProtection: this.config.skillCapsuleProtection ?? true,
      dryRun: effectiveDryRun,
      deleteWith: this.deleteForDecay.bind(this),
      maxDelete: options.maxDelete,
      maxDecay: options.maxDecay,
    });
    const expiredTrashedDeleted = effectiveDryRun ? 0 : await this.deleteExpiredTrashed();

    console.log(
      `[CleanupEngine] decayMemories: protected=${result.coreProtected} wouldDecay=${result.wouldDecay} wouldDelete=${result.wouldDelete}, source=${source}`
    );

    if (effectiveDryRun) {
      console.log(`[CleanupEngine] dry-run summary: would decay ${result.wouldDecay}, would delete ${result.wouldDelete}, source=${source}`);
    } else {
      console.log(`[CleanupEngine] decayed ${result.decayed} memories, deleted ${result.deleted} memories (dryRun=false), source=${source}`);
      if (result.deferredDelete > 0 || result.deferredDecay > 0) {
        console.log(`[CleanupEngine] ${source}: hit limit, deferred ${result.deferredDelete} delete candidates and ${result.deferredDecay} decay candidates to next run`);
      }
    }

    // 順便執行回收桶 auto-purge（idempotent）
    if (!effectiveDryRun && this.enableTrashAutoPurge) {
      await this.purgeExpiredTrash();
    }

    return {
      deleted: result.deleted + expiredTrashedDeleted,
      updated: result.decayed,
      wouldDelete: result.wouldDelete,
      wouldDecay: result.wouldDecay,
      deferredDelete: result.deferredDelete,
      deferredDecay: result.deferredDecay,
      deleteCandidateSummary: result.deleteCandidateSummary,
      dryRun: effectiveDryRun,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 回收桶（Trash）管理
  // ═══════════════════════════════════════════════════════════

  private async deleteExpiredTrashed(): Promise<number> {
    const queryAll = (this.store as any).queryAll;
    if (typeof queryAll !== 'function') return 0;

    const cutoff = Date.now() - this.trashRetentionDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    const entries = await queryAll.call(this.store, 10000);
    for (const entry of entries) {
      let metadata: Record<string, any>;
      try {
        metadata = typeof entry.metadata === 'string'
          ? JSON.parse(entry.metadata || '{}')
          : (entry.metadata || {});
      } catch {
        continue;
      }
      if ((metadata.status ?? entry.status) !== 'trashed') continue;
      const trashedAt = Number(metadata.trashedAt ?? entry.updatedAt ?? entry.createdAt);
      if (!Number.isFinite(trashedAt) || trashedAt >= cutoff) continue;
      if (await this.delete(entry.id)) deletedCount++;
    }
    return deletedCount;
  }

  /**
   * 刪除記憶：先搬到回收桶，再從 LanceDB 移除。
   * 檔名格式：{id}_{timestamp}.json（含完整 entry 內容）
   */
  private async deleteForDecay(id: string): Promise<boolean> {
    return this.deleteMemory(id, this.useTrash);
  }

  async delete(id: string): Promise<boolean> {
    return this.deleteMemory(id, true);
  }

  private async deleteMemory(id: string, moveToTrash: boolean): Promise<boolean> {
    const entry = await this.store.getById(id, true);
    if (!entry) return false;

    if (moveToTrash) {
      // 把完整 entry 寫入 trash
      const timestamp = Date.now();
      const trashFilename = `${id}_${timestamp}.json`;
      const trashFilePath = path.join(this.trashPath, trashFilename);

      fs.writeFileSync(trashFilePath, JSON.stringify(entry, null, 2), "utf-8");
      console.log(`[Cleanup] Memory ${id.slice(0, 8)} moved to trash: ${trashFilename} (retained for ${this.trashRetentionDays} days)`);
    }

    try {
      await this.graphStore?.deleteTriplesByMemoryId(id);
    } catch (err: any) {
      console.warn(`[Cleanup] graph triple cleanup failed for ${id.slice(0, 8)}: ${err?.message ?? err}`);
    }
    // 從 LanceDB 真正刪除
    await this.store.delete(id);
    return true;
  }

  /**
   * 掃描回收桶，自動清除超過 retention 天數的檔案。
   * Idempotent：多次呼叫不會重複處理。
   */
  async purgeExpiredTrash(): Promise<number> {
    if (!fs.existsSync(this.trashPath)) {
      return 0;
    }

    const now = Date.now();
    const retentionMs = this.trashRetentionDays * 24 * 60 * 60 * 1000;
    const cutoff = now - retentionMs;

    let purgedCount = 0;
    let processedFiles = new Set<string>();

    const files = fs.readdirSync(this.trashPath);
    for (const file of files) {
      // 只處理格式正確的 trash 檔案
      if (!file.endsWith(".json")) continue;

      const filePath = path.join(this.trashPath, file);
      const stat = fs.statSync(filePath);

      // 只刪除超期檔案
      if (stat.mtimeMs < cutoff) {
        // Idempotent check：已處理過同樣時間戳的檔案則跳過（不重複）
        const timestampFromName = file.split("_").pop()?.replace(".json", "");
        if (timestampFromName && processedFiles.has(timestampFromName)) {
          continue;
        }
        if (timestampFromName) processedFiles.add(timestampFromName);

        fs.unlinkSync(filePath);
        console.log(`[Cleanup] Automatically purged trash file: ${file} (retained for more than ${this.trashRetentionDays} days)`);
        purgedCount++;
      }
    }

    if (purgedCount > 0) {
      console.log(`[Cleanup] Trash purge complete: ${purgedCount} expired files permanently deleted`);
    }

    return purgedCount;
  }

}
