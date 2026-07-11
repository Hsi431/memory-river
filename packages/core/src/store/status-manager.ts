/**
 * StatusManager — 記憶狀態單一所有人（P0-3）
 *
 * 所有 status 變更（active / superseded / deprecated / archived / trashed）必須經過此模組。
 * 內部同時更新 metadata.status + row.status（雙欄位同步），並寫入 audit log。
 *
 * 設計原則：
 * - 純 class，只依賴 MemoryStore
 * - changeStatus() 走 store.update()（自動進 WAL exactly-once 保護）
 * - 所有成功/失敗都記 audit row
 * - changeStatusBatch() 逐筆 try/catch，單筆失敗不中斷整 batch
 */

import { randomUUID } from "node:crypto";
import { MemoryStore } from "./store-v4.js";
import type {
  MemoryStatus,
  StatusChangeRequest,
  StatusChangeResult,
  StatusAuditRow,
} from "../types.js";

export class StatusManager {
  constructor(private store: MemoryStore) {}

  // ========================================================================
  // 主寫入 API — 所有 status 變更走這
  // ========================================================================

  async changeStatus(req: StatusChangeRequest): Promise<StatusChangeResult> {
    const auditRowId = randomUUID();
    let fromStatus: MemoryStatus | null = null;

    try {
      // 1. 取出當前記憶
      const entry = await this.store.getById(req.memoryId, true);
      if (!entry) {
        // 記憶不存在 — 記 audit（失敗）並回傳
        await this.safeRecordAudit({
          memoryId: req.memoryId,
          fromStatus: null,
          toStatus: req.toStatus,
          reason: req.reason,
          source: req.source,
          supersededBy: req.supersededBy ?? null,
          meta: req.meta ? JSON.stringify(req.meta) : null,
          canonicalKey: null,
          partial: false,
        }, auditRowId);

        return {
          ok: false,
          memoryId: req.memoryId,
          fromStatus: null,
          toStatus: req.toStatus,
          auditRowId,
          error: 'memory_not_found',
        };
      }

      // 2. 解析當前 metadata，取得 fromStatus
      const meta = this.parseMetadata(entry.metadata);
      fromStatus = (meta.status as MemoryStatus) ?? null;

      // 3. 更新 metadata 欄位
      meta.status = req.toStatus;

      // 設置時間戳和額外欄位（保持與現有寫入者行為一致）
      if (req.toStatus === 'superseded') {
        meta.supersededAt = Date.now();
        if (req.supersededBy) {
          meta.supersededBy = req.supersededBy;
        }
      } else if (req.toStatus === 'deprecated') {
        meta.deprecatedAt = Date.now();
        if (req.supersededBy) {
          meta.supersededBy = req.supersededBy;
        }
      } else if (req.toStatus === 'trashed') {
        meta.trashedAt = Date.now();
      }

      // 合併額外 meta 資訊（如 consolidationReason）
      if (req.meta) {
        for (const [key, value] of Object.entries(req.meta)) {
          meta[key] = value;
        }
      }

      // 4. 同時更新 metadata + row.status（單一 store.update() 呼叫 → 單一 WAL entry）
      let partial = false;
      try {
        await this.store.update(req.memoryId, {
          metadata: JSON.stringify(meta),
          status: req.toStatus,
        } as any);
      } catch (updateErr: any) {
        // row.status 補寫可能失敗（例如 LanceDB schema 不含 status column）
        // 退回只更新 metadata 的安全路徑
        console.warn(`[StatusManager] Dual-field update failed; falling back to metadata-only: ${updateErr.message}`);
        try {
          await this.store.update(req.memoryId, {
            metadata: JSON.stringify(meta),
          });
          partial = true; // metadata 成功但 row.status 未寫入
        } catch (fallbackErr: any) {
          // 兩條路徑都失敗 — 記 audit 並回傳錯誤
          await this.safeRecordAudit({
            memoryId: req.memoryId,
            fromStatus: fromStatus,
            toStatus: req.toStatus,
            reason: req.reason,
            source: req.source,
            supersededBy: req.supersededBy ?? null,
            meta: JSON.stringify({ error: fallbackErr.message, ...(req.meta ?? {}) }),
            canonicalKey: null,
            partial: false,
          }, auditRowId);

          return {
            ok: false,
            memoryId: req.memoryId,
            fromStatus,
            toStatus: req.toStatus,
            auditRowId,
            error: `update_failed: ${fallbackErr.message}`,
          };
        }
      }

      // 5. 寫入 audit log（成功）
      await this.safeRecordAudit({
        memoryId: req.memoryId,
        fromStatus: fromStatus,
        toStatus: req.toStatus,
        reason: req.reason,
        source: req.source,
        supersededBy: req.supersededBy ?? null,
        meta: req.meta ? JSON.stringify(req.meta) : null,
        canonicalKey: null,
        partial,
      }, auditRowId);

      return {
        ok: true,
        memoryId: req.memoryId,
        fromStatus,
        toStatus: req.toStatus,
        auditRowId,
      };

    } catch (err: any) {
      // 未預期錯誤 — 嘗試記 audit
      await this.safeRecordAudit({
        memoryId: req.memoryId,
        fromStatus: fromStatus,
        toStatus: req.toStatus,
        reason: req.reason,
        source: req.source,
        supersededBy: req.supersededBy ?? null,
        meta: JSON.stringify({ error: err.message, ...(req.meta ?? {}) }),
        canonicalKey: null,
        partial: false,
      }, auditRowId);

      return {
        ok: false,
        memoryId: req.memoryId,
        fromStatus,
        toStatus: req.toStatus,
        auditRowId,
        error: err.message,
      };
    }
  }

