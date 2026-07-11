/**
 * Night Consolidation — 記憶夜間整理模組
 *
 * 每天凌晨（或手動觸發）自動執行：
 * 1. 取出當日所有新寫入的記憶
 * 2. 依 slotKey 分組，找出重覆/碎片記憶
 * 3. 丟 MiniMax M2.7 (thinking=high) 做品質把關決策
 * 4. 執行：合併、刪除、更新 confidence/category
 * 5. 寫入 consolidation 日誌
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryEntry, MemoryCategory, StatusChangeRequest } from '../types.js';
import { CATEGORY_DESCRIPTIONS } from '../types.js';
import type { StatusManager } from '../store/status-manager.js';
import { buildNightRecoveryMetadata, type NightRecoverySource } from './night-recovery.js';
import type { LlmClient, Notifier } from '../ports.js';

// ============================================================================
// Types
// ============================================================================

export interface ConsolidationDecision {
  action: 'merge' | 'delete' | 'update' | 'keep' | 'deprecated';
  memoryId: string;
  reason: string;
  // for merge
  mergeIntoId?: string;
  // for update
  newCategory?: MemoryCategory;
  newConfidence?: number;
  newSlotKey?: string;
  newText?: string;
}

export interface ConsolidationPlan {
  decisions: ConsolidationDecision[];
  summary: string;
  processedCount: number;
  mergedCount: number;
  deletedCount: number;
  updatedCount: number;
  keptCount: number;
}

export interface ConsolidationResult {
  plan: ConsolidationPlan;
  executedAt: number;
  durationMs: number;
  errors: string[];
}

// ============================================================================
// Night Consolidator
// ============================================================================

export class NightConsolidator {
  private logPath: string;

  constructor(
    private store: {
      queryAll(limit?: number): Promise<MemoryEntry[]>;
      getById(id: string, includeAllStatus?: boolean): Promise<MemoryEntry | null>;
      update(id: string, updates: Partial<MemoryEntry>): Promise<boolean>;
      delete(id: string): Promise<boolean>;
      searchBySlotKey(slotKey: string): Promise<MemoryEntry[]>;
      recordNightConsolidationStat?(record: {
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
      }): Promise<void>;
    },
    private _options: { concentrator?: LlmClient; statusManager: StatusManager; notifier?: Notifier },
    consolidationLog: string,
  ) {
    if (!_options.statusManager) throw new Error('[NightConsolidator] statusManager is required');
    this.logPath = consolidationLog;
  }

  private recordStat(record: Parameters<NonNullable<typeof this.store.recordNightConsolidationStat>>[0]): void {
    const recordNightConsolidationStat = this.store.recordNightConsolidationStat;
    if (!recordNightConsolidationStat) return;
    void recordNightConsolidationStat.call(this.store, record).catch((err: any) => {
      console.warn('[NightConsolidation] stats write failed:', err?.message ?? err);
    });
  }

  private statMetadata(source: NightRecoverySource, extra: Record<string, unknown> = {}): string {
    return buildNightRecoveryMetadata({ source, ...extra });
  }

  private _broadcast(message: string): void {
    const notifier = this._options.notifier;
    if (!notifier) return;
    void notifier.notify(message).catch((err: any) => {
      console.error(`[NightConsolidation] _broadcast failed: ${err.message}`);
    });
  }

  // ── 入口 ─────────────────────────────────────────────────────────────────

  /**
   * 執行夜間整理（當日記憶）
   */
  async consolidateToday(runId = randomUUID(), source: NightRecoverySource = 'scheduled_timer'): Promise<ConsolidationResult> {
    return this.consolidateRange('today', runId, source);
  }

  /**
   * 執行夜間整理（指定時間範圍）
   * @param range 'today' | 'yesterday' | number (days ago)
   */
  async consolidateRange(
    range: 'today' | 'yesterday' | number,
    runId = randomUUID(),
    source: NightRecoverySource = 'scheduled_timer',
  ): Promise<ConsolidationResult> {
    const startMs = Date.now();
    const errors: string[] = [];

    // 1. 取出目標記憶
    let startOfDay: number;
    let endOfDay: number;

    if (range === 'today') {
      const now = new Date();
      startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime();
      endOfDay = Date.now();
    } else if (range === 'yesterday') {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      startOfDay = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 0, 0, 0).getTime();
      endOfDay = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59, 999).getTime();
    } else {
      // days ago
      const target = new Date();
      target.setDate(target.getDate() - Number(range));
      startOfDay = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 0, 0, 0).getTime();
      endOfDay = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59, 999).getTime();
    }

    console.log(`[NightConsolidation] Range: ${new Date(startOfDay).toLocaleString('zh-TW')} ~ ${range === 'today' ? 'now' : new Date(endOfDay).toLocaleString('zh-TW')}`);

    let memories: MemoryEntry[];
    try {
      const all = await this.store.queryAll(10000);
      memories = all.filter(m => {
        const t = m.createdAt || m.updatedAt;
        return t >= startOfDay && t <= endOfDay;
      });
      const candidateTimes = memories
        .map(m => m.createdAt || m.updatedAt)
        .filter(t => typeof t === 'number' && Number.isFinite(t));
      this.recordStat({
        runId,
        phase: 'query_completed',
        ts: Date.now(),
        outcome: 'ok',
        scannedCount: all.length,
        candidateCount: memories.length,
        metadata: this.statMetadata(source, {
          startOfDay,
          endOfDay,
          candidateMinCreatedAt: candidateTimes.length ? Math.min(...candidateTimes) : null,
          candidateMaxCreatedAt: candidateTimes.length ? Math.max(...candidateTimes) : null,
        }),
      });
    } catch (err: any) {
      errors.push(`取出記憶失敗: ${err.message}`);
      this.recordStat({
        runId,
        phase: 'query_completed',
        ts: Date.now(),
        outcome: 'failed',
        errorMessage: err?.message ?? String(err),
        metadata: this.statMetadata(source, { startOfDay, endOfDay }),
      });
      this._broadcast(`❌ Night Consolidation 失敗｜錯誤: ${err.message}`);
      return {
        plan: { decisions: [], summary: '', processedCount: 0, mergedCount: 0, deletedCount: 0, updatedCount: 0, keptCount: 0 },
        executedAt: Date.now(),
        durationMs: Date.now() - startMs,
        errors,
      };
    }

    if (memories.length === 0) {
      this.recordStat({
        runId,
        phase: 'zero_candidates',
        ts: Date.now(),
        outcome: 'skipped',
        candidateCount: 0,
        metadata: this.statMetadata(source),
      });
      console.log('[NightConsolidation] No new memories; skipping');
      return {
        plan: { decisions: [], summary: '無新記憶', processedCount: 0, mergedCount: 0, deletedCount: 0, updatedCount: 0, keptCount: 0 },
        executedAt: Date.now(),
        durationMs: Date.now() - startMs,
        errors: [],
      };
    }

    console.log(`[NightConsolidation] Retrieved ${memories.length} records`);

    // 廣播：開始執行
    const rangeLabel = range === 'today' ? '今晚' : `近 ${range} 天`;
    this._broadcast(`🌙 Night Consolidation 啟動（範圍：${rangeLabel}），共 ${memories.length} 筆記錄待處理`);

    // 2. LLM 決策
    let plan: ConsolidationPlan;
    try {
      plan = await this.llmDecide(memories, runId, source);
      this.recordStat({
        runId,
        phase: 'plan_created',
        ts: Date.now(),
        outcome: 'ok',
        candidateCount: memories.length,
        decisionCount: plan.decisions.length,
        mergeCount: plan.mergedCount,
        deleteCount: plan.decisions.filter(d => d.action === 'delete').length,
        deprecatedCount: plan.decisions.filter(d => d.action === 'deprecated').length,
        updateCount: plan.updatedCount,
        keepCount: plan.keptCount,
        metadata: this.statMetadata(source),
      });
    } catch (err: any) {
      errors.push(`LLM 決策失敗: ${err.message}`);
      this.recordStat({
        runId,
        phase: 'llm_failed',
        ts: Date.now(),
        outcome: 'failed',
        candidateCount: memories.length,
        errorMessage: err?.message ?? String(err),
        metadata: this.statMetadata(source, { processedCount: memories.length }),
      });
      this._broadcast(`❌ Night Consolidation 失敗｜錯誤: ${err.message}`);
      return {
        plan: { decisions: [], summary: '', processedCount: memories.length, mergedCount: 0, deletedCount: 0, updatedCount: 0, keptCount: 0 },
        executedAt: Date.now(),
        durationMs: Date.now() - startMs,
        errors,
      };
    }

    // 3. 執行決策
    try {
      await this.executePlan(plan, errors, runId, source);
    } catch (err: any) {
      errors.push(`執行計畫失敗: ${err.message}`);
      this._broadcast(`❌ Night Consolidation 失敗｜錯誤: ${err.message}`);
    }

    // 4. 寫日誌
    const result: ConsolidationResult = {
      plan,
      executedAt: Date.now(),
      durationMs: Date.now() - startMs,
      errors,
    };

    this.writeLog(result);

    // 成功時廣播（executePlan 失敗已廣播過，這裡只廣播成功路徑）
    if (errors.length === 0) {
      const durationMin = result.durationMs < 60000 ? `${Math.round(result.durationMs / 1000)}秒` : `${Math.round(result.durationMs / 60000)}分`;
      this._broadcast(`✅ Night Consolidation 完成｜合併:${plan.mergedCount} 刪除:${plan.deletedCount} 更新:${plan.updatedCount} 保留:${plan.keptCount}｜耗時:${durationMin}｜摘要:${plan.summary}`);
    }

    console.log(`[NightConsolidation] Complete: merged=${plan.mergedCount} deleted=${plan.deletedCount} updated=${plan.updatedCount} kept=${plan.keptCount} (${result.durationMs}ms)`);

    return result;
  }

  // ── LLM 決策引擎 ────────────────────────────────────────────────────────

  private async llmDecide(
    memories: MemoryEntry[],
    runId: string,
    source: NightRecoverySource,
  ): Promise<ConsolidationPlan> {
    const BATCH_SIZE = 50;
    let allDecisions: ConsolidationDecision[] = [];
    let summaryParts: string[] = [];

    for (let i = 0; i < memories.length; i += BATCH_SIZE) {
      const batch = memories.slice(i, i + BATCH_SIZE);
      const batchIndex = i / BATCH_SIZE + 1;
      const batchStartedAt = Date.now();
      this.recordStat({
        runId,
        phase: 'llm_batch_started',
        ts: batchStartedAt,
        batchIndex,
        batchSize: batch.length,
        metadata: this.statMetadata(source),
      });
      console.log(`[NightConsolidation] LLM analysis batch ${batchIndex} (${batch.length} records)`);
      let decisions: ConsolidationDecision[];
      let summary: string;
      try {
        ({ decisions, summary } = await this._llmDecideBatch(batch));
        this.recordStat({
          runId,
          phase: 'llm_batch_completed',
          ts: Date.now(),
          outcome: 'ok',
          durationMs: Date.now() - batchStartedAt,
          batchIndex,
          batchSize: batch.length,
          decisionCount: decisions.length,
          metadata: this.statMetadata(source),
        });
      } catch (err: any) {
        this.recordStat({
          runId,
          phase: 'llm_batch_completed',
          ts: Date.now(),
          outcome: 'failed',
          durationMs: Date.now() - batchStartedAt,
          batchIndex,
          batchSize: batch.length,
          errorMessage: err?.message ?? String(err),
          metadata: this.statMetadata(source),
        });
        throw err;
      }
      allDecisions = allDecisions.concat(decisions);
      if (summary) summaryParts.push(summary);
    }

    const mergedCount = allDecisions.filter(d => d.action === 'merge').length;
    const deletedCount = allDecisions.filter(d => d.action === 'delete' || d.action === 'deprecated').length;
    const updatedCount = allDecisions.filter(d => d.action === 'update').length;
    const keptCount = allDecisions.filter(d => d.action === 'keep').length;

    return {
      decisions: allDecisions,
      summary: summaryParts.join(' | ') || '無摘要',
      processedCount: memories.length,
      mergedCount,
      deletedCount,
      updatedCount,
      keptCount,
    };
  }

  private async _llmDecideBatch(memories: MemoryEntry[]): Promise<{ decisions: ConsolidationDecision[], summary: string }> {
    // 建構 prompt
    const memoryTextsArr = await Promise.all(memories.map(async (m, i) => {
      const meta = this.parseMeta(m.metadata);
      const text = String(m.text ?? '');
      const confidence = m.confidence != null ? String(m.confidence) : 'N/A';
      const status: string = String(meta.status ?? 'active');
      const cat: string = String(m.category);
      const imp: string = String(m.importance);
      const sk = String(m.slotKey ?? '—');
      const sv = String(m.slotValue ?? '—');
      const createdAt = m.createdAt ? new Date(m.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : 'N/A';
      const updatedAt = m.updatedAt ? new Date(m.updatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : 'N/A';

      // 檢查是否有被替代的舊記錄（supersedes chain）
      let supersededTag = '';
      if (sk && sk !== '—') {
        const supersededBy = await this.checkSupersedes(sk, '');
        if (supersededBy.length > 0) {
          supersededTag = `\n    ⚠️ [已被替代 by: ${supersededBy.map((id: string) => id.slice(0, 8)).join(', ')}]`;
        }
      }

      return `[${i}] id=${m.id} createdAt=${createdAt} updatedAt=${updatedAt}\n    category=${cat} confidence=${confidence} importance=${imp}\n    slotKey=${sk} slotValue=${sv}\n    status=${status}${supersededTag} text="${text.slice(0, 300)}${text.length > 300 ? '...' : ''}"`;
    }));
    const memoryTexts = memoryTextsArr.join('\n\n');

    const prompt = `你是記憶品質把關引擎。今晚需要整理以下 ${memories.length} 筆記錄。

【目標】
- 找出重覆/相似的記憶，建議合併
- 檢查 category 是否正確（類別說明：${Object.entries(CATEGORY_DESCRIPTIONS).map(([k, v]) => `${k}=${v}`).join(', ')}）
- 評估 confidence（0.5-0.8 的記憶重新打分）
- 判定衝突記憶（同一件事有矛盾說法）
- 決定要 keep / merge / delete / update / deprecated

【記憶清單】
${memoryTexts}

【決策規則】
- 同一 slotKey 的多筆記錄 → 合併（保留最完整的一筆，標記其他為 deprecated）
- 相似內文（語意重疊 > 50%）但不同 slotKey → 建議合併或刪除較差者
- category 明顯錯誤 → update 為正確類別
- confidence 0.5-0.8 → 重新評估（>=0.8 保留，<0.5 刪除）
- 衝突（矛盾說法）→ 保留較新且較有根據的，標記衝突的為 deprecated
- 純 free-text 無 slotKey → 保守保留，除非明顯重覆
- 新記憶（createdAt 接近）→ 優先保留新的
- deprecated → 標記為過期（status='deprecated'），內容保留但未來查詢會被排除（適用於重複、过时、冗餘的記憶）

【時間邏輯】
- 同一 slotKey 的多筆記錄 → 合併（保留最完整且最新的）
- 較新的記憶（createdAt/updatedAt 更晚）→ 優先保留
- 衝突時 → 保留較新且有根據的版本

【輸出格式】（pure JSON，無任何其他文字）
{
  "decisions": [
    {
      "action": "merge|delete|update|keep|deprecated",
      "memoryId": "<完整id>",
      "reason": "...",
      "mergeIntoId": "<完整id>"（僅 merge 時需要）
    }
  ],
  "summary": "今晚整理摘要（50字內）"
}`;

    // 透過注入的 LLM client 呼叫 MiniMax M2.7。
    const response = await this.callAgent(prompt);

    const content = this.extractJson(response);

    if (!content) {
      throw new Error(`LLM 回應解析失敗，回應內容: ${response.slice(0, 300)}`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`JSON 解析失敗: ${content.slice(0, 200)}`);
    }

    const candidateIds = new Set(memories.map(memory => memory.id));
    const validActions = new Set(['merge', 'delete', 'update', 'keep', 'deprecated']);
    const decisions: ConsolidationDecision[] = [];
    for (const d of parsed.decisions ?? []) {
      if (!validActions.has(d.action)) {
        console.warn('[NightConsolidation] invalid LLM decision skipped: action');
        continue;
      }
      if (typeof d.memoryId !== 'string' || !candidateIds.has(d.memoryId)) {
        console.warn('[NightConsolidation] invalid LLM decision skipped: memoryId');
        continue;
      }
      if (d.action === 'merge' && (
        typeof d.mergeIntoId !== 'string'
        || !candidateIds.has(d.mergeIntoId)
        || d.mergeIntoId === d.memoryId
      )) {
        console.warn('[NightConsolidation] invalid LLM decision skipped: mergeIntoId');
        continue;
      }
      if (d.newConfidence !== undefined && (
        typeof d.newConfidence !== 'number'
        || !Number.isFinite(d.newConfidence)
        || d.newConfidence < 0
        || d.newConfidence > 1
      )) {
        console.warn('[NightConsolidation] invalid LLM decision skipped: newConfidence');
        continue;
      }
      decisions.push({
        action: d.action,
        memoryId: d.memoryId,
        reason: d.reason ?? '',
        mergeIntoId: d.mergeIntoId,
        newCategory: d.newCategory,
        newConfidence: d.newConfidence,
        newSlotKey: d.newSlotKey,
        newText: d.newText,
      });
    }

    return {
      decisions,
      summary: parsed.summary ?? '',
    };
  }

  private async callAgent(prompt: string): Promise<string> {
    if (!this._options.concentrator) {
      console.warn('[NightConsolidation] ConcentratorAdapter unavailable; cannot invoke LLM');
      throw new Error('No concentrator provided');
    }
    
    // 直接透過 ConcentratorAdapter 呼叫 LLM (會自己走 Gemini 或 MiniMax)
    return await this._options.concentrator.generate(prompt, { purpose: 'night-consolidation' });
  }

  // ── 執行決策 ──────────────────────────────────────────────────────────────

  private async executePlan(
    plan: ConsolidationPlan,
    errors: string[],
    runId: string,
    source: NightRecoverySource,
  ): Promise<void> {
    let attemptedCount = 0;
    let failedCount = 0;
    const initialErrorCount = errors.length;
    const decisionsByAction = {
      merge: plan.decisions.filter(d => d.action === 'merge'),
      delete: plan.decisions.filter(d => d.action === 'delete'),
      update: plan.decisions.filter(d => d.action === 'update'),
      keep: plan.decisions.filter(d => d.action === 'keep'),
      deprecated: plan.decisions.filter(d => d.action === 'deprecated'),
    };

    // ── P0-3: 收集 StatusChangeRequest，最後統一走 changeStatusBatch ──
    const statusChangeReqs: StatusChangeRequest[] = [];

    // Merge → 標記舊的為 deprecated，引用新的
    for (const d of decisionsByAction.merge) {
      const id = d.memoryId;
      if (!id || !d.mergeIntoId) continue;
      try {
        const meta = await this.store.getById(id, true);
        const targetMeta = await this.store.getById(d.mergeIntoId, true);
        // P1 Fix #4: 防止 LLM 幻覺，確保兩個 ID 都存在
        if (!meta || !targetMeta) continue;

        statusChangeReqs.push({
          memoryId: id,
          toStatus: 'deprecated',
          reason: 'night_consolidation',
          source: 'night-consolidator.merge',
          supersededBy: d.mergeIntoId,
          meta: { consolidationReason: d.reason },
        });
        console.log(`[NightConsolidation] merge: ${id.slice(0, 8)} -> ${d.mergeIntoId?.slice(0, 8)}`);
      } catch (err: any) {
        errors.push(`merge ${id.slice(0, 8)}: ${err.message}`);
      }
    }

    // Delete → 軟刪除（status=trashed）
    for (const d of decisionsByAction.delete) {
      const id = d.memoryId;
      if (!id) continue;
      try {
        const meta = await this.store.getById(id, true);
        if (!meta) continue;

        statusChangeReqs.push({
          memoryId: id,
          toStatus: 'trashed',
          reason: 'night_consolidation',
          source: 'night-consolidator.delete',
          meta: { trashReason: d.reason },
        });
        console.log(`[NightConsolidation] delete: ${id.slice(0, 8)}`);
      } catch (err: any) {
        errors.push(`delete ${id.slice(0, 8)}: ${err.message}`);
      }
    }

    // Deprecated → 標記為 deprecated
    for (const d of decisionsByAction.deprecated) {
      const id = d.memoryId;
      if (!id) continue;
      try {
        const meta = await this.store.getById(id, true);
        if (!meta) continue;

        statusChangeReqs.push({
          memoryId: id,
          toStatus: 'deprecated',
          reason: 'night_consolidation',
          source: 'night-consolidator.deprecated',
          meta: { consolidationReason: d.reason },
        });
        console.log(`[NightConsolidation] deprecated: ${id.slice(0, 8)}`);
      } catch (err: any) {
        errors.push(`deprecated ${id.slice(0, 8)}: ${err.message}`);
      }
    }

    // P0-3: 統一執行 batch status change
    if (statusChangeReqs.length > 0) {
      attemptedCount += statusChangeReqs.length;
      let batchResults;
      try {
        batchResults = await this._options.statusManager.changeStatusBatch(statusChangeReqs);
      } catch (err: any) {
        failedCount += statusChangeReqs.length;
        this.recordStat({
          runId,
          phase: 'execute_completed',
          ts: Date.now(),
          outcome: 'failed',
          attemptedCount,
          failedCount,
          errorMessage: err?.message ?? String(err),
          metadata: this.statMetadata(source, { errorsCount: errors.length - initialErrorCount }),
        });
        throw err;
      }
      for (const result of batchResults) {
        if (!result.ok) {
          failedCount++;
          errors.push(`status_change ${result.memoryId.slice(0, 8)}: ${result.error}`);
        }
      }
    }

    // Update → 更新欄位
    for (const d of decisionsByAction.update) {
      const id = d.memoryId;
      if (!id) continue;
      let updateAttempted = false;
      try {
        const updates: Partial<MemoryEntry> = {};
        if (d.newCategory) updates.category = d.newCategory;
        if (d.newConfidence !== undefined) {
          const meta = await this.store.getById(id, true);
          if (meta) {
            const parsed = this.parseMeta(meta.metadata);
            parsed.confidence = d.newConfidence;
            updates.metadata = JSON.stringify(parsed);
          }
        }
        if (d.newSlotKey) updates.slotKey = d.newSlotKey;
        if (d.newText) updates.text = d.newText;

        attemptedCount++;
        updateAttempted = true;
        await this.store.update(id, updates);
        console.log(`[NightConsolidation] update: ${id.slice(0, 8)}`);
      } catch (err: any) {
        if (updateAttempted) failedCount++;
        errors.push(`update ${id.slice(0, 8)}: ${err.message}`);
      }
    }

    // Keep → 不做任何事（P1 Fix #6: 移除無限 +5 health boost，避免分數膨脹）
    for (const d of decisionsByAction.keep) {
      const id = d.memoryId;
      if (!id) continue;
      // 僅維持原狀，記錄已成功跑過整理
      try {
        const meta = await this.store.getById(id, true);
        if (!meta) continue;
      } catch (err: any) {
        errors.push(`keep ${id.slice(0, 8)}: ${err.message}`);
      }
    }

    this.recordStat({
      runId,
      phase: 'execute_completed',
      ts: Date.now(),
      outcome: failedCount === 0 ? 'ok' : 'failed',
      attemptedCount,
      failedCount,
      metadata: this.statMetadata(source, { errorsCount: errors.length - initialErrorCount }),
    });
  }

  // ── 工具 ──────────────────────────────────────────────────────────────────

  private parseMeta(metadata: string | undefined): Record<string, any> {
    try {
      return typeof metadata === 'string' ? JSON.parse(metadata) : (metadata ?? {});
    } catch {
      return {};
    }
  }

  /**
   * checkSupersedes — 查詢同 slotKey 的所有 active 舊版本
   * @returns 被取代的舊 entry id 清單
   */
  private async checkSupersedes(slotKey: string, _newId: string): Promise<string[]> {
    if (!slotKey) return [];
    try {
      const existing = await this.store.searchBySlotKey(slotKey);
      // 只回傳 status = 'active' 的舊版本（排除已 deprecated）
      return existing
        .filter(e => {
          const meta = this.parseMeta(e.metadata);
          return meta.status !== 'deprecated' && meta.status !== 'trashed';
        })
        .map(e => e.id);
    } catch (err) {
      console.warn('[NightConsolidator] checkSupersedes failed:', err);
      return [];
    }
  }

  private extractJson(text: string): string {
    // 去掉 markdown code block
    let trimmed = text.trim();
    if (trimmed.startsWith('```')) {
      const lines = trimmed.split('\n');
      trimmed = lines.slice(1, lines.length - 1).join('\n');
    }
    // 找第一個 { 到最後一個 }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return trimmed.slice(start, end + 1);
    }
    return trimmed;
  }

  private writeLog(result: ConsolidationResult): void {
    try {
      const dir = path.dirname(this.logPath);
      fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({
        type: 'consolidation',
        executedAt: result.executedAt,
        durationMs: result.durationMs,
        summary: result.plan.summary,
        processedCount: result.plan.processedCount,
        mergedCount: result.plan.mergedCount,
        deletedCount: result.plan.deletedCount,
        updatedCount: result.plan.updatedCount,
        keptCount: result.plan.keptCount,
        decisionCount: result.plan.decisions.length,
        errors: result.errors,
      }) + '\n';
      fs.appendFileSync(this.logPath, line, 'utf-8');
    } catch (err: any) {
      console.error('[NightConsolidation] Failed to write log:', err.message);
    }
  }
}
