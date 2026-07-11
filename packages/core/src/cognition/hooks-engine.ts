/**
 * Hooks Engine - 記憶鉤子系統 + 實體關係圖譜
 * memory-lance-v4
 * * 功能：
 * 1. LLM 自動生成 hooks（最多 3 個，含權重）
 * 2. LLM 自動生成 entities（實體關係圖譜）
 * 3. 搜尋時觸發鉤子（層級 1，權重 > 0.5）
 * 4. 智慧防呆：可接受字串、陣列或 JSON 格式的 Query
 * 5. 冷卻時間（1 小時）
 */

import { MemoryStore, type MemoryEntry } from "../store/store-v4.js";
import { recordAuxTableWrite } from "../store/aux-table-maintenance.js";
import { Embedder } from "../providers/embedder-v5.js";
import type { MemoryHook, HookWeight } from "../types.js";
import type { LlmClient } from "../ports.js";
import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, Int32, Float32, Utf8, Int64 } from 'apache-arrow';

const SEMANTIC_MATCH_THRESHOLD = 0.8;
const SEMANTIC_CONTEXT_THRESHOLD = 0.75;
const MAX_SEMANTIC_HOOK_EVALS = 50;

const HOOK_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'is', 'are', 'was', 'were',
  'did', 'do', 'does', 'what', 'who', 'how', 'when', 'where', 'which', 'with', 'by',
  'from', 'and', 'or', 'but', 'not', 'it', 'its', 'this', 'that',
  '的', '了', '是', '在', '有', '和', '也', '都', '把', '被', '与', '以', '及', '或',
  '但', '而', '就', '还', '很', '这', '那', '个', '们',
]);

function splitHookTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,，、。；;!！?？:：「」【】()（）\[\]"']+/)
    .filter(token => {
      if (HOOK_STOPWORDS.has(token)) return false;
      return /[\u4e00-\u9fff]/.test(token) ? token.length >= 2 : token.length >= 3;
    });
}