  // ========================================================================
  // 批次 API — NightConsolidator 用
  // ========================================================================

  /**
   * 逐筆呼叫 changeStatus()，單筆失敗不中斷整 batch。
   * 每 20 筆輸出 progress log，避免凌晨 batch 卡住時無感。
   */
  async changeStatusBatch(reqs: StatusChangeRequest[]): Promise<StatusChangeResult[]> {
    const results: StatusChangeResult[] = [];
    const total = reqs.length;
    const mainReason = reqs[0]?.reason ?? 'unknown';

    for (let i = 0; i < total; i++) {
      try {
        const result = await this.changeStatus(reqs[i]);
        results.push(result);
      } catch (err: any) {
        // changeStatus 內部已有 try/catch，理論上不會走到這
        // 但防禦性程式設計：記錄失敗結果，繼續下一筆
        results.push({
          ok: false,
          memoryId: reqs[i].memoryId,
          fromStatus: null,
          toStatus: reqs[i].toStatus,
          auditRowId: '',
          error: `batch_unexpected: ${err.message}`,
        });
      }

      // 每 20 筆輸出 progress log
      if ((i + 1) % 20 === 0 || i === total - 1) {
        const succeeded = results.filter(r => r.ok).length;
        const failed = results.length - succeeded;
        console.log(`[StatusManager] batch progress: ${i + 1}/${total} (reason=${mainReason}, ok=${succeeded}, fail=${failed})`);
      }
    }

    return results;
  }

  // ========================================================================
  // 查詢 audit log（觀測用）
  // ========================================================================

  async queryAuditLog(opts: {
    memoryId?: string;
    since?: number;
    source?: string;
    limit?: number;
  }): Promise<StatusAuditRow[]> {
    return this.store.queryStatusAudit(opts);
  }

  /**
   * 新記憶建立時，row.status 與 metadata.status 已在 store.store() 一次寫入；
   * 這裡只補 audit log，避免再次觸發 LanceDB update metadata parser。
   */
  async recordCreation(req: {
    memoryId: string;
    source: string;
    meta?: Record<string, unknown>;
  }): Promise<string> {
    return this.store.recordCreationAudit(req);
  }

  // ========================================================================
  // 內部工具
  // ========================================================================

  /**
   * 安全寫入 audit log — 失敗只 warn，不影響主流程
   */
  private async safeRecordAudit(
    audit: Omit<StatusAuditRow, "id" | "timestamp">,
    id: string,
  ): Promise<void> {
    try {
      await this.store.recordStatusAudit({ ...audit, id });
    } catch (err: any) {
      console.warn(`[StatusManager] Failed to write audit log (memoryId=${audit.memoryId}): ${err.message}`);
    }
  }

  private parseMetadata(metaStr: string | undefined): Record<string, any> {
    if (!metaStr) return {};
    try {
      return typeof metaStr === 'string' ? JSON.parse(metaStr) : metaStr;
    } catch {
      return {};
    }
  }
}
