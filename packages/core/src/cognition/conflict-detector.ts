/**
 * ConflictDetector — 記憶衝突偵測與主動抑制
 *
 * 模擬人類大腦的「主動抑制」(Retrieval-Induced Forgetting)：
 * 新記憶寫入後，掃描同 category 的高相似記憶，
 * 用 LLM 判斷是否存在語意衝突，若有則標記舊記憶為 deprecated。
 *
 * 只對高衝突風險類別觸發：preference, constraint, identity, decision
 */

import { MemoryStore } from '../store/store-v4.js';
import { StatusManager } from '../store/status-manager.js';
import { Embedder } from '../providers/embedder-v5.js';
import { hashQuery } from '../util/util-hash.js';
import type { LlmClient } from '../ports.js';

// 需要衝突偵測的高風險類別
const CONFLICT_CATEGORIES: Set<string> = new Set([
  'preference', 'constraint', 'identity', 'decision'
]);

export interface ConflictResult {
  hasConflict: boolean;
  conflictingIds: string[];
  resolution: string;
}

export class ConflictDetector {
  private lastJudgeErrorMessage: string | null = null;

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private llm?: LlmClient,
    private statusManager: StatusManager = (() => { throw new Error('[ConflictDetector] statusManager is required'); })(),
  ) {}

  /**
   * 在新記憶寫入後呼叫，掃描是否存在衝突記憶
   */
  async detectAndResolve(
    newMemoryId: string,
    newText: string,
    category: string,
  ): Promise<ConflictResult> {
    const attemptHash = hashQuery(`newMemoryId-${newMemoryId}-${Date.now()}`);

    // 只對高風險類別觸發
    if (!CONFLICT_CATEGORIES.has(category)) {
      this.recordEffectiveness({
        event: 'conflict_detect_attempted',
        entityId: newMemoryId,
        queryHash: attemptHash,
        outcome: 'category_skipped',
        metadata: { category },
      });
      return { hasConflict: false, conflictingIds: [], resolution: 'skip' };
    }

    this.recordEffectiveness({
      event: 'conflict_detect_attempted',
      entityId: newMemoryId,
      queryHash: attemptHash,
      outcome: 'entered',
      metadata: { category },
    });

    // Step 1: 找同 category 的相似記憶
    const candidates = await this.store.hybridVectorSearch(newText, 10);
    const sameCategoryCandidates = candidates.filter(r => {
      if (r.entry.id === newMemoryId) return false;
      if (r.entry.id.startsWith('init_')) return false;
      if (r.entry.category !== category) return false;
      // 只看 active 狀態的記憶
      try {
        const meta = typeof r.entry.metadata === 'string'
          ? JSON.parse(r.entry.metadata) : r.entry.metadata;
        if (meta?.status === 'deprecated') return false;
      } catch {}
      return true;
    });

    this.recordEffectiveness({
      event: 'conflict_candidates_found',
      entityId: newMemoryId,
      queryHash: attemptHash,
      outcome: sameCategoryCandidates.length > 0 ? 'has_candidates' : 'no_candidates',
      count: sameCategoryCandidates.length,
      metadata: { category },
    });

    if (sameCategoryCandidates.length === 0) {
      return { hasConflict: false, conflictingIds: [], resolution: 'no_candidates' };
    }

    // Step 2: 對前 3 筆用 LLM 做衝突判定
    const conflictingIds: string[] = [];
    const judgeCandidates = sameCategoryCandidates.slice(0, 3);
    const judgeStartedAt = Date.now();
    let judgeErrorMessage: string | null = null;
    for (const candidate of judgeCandidates) {
      this.lastJudgeErrorMessage = null;
      const isConflict = await this.judgeConflict(newText, candidate.entry.text, category);
      if (this.lastJudgeErrorMessage) judgeErrorMessage = this.lastJudgeErrorMessage;
      if (isConflict) {
        conflictingIds.push(candidate.entry.id);
      }
    }

    this.recordEffectiveness({
      event: 'conflict_llm_judged',
      entityId: newMemoryId,
      queryHash: attemptHash,
      outcome: judgeErrorMessage
        ? 'llm_failed'
        : conflictingIds.length > 0
          ? 'conflict_found'
          : 'no_conflict',
      count: judgeErrorMessage ? 0 : conflictingIds.length,
      durationMs: Date.now() - judgeStartedAt,
      metadata: {
        category,
        candidateCount: sameCategoryCandidates.length,
        ...(judgeErrorMessage ? { errorMessage: judgeErrorMessage } : {}),
      },
    });

    if (conflictingIds.length === 0) {
      return { hasConflict: false, conflictingIds: [], resolution: 'no_conflict' };
    }

    // Step 3: 主動抑制 — 標記舊記憶為 deprecated
    for (const oldId of conflictingIds) {
      const ok = await this.suppressMemory(oldId, newMemoryId);
      this.recordEffectiveness({
        event: 'conflict_resolution_fired',
        entityId: oldId,
        relatedId: newMemoryId,
        queryHash: attemptHash,
        outcome: ok ? 'ok' : 'failed',
        metadata: { category, reason: 'conflict_detected' },
      });
    }

    console.log(`[ConflictDetector] Conflict resolution complete: ${conflictingIds.length} previous memories superseded by ${newMemoryId.slice(0,8)}`);

    return {
      hasConflict: true,
      conflictingIds,
      resolution: `deprecated ${conflictingIds.length} conflicting memories`,
    };
  }

  /**
   * LLM 衝突判定：兩段記憶是否在描述同一件事但結論矛盾
   */
  private async judgeConflict(newText: string, existingText: string, category: string): Promise<boolean> {
    const prompt = `你是記憶衝突裁判。判斷以下兩段記憶是否存在「事實衝突」。

衝突 = 兩段記憶描述的是同一個主題/主體，但給出了不同的結論、偏好或指令。
共存 = 兩段記憶雖然相似，但描述的是不同面向、不同時間點的事實補充，可以同時成立。

記憶 A（舊）：${existingText}
記憶 B（新）：${newText}
類別：${category}

只回答一個字：「衝突」或「共存」`;

    if (!this.llm) {
      console.warn('[ConflictDetector] LLM provider not configured; skipping conflict evaluation and defaulting to coexistence');
      return false;
    }
    try {
      const result = await this.llm.generate(prompt, { purpose: 'conflict-detection' });
      const answer = result.trim();
      return answer.includes('衝突');
    } catch (err) {
      console.warn('[ConflictDetector] LLM evaluation failed; defaulting to coexistence:', err);
      this.lastJudgeErrorMessage = err instanceof Error ? err.message : String(err);
      return false; // 判定失敗時保守處理，不誤刪
    }
  }

  /**
   * 主動抑制：標記舊記憶為 deprecated
   */
  private async suppressMemory(oldId: string, newId: string): Promise<boolean> {
    const result = await this.statusManager.changeStatus({
      memoryId: oldId,
      toStatus: 'deprecated',
      reason: 'conflict_detected',
      source: 'conflict-detector',
      supersededBy: newId,
    });
    if (result.ok) {
      console.log(`[ConflictDetector] Active suppression: ${oldId.slice(0,8)} superseded by ${newId.slice(0,8)}`);
    } else {
      console.warn(`[ConflictDetector] Active suppression failed: ${oldId.slice(0,8)} error=${result.error}`);
    }
    return result.ok;
  }

  private recordEffectiveness(event: {
    event: string;
    entityId: string;
    relatedId?: string;
    queryHash: string;
    outcome: string;
    count?: number;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  }): void {
    void this.store.recordSubsystemEffectiveness({
      subsystem: 'conflict',
      relatedId: '',
      count: 0,
      score: 0,
      durationMs: 0,
      ...event,
    }).catch((err: any) => {
      console.warn('[conflict-eff]', err?.message ?? err);
    });
  }
}