function extractProperNouns(text: string): Set<string> {
  return new Set(
    Array.from(text.matchAll(/\b[A-Z][\p{L}\p{N}_-]{2,}\b/gu), match => match[0].toLowerCase()),
  );
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 實體關係圖譜類型
export interface EntityRelation {
  subject: string;
  relation: string;
  object: string;
}

// 冷卻記錄
interface CooldownEntry {
  keyword: string;
  lastTriggered: number;
}

// Hook 觸發結果
export interface HookTriggerResult {
  triggered: boolean;
  relatedMemories: {
    memory: MemoryEntry;
    score: number;
    viaHook: string;
  }[];
  naturalLanguage: string;
}

// Hook 觸發歷史追蹤
export interface HookQualityRecord {
  keyword: string;
  triggerCount: number;
  successCount: number;
  failCount: number;
  lastTriggeredAt: number | null;
  currentNumericWeight: number;   // 對應 HookWeight 的數值：high=1.0, medium=0.7, low=0.3
  adjustedNumericWeight: number;  // 動態調整後的數值
}

interface TriggerEvent {
  timestamp: number;
  success: boolean;
  query: string;
}

export class HooksEngine {
  private cooldown: Map<string, CooldownEntry> = new Map();
  private qualityTracker: Map<string, HookQualityRecord> = new Map();
  private hookEmbeddingCache: Map<string, number[]> = new Map();
  private readonly QUALITY_WINDOW = 10; // 只看最近10次觸發
  private readonly MAX_QUALITY_TRACKER_SIZE = 1000; // 防止無上限記憶體增長
  private readonly SUCCESS_RATE_THRESHOLD = 0.5; // 低於50% 降權
  private readonly HIGH_SUCCESS_RATE = 0.7; // 高於70% 升權
  private readonly DEGRADE_COOLDOWN = 24 * 60 * 60 * 1000; // 24小時冷卻
  private graphStore: any = null;
  private debounceTimer?: NodeJS.Timeout;
  private hardCapTimer?: NodeJS.Timeout;
  private isDirty = false;

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private config: {
      enabled?: boolean;
      maxHooksPerMemory?: number;
      maxTriggerDepth?: number;
      minTriggerScore?: number;
      cooldownMs?: number;
    },
    private llm?: LlmClient,
    private _db?: lancedb.Connection,
  ) {
    this.config = {
      enabled: config.enabled ?? true,
      maxHooksPerMemory: config.maxHooksPerMemory ?? 3,
      maxTriggerDepth: config.maxTriggerDepth ?? 1,
      minTriggerScore: config.minTriggerScore ?? 0.5,
      cooldownMs: config.cooldownMs ?? 3600000,
    };
    this.qualityTracker = new Map();
    this._setupDebounce();
    this._registerShutdown();
  }

  /** 注入 GraphStore（由 index.ts 在初始化時呼叫） */
  setGraphStore(graphStore: any): void {
    this.graphStore = graphStore;
  }

  async generateHooks(text: string, category: string): Promise<MemoryHook[]> {
    if (!this.config.enabled) return [];
    if (!this.llm) {
      console.warn('[HooksEngine] LLM provider not configured; skipping generateHooks');
      return [];
    }

    const prompt = this.buildHookPrompt(text, category);

    try {
      const result = await this.llm.generate(prompt, { purpose: 'hooks' });
      const hooks = this.parseHooksResponse(result, text);
      return hooks.slice(0, this.config.maxHooksPerMemory);
    } catch (err) {
      console.error('Hook generation failed:', err);
      return [];
    }
  }

  private getCategoryHint(category: string): string {
    const hints: Record<string, string> = {
      preference: '這是老闆的偏好。鉤子應像使用者下次會問起這個偏好的短語，並保留記憶中的人/物/場景名詞。',
      constraint: '這是硬性約束/鐵律。鉤子應像使用者下次查這條規則時會輸入的短語，並保留記憶中的操作/物件名詞。',
      identity: '這是身份/個人特徵。鉤子應像使用者下次問起這個人或身份時會說的短語，並保留記憶中的人名/地名/核心名詞。',
      decision: '這是已做的決策。鉤子應像使用者下次問起這個決策或結論時會輸入的短語，並保留記憶中的專案/工具/物件名詞。',
      fact: '這是客觀事實。鉤子應像使用者下次查這條事實時會輸入的短語，並保留記憶中的實體/數據/核心名詞。',
      entity: '這是人物/組織資訊。鉤子應像使用者下次提到這些人或組織時會輸入的短語，並保留原文實體名稱。',
      business: '這是商務/IP 資訊。鉤子應像使用者下次問起品牌、商務決策或 IP 時會輸入的短語，並保留記憶中的名稱。',
    };
    return hints[category] || '請生成使用者未來可能用來問起這條記憶的短語，並保留原文中的實體或核心名詞。';
  }

  private buildHookPrompt(text: string, category: string): string {
    const max = this.config.maxHooksPerMemory;
    const categoryHint = this.getCategoryHint(category);

    return `你是聯想記憶引擎。為以下記憶生成最多 ${max} 個觸發鉤子。
鉤子 = 未來使用者可能用來提問的短語/別名。
每個鉤子必須包含記憶文本中至少一個 named entity 或核心名詞（人、地、物、專案、工具、專有名詞）。
只能重組記憶內容中出現的詞，不可補充外部知識、同義詞或猜測。
禁止方法論、產業、技術泛化；禁止抽象話題標籤；禁止幻覺。

【策略 — ${category}】${categoryHint}

【權重定義】
high: 使用者明確問到原文實體/核心名詞時必須觸發
medium: 使用者用原文中的別名或相鄰名詞問起時觸發
low: 原文中較邊緣但仍具名的問法

【好鉤子 vs 爛鉤子（學習這個模式）】

記憶：「Diana 的新工作在沖繩，她會研究珊瑚礁。」
✅ 好：[{"keyword":"Diana 的新工作","weight":"high"},{"keyword":"Diana 沖繩 珊瑚礁","weight":"high"},{"keyword":"珊瑚礁 研究 地點","weight":"medium"}]
❌ 爛：[{"keyword":"職業轉型成功案例","weight":"high"},{"keyword":"海洋生態調查","weight":"medium"},{"keyword":"伺服器選址","weight":"low"}]

記憶：「把 LanceDB hooks 轉成 JSON 字串塞進 metadata 欄位。」
✅ 好：[{"keyword":"LanceDB hooks metadata","weight":"high"},{"keyword":"JSON 字串 metadata 欄位","weight":"high"}]
❌ 爛：[{"keyword":"資料庫欄位限制破解","weight":"high"},{"keyword":"資料工程最佳實務","weight":"medium"}]

記憶：「決定用 pnpm 取代 npm，因為安裝速度快三倍。」
✅ 好：[{"keyword":"pnpm 取代 npm","weight":"high"},{"keyword":"pnpm 安裝速度","weight":"medium"}]
❌ 爛：[{"keyword":"套件管理器選型","weight":"high"},{"keyword":"安裝速度優化","weight":"medium"}]

記憶內容：${text}

直接輸出 JSON 陣列，禁止 Markdown 標記或說明文字：`;
  }

  async generateEntities(text: string): Promise<EntityRelation[]> {
    if (!this.llm) {
      console.warn('[HooksEngine] LLM provider not configured; skipping generateEntities');
      return [];
    }

    const prompt = `你是知識圖譜專家。請從以下記憶中萃取「實體關係三元組」。

記憶內容：${text}

【輸出格式要求】：
你只能回傳一個乾淨的 JSON 陣列，不准有任何 Markdown 標記。
只能輸出可直接從記憶內容推出的關係，不可補充外部知識或猜測。

範例輸入：
記憶：「老闆住在新北市三重區，他有一隻叫 Maru 的貓，很喜歡吃雞肉凍乾。」

範例輸出：
[
  {"subject": "老闆", "relation": "住在", "object": "新北市三重區"},
  {"subject": "老闆", "relation": "養", "object": "Maru"},
  {"subject": "Maru", "relation": "喜歡吃", "object": "雞肉凍乾"}
]

請直接輸出 JSON 陣列：`;

    try {
      const result = await this.llm.generate(prompt, { purpose: 'entities' });
      const entities = this.parseEntitiesResponse(result);
      return entities.slice(0, 5);
    } catch (err) {
      console.error('Entity generation failed:', err);
      return [];
    }
  }

  private parseEntitiesResponse(response: string): EntityRelation[] {
    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((e: any) => e.subject && e.relation && e.object)
        .map((e: any) => ({
          subject: String(e.subject).trim(),
          relation: String(e.relation).trim(),
          object: String(e.object).trim(),
        }));
    } catch {
      return [];
    }
  }

  private parseHooksResponse(response: string, originalText: string): MemoryHook[] {
    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return this.fallbackHooks(originalText);

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return this.fallbackHooks(originalText);

      return parsed
        .filter((h: any) => h.keyword && h.weight)
        .map((h: any) => ({
          keyword: h.keyword.toLowerCase().trim(),
          weight: this.normalizeWeight(h.weight),
          weightScore: this.weightToScore(h.weight),
        }));
    } catch {
      return this.fallbackHooks(originalText);
    }
  }

  private fallbackHooks(text: string): MemoryHook[] {
    const keywords = text
      .split(/[,，、。；;!！?\s]+/)
      .filter(w => w.length >= 2 && w.length <= 15)
      .slice(0, 2);

    return keywords.map(kw => ({
      keyword: kw,
      weight: "high" as HookWeight,
      weightScore: 1.0,
    }));
  }

  private normalizeWeight(w: string): HookWeight {
    const lower = w.toLowerCase();
    if (lower === 'high') return 'high';
    if (lower === 'medium') return 'medium';
    return 'low';
  }

  private weightToScore(w: string): number {
    const lower = w.toLowerCase();
    if (lower === 'high') return 1.0;
    if (lower === 'medium') return 0.7;
    return 0.4;
  }

  private isInCooldown(keyword: string): boolean {
    // Confirmatory flag: never suppress firing via cooldown, so each question fires hooks
    // deterministically (independent of earlier questions' firing) -> no cross-question drift.
    if (process.env.MR_OTTER_READONLY === '1') return false;
    const entry = this.cooldown.get(keyword);
    if (!entry) return false;

    const now = Date.now();
    if (now - entry.lastTriggered > this.config.cooldownMs!) {
      this.cooldown.delete(keyword);
      return false;
    }
    return true;
  }

  private getAdjustedWeight(keyword: string, baseNumericWeight: number): number {
    const record = this.qualityTracker.get(keyword);
    return record?.adjustedNumericWeight ?? baseNumericWeight;
  }

  private setCooldown(keyword: string): void {
    if (process.env.MR_OTTER_READONLY === '1') return;  // no cooldown accumulation under the flag
    this.cooldown.set(keyword, {
      keyword,
      lastTriggered: Date.now(),
    });
  }

  /**
   * 🛡️ 智慧型 Query 解析器
   * 處理 OpenClaw 傳入的複雜格式，精準提取純文字
   */
  private safelyExtractUserText(rawQuery: any): string {
    try {
      // 情況 1: 已經是字串
      if (typeof rawQuery === 'string') {
        if (rawQuery.trim().startsWith('[')) {
          const parsed = JSON.parse(rawQuery);
          return this.safelyExtractUserText(parsed);
        }
        return rawQuery;
      }

      // 情況 2: OpenClaw Message 陣列 [{role: 'user', content: '...'}]
      if (Array.isArray(rawQuery)) {
        for (let i = rawQuery.length - 1; i >= 0; i--) {
          const msg = rawQuery[i];
          if (msg && msg.role === 'user' && typeof msg.content === 'string') {
            return msg.content;
          }
          if (msg && typeof msg.text === 'string') return msg.text;
        }
        return rawQuery.map(m => m.content || m.text || '').join(' ');
      }

      // 情況 3: 單一 Message 物件 {role: 'user', content: '...'}
      if (typeof rawQuery === 'object' && rawQuery !== null) {
        return rawQuery.content || rawQuery.text || JSON.stringify(rawQuery);
      }

      return String(rawQuery);
    } catch {
      // 靜默降級：無法解析時回傳空字串，由呼叫端處理
      return "";
    }
  }

  async triggerHooks(rawQuery: any): Promise<HookTriggerResult> {
    if (!this.config.enabled) {
      return { triggered: false, relatedMemories: [], naturalLanguage: "" };
    }

    const safeQueryText = this.safelyExtractUserText(rawQuery);

    if (!safeQueryText || safeQueryText.trim() === "") {
      return { triggered: false, relatedMemories: [], naturalLanguage: "" };
    }

    const queryKeywords = this.extractKeywords(safeQueryText);
    if (queryKeywords.length === 0) {
      return { triggered: false, relatedMemories: [], naturalLanguage: "" };
    }

    // ── 圖譜語意擴展（方向3核心）───────────────────────────────
    // 如果 GraphStore 已注入，先用 ANN 搜尋圖譜三元組，擴展 keyword 範圍
    let expandedKeywords = [...queryKeywords];
    if (this.graphStore) {
      try {
        const { expandedKeywords: graphKeywords } = await this.graphStore.semanticExpand(safeQueryText, 5);
        if (graphKeywords && graphKeywords.length > 0) {
          console.log(`[HooksEngine] Graph expansion: ${queryKeywords} -> ${[...queryKeywords, ...graphKeywords]}`);
          expandedKeywords = Array.from(new Set([...queryKeywords, ...graphKeywords]));
        }
      } catch (err) {
        // 圖譜失敗不阻斷 Hook trigger（降級方案）
        console.warn('[HooksEngine] Semantic graph expansion failed; falling back to literal matching:', err);
      }
    }

    const allMemories = await this.store.queryHookBearing();
    const triggered: { memory: MemoryEntry; score: number; viaHook: string }[] = [];
    const candidates: { memory: MemoryEntry; hook: MemoryHook }[] = [];

    for (const memory of allMemories) {
      if (!memory.metadata) continue;

      let hooks: MemoryHook[] = [];
      let meta: any = {};
      try {
        meta = typeof memory.metadata === 'string' ? JSON.parse(memory.metadata) : memory.metadata;
        hooks = meta?.hooks || [];
      } catch { hooks = []; }

      // 對齊 store-v4 搜尋層 (PR-MS-2):只在 metaStatus 明確 deprecated/trashed 時擋下,missing/undefined 視為 active。
      const topStatus = (memory as any).status || 'active';
      const metaStatus = meta?.status;
      if (topStatus !== 'active' || metaStatus === 'deprecated' || metaStatus === 'trashed') continue;

      if (!hooks || hooks.length === 0) continue;

      for (const hook of hooks) {
        if (typeof hook.keyword !== 'string') continue;
        if (this.isInCooldown(hook.keyword)) continue;
        candidates.push({ memory, hook });
      }
    }

    const queryTokens = new Set(expandedKeywords.flatMap(splitHookTokens));
    const queryProperNouns = extractProperNouns(safeQueryText);
    const candidateMatches = candidates.map(candidate => {
      const hookTokens = new Set(splitHookTokens(candidate.hook.keyword));
      const literalMatch = Array.from(hookTokens).some(token => queryTokens.has(token));
      const hookProperNouns = extractProperNouns(candidate.hook.keyword);
      const properNounMatch = Array.from(hookProperNouns).some(noun => queryProperNouns.has(noun));
      const adjustedWeight = this.getAdjustedWeight(
        candidate.hook.keyword,
        (candidate.hook.weightScore ?? 0.5),
      );
      return { ...candidate, literalMatch, contextMatch: literalMatch || properNounMatch, adjustedWeight };
    });
    const semanticCandidateKeys = new Set(
      candidateMatches
        .filter(candidate => !candidate.literalMatch)
        .sort((a, b) => b.adjustedWeight - a.adjustedWeight)
        .slice(0, MAX_SEMANTIC_HOOK_EVALS)
        .map(candidate => `${candidate.memory.id}:${candidate.hook.keyword}`),
    );

    let queryEmbedding: number[] | null = null;
    if (semanticCandidateKeys.size > 0) {
      try {
        const semanticQueryText = Array.from(new Set([safeQueryText, ...expandedKeywords]))
          .filter(text => typeof text === 'string' && text.trim().length > 0)
          .join(' ');
        queryEmbedding = await this.embedder.embed(semanticQueryText, 'query');
      } catch (err) {
        console.warn('[HooksEngine] Query embedding failed; falling back to literal matching:', err);
      }
    }

    for (const candidate of candidateMatches) {
      const { memory, hook, literalMatch, contextMatch, adjustedWeight } = candidate;
      let semanticMatch = false;

      if (!literalMatch && queryEmbedding && semanticCandidateKeys.has(`${memory.id}:${hook.keyword}`)) {
        try {
          let hookEmbedding = this.hookEmbeddingCache.get(hook.keyword);
          if (!hookEmbedding) {
            hookEmbedding = await this.embedder.embed(hook.keyword, 'store');
            this.hookEmbeddingCache.set(hook.keyword, hookEmbedding);
          }

          const similarity = cosineSimilarity(queryEmbedding, hookEmbedding);
          semanticMatch = similarity >= SEMANTIC_MATCH_THRESHOLD
            || (similarity >= SEMANTIC_CONTEXT_THRESHOLD && contextMatch);
        } catch (err) {
          console.warn(`[HooksEngine] Hook embedding failed for "${hook.keyword}"; using literal matching:`, err);
        }
      }

      const minScore = (this.config.minTriggerScore ?? 0.5) as number;
      if ((literalMatch || semanticMatch) && adjustedWeight >= minScore) {
        triggered.push({
          memory,
          score: adjustedWeight,
          viaHook: hook.keyword,
        });

        this.setCooldown(hook.keyword);
      }
    }

    if (triggered.length === 0) {
      return { triggered: false, relatedMemories: [], naturalLanguage: "" };
    }

    triggered.sort((a, b) => b.score - a.score);
    const topResults = triggered.slice(0, 3);
    const naturalLanguage = this.generateNaturalLanguage(topResults);

    // 更新品質追蹤 — 只記錄觸發次數，成功/失敗由 reportHookOutcome() 回報
    // Benchmark confirmatory A/B (MR_OTTER_READONLY=1): keep hook FIRING (injected memories above
    // are identical per arm — same query, frozen weights) but freeze the adaptive quality/cooldown
    // drift, which would otherwise accumulate cross-question and gate future firing differently per
    // arm. Iterate an empty set under the flag. Production untouched (flag default off).
    for (const hook of (process.env.MR_OTTER_READONLY === '1' ? [] : topResults)) {
      const keyword = hook.viaHook;
      if (!keyword) continue;

      const record = this.qualityTracker.get(keyword) ?? {
        keyword,
        triggerCount: 0,
        successCount: 0,
        failCount: 0,
        lastTriggeredAt: null,
        currentNumericWeight: typeof hook.score === 'number' ? hook.score : 0.7,
        adjustedNumericWeight: typeof hook.score === 'number' ? hook.score : 0.7,
      };

      record.triggerCount++;
      record.lastTriggeredAt = Date.now();
      // 🩺 不再寫死 successCount++，由 CRAG 評估後透過 reportHookOutcome() 回報

      // LRU 淘汰：超過上限時移除最舊的 entry（Map 保留插入順序）
      if (!this.qualityTracker.has(keyword) && this.qualityTracker.size >= this.MAX_QUALITY_TRACKER_SIZE) {
        const oldest = this.qualityTracker.keys().next().value;
        if (oldest) this.qualityTracker.delete(oldest);
      }
      this.qualityTracker.set(keyword, record);
    }

    return {
      triggered: true,
      relatedMemories: topResults,
      naturalLanguage,
    };
  }

  /**
   * CRAG 評估後回報 hook 觸發結果（由 Retriever 呼叫）
   * @param keyword - 觸發的 hook keyword
   * @param wasRetained - CRAG 評估後該記憶是否被保留
   */
  async reportHookOutcome(keyword: string, wasRetained: boolean): Promise<void> {
    // See triggerHooks: freeze adaptive quality/weight drift under the confirmatory flag.
    if (process.env.MR_OTTER_READONLY === '1') return;
    const record = this.qualityTracker.get(keyword);
    if (!record) return;

    if (wasRetained) {
      record.successCount++;
    } else {
      record.failCount++;
    }

    // 重新計算調整後權重
    const total = Math.min(record.triggerCount, this.QUALITY_WINDOW);
    const recentRate = total > 0 ? record.successCount / total : 0.5;

    if (recentRate >= this.HIGH_SUCCESS_RATE) {
      record.adjustedNumericWeight = Math.min(1.0, record.currentNumericWeight * 1.1);
      console.log(`[HooksEngine] Weight increased: ${keyword} -> ${record.adjustedNumericWeight.toFixed(2)} (rate=${recentRate.toFixed(2)})`);
    } else if (recentRate < this.SUCCESS_RATE_THRESHOLD) {
      record.adjustedNumericWeight = Math.max(0.1, record.currentNumericWeight * 0.8);
      console.log(`[HooksEngine] Weight decreased: ${keyword} -> ${record.adjustedNumericWeight.toFixed(2)} (rate=${recentRate.toFixed(2)})`);
    }

    this.qualityTracker.set(keyword, record);

    // Hook 淘汰：觸發 5 次以上且成功率為 0 → 移除
    if (record.triggerCount >= 5 && record.successCount === 0) {
      console.log(`[HooksEngine] Removing ineffective hook: ${keyword}`);
      this.qualityTracker.delete(keyword);
      await this._deleteDBRecord(keyword);
    }

    await this.schedulePersist();
  }

  private async _deleteDBRecord(keyword: string): Promise<void> {
    if (!this._db) return;
    try {
      const table = await this._db.openTable('hook_stats');
      if (typeof keyword !== 'string' || keyword.length === 0) return;
      const escaped = keyword.replace(/'/g, "''");
      await table.delete(`keyword = '${escaped}'`);
    } catch (err: any) {
      console.warn(`[HooksEngine] _deleteDBRecord failed for "${keyword}":`, err.message);
    }
  }

  private extractKeywords(queryText: string): string[] {
    return Array.from(new Set(splitHookTokens(queryText)));
  }

  private generateNaturalLanguage(
    results: { memory: MemoryEntry; score: number; viaHook: string }[]
  ): string {
    if (results.length === 0) return "";

    const phrases = results.map(r => {
      const memoryText = r.memory.text.length > 30
        ? r.memory.text.slice(0, 30) + "..."
        : r.memory.text;
      return memoryText;
    });

    const templates = [
      `對了，突然想到：${phrases[0]}`,
      `順便記得：${phrases[0]}`,
      `想起來了：${phrases[0]}`,
      phrases.length > 1
        ? `順便想起相關的：${phrases.slice(0, 2).join('、')}...`
        : `記得你之前提過：${phrases[0]}`,
    ];

    return templates[Math.floor(Math.random() * templates.length)];
  }

  // ── HookStats 持久化 ──────────────────────────────────────────────────────

  private _setupDebounce(): void {
    // no-op for now
  }

  private _registerShutdown(): void {
    this.store.onShutdown(async () => {
      if (this.isDirty) {
        await this.flush();
      }
    });
  }

  private schedulePersist(): void {
    this.isDirty = true;

    // debounce 30s — reset on every call
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), 30_000);

    // hard cap 5min — only set if not already running
    if (!this.hardCapTimer) {
      this.hardCapTimer = setTimeout(() => this.flush(), 300_000);
    }
  }

  public async flush(): Promise<void> {
    if (!this.isDirty) return;

    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    if (this.hardCapTimer) { clearTimeout(this.hardCapTimer); this.hardCapTimer = undefined; }
    this.isDirty = false;

    await this.persistStats();
  }

  public async loadStats(): Promise<void> {
    if (!this._db) return;
    const tableName = 'hook_stats';
    let table: lancedb.Table;

    try {
      table = await this._db.openTable(tableName);
    } catch {
      // table not exist = first run, nothing to load
      console.log('[HooksEngine] hook_stats table not found, skipping loadStats');
      return;
    }

    const results = await table.query().limit(10000).toArray();
    for (const row of results) {
      const keyword = row['keyword'] as string;
      if (!keyword) continue; // 防禦 DB 污染

      const record: HookQualityRecord = {
        keyword,
        triggerCount: row['triggerCount'] as number,
        successCount: row['successCount'] as number,
        failCount: row['failCount'] as number,
        lastTriggeredAt: (row['lastTriggeredAt'] as number) || null,
        currentNumericWeight: row['currentNumericWeight'] as number,
        adjustedNumericWeight: row['adjustedNumericWeight'] as number,
      };
      this.qualityTracker.set(keyword, record);
    }

    console.log(`[HooksEngine] loadStats: loaded ${results.length} records`);
  }

  public async persistStats(): Promise<void> {
    if (!this._db) return;
    const tableName = 'hook_stats';
    const db = this._db;
    let table: lancedb.Table;

    try {
      table = await db.openTable(tableName);
    } catch {
      // table not exist = create with schema using apache-arrow types
      const schema = new Schema([
        new Field('keyword', new Utf8(), false),
        new Field('triggerCount', new Int32()),
        new Field('successCount', new Int32()),
        new Field('failCount', new Int32()),
        new Field('lastTriggeredAt', new Int64()),
        new Field('currentNumericWeight', new Float32()),
        new Field('adjustedNumericWeight', new Float32()),
        new Field('updatedAt', new Int64()),
      ]);
      await db.createEmptyTable(tableName, schema);
      table = await db.openTable(tableName);
    }

    const now = Date.now();
    const rows = Array.from(this.qualityTracker.values()).map((record) => ({
      keyword: record.keyword,
      triggerCount: record.triggerCount,
      successCount: record.successCount,
      failCount: record.failCount,
      lastTriggeredAt: record.lastTriggeredAt ?? 0,
      currentNumericWeight: record.currentNumericWeight,
      adjustedNumericWeight: record.adjustedNumericWeight,
      updatedAt: now,
    }));

    // Use makeArrowTable to build an Arrow table, then pass to mergeInsert.execute
    const arrowTable = (lancedb as any).makeArrowTable
      ? (lancedb as any).makeArrowTable(rows, {
          schema: new Schema([
            new Field('keyword', new Utf8(), false),
            new Field('triggerCount', new Int32()),
            new Field('successCount', new Int32()),
            new Field('failCount', new Int32()),
            new Field('lastTriggeredAt', new Int64()),
            new Field('currentNumericWeight', new Float32()),
            new Field('adjustedNumericWeight', new Float32()),
            new Field('updatedAt', new Int64()),
          ]),
        })
      : rows;

    await table.mergeInsert(['keyword'])
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(arrowTable as any);
    await recordAuxTableWrite(table, "ram:hook_stats");

    console.log(`[HooksEngine] persistStats: wrote ${rows.length} records`);
  }
}
