/**
 * Retriever - Hybrid Search (正確實現 RRF Fusion) + CRAG Evaluator
 * memory-lance-v4
 * * 核心功能：
 * - 混合檢索 (向量 + BM25) 與 RRF Fusion
 * - V4 記憶權重計分 (相似度 + 重要度 + 健康度)
 * - 本地毫秒級 CRAG 評估器 (MiniLM 餘弦相似度)
 * - 赫布理論 (Hebbian Learning) 自動強化記憶
 */

import { MemoryStore, type MemorySearchResult } from "../store/store-v4.js";
import { Embedder } from "../providers/embedder-v5.js";
import { HooksEngine, type HookTriggerResult } from "../cognition/hooks-engine.js";
import { judgeAbstractness } from "./abstractness-judge.js";
import { applyCragCrossEncoderGate, isCragCrossEncoderGateEnabled, scoreCandidates } from "./cross-encoder-gate.js";
import { coverageLambda, isCoverageSelectionEnabled, mmrOrder } from "./coverage-selection.js";
import type { PluginConfig, MemoryEntry } from "../types.js";
import { hashQuery } from "../util/util-hash.js";

const RRF_K = 60;
const BACKGROUND_WRITE_QUEUE_LIMIT = 100;

// ── CRAG relevance gating (Qwen cosine distance = 1 − cosine) ──────────────────
// See docs/internal/TICKET_CRAG_QWEN_RERANK.md. CRAG scores every candidate by
// 1 − cosine(queryVector, entry.vector) — one uniform, metric-agnostic Qwen scale
// across vector / FTS-only / hook candidates — instead of a separate MiniLM model.
// Seed values; recalibrate via `mr-bench crag` + LoCoMo (do NOT treat as final).
// Recall-safe by design (decided 2026-06-14). Calibration (Qwen3 1024d) found a
// hard precision/recall tension a single absolute threshold cannot resolve: the
// crag precision fixture wants ~0.36 (near-miss distractors ≥0.37) but LoCoMo true
// evidence sits at median 0.506 / p90 0.598, so a 0.36 cut would drop ~97% of real
// answers. CRAG's job is to drop clearly-irrelevant memories and stop the recall
// collapse — NOT to resolve near-misses (dense embedding can't separate
// near-equivalents; that's a separate concern). So we sit at the recall-safe end.
// See docs/internal/CRAG_DISTRACTOR_FINDINGS_2026-06-14.md.
const CRAG_VIP_DIST = 0.30;  // <= → VIP auto-keep (very similar)
const CRAG_DIST_YES = 0.55;  // <= → keep
const CRAG_DIST_NO = 0.65;   // >= → drop; between DIST_YES and DIST_NO → partial

// Hook-injected candidates are a bypass recall path: they enter cragInput with a
// generation-time weight, not a query-relevance score. They must be held to a
// STRICTER vector-distance gate than normal candidates and must NOT auto-keep on an
// uncomputable distance (topic-relevant-but-wrong hooks were polluting context).
const HOOK_CRAG_DIST_YES = 0.48;    // hook keep threshold (stricter than CRAG_DIST_YES)
const HOOK_INJECT_SCORE_CAP = 0.35; // hooks are supplements; never outrank real top hits

export interface HybridSearchResponse {
  results: MemorySearchResult[];
  hookOriginIds: string[];
  hookOriginKeywords: Record<string, string>;
  queryHash: string;
}

type CausalChainNode = {
  entry: MemoryEntry;
  hopFromSeed: number;
  origin: 'parent' | 'child' | 'seed';
};

/**
 * CRAG 評估結果
 */
interface CRAGEvaluation {
  relevance: "yes" | "no" | "partial";
  extracted_info: string;
}

const LOCAL_RERANK_THRESHOLD_CORRECT = 0.63;
const LOCAL_RERANK_THRESHOLD_INCORRECT = 0.4;

/**
 * Cosine distance (1 − cosine similarity) between two equal-length vectors.
 * Returns +Infinity when the vectors are missing, empty, or mismatched in length
 * so callers route to a "partial"/fallback path rather than a false "very close".
 */
function cosineDistance(a: number[] | undefined | null, b: number[] | undefined | null): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return Number.POSITIVE_INFINITY;
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Number.isNaN(cos) ? Number.POSITIVE_INFINITY : 1 - cos;
}

/**
 * Entity Synergy Merger — 搶救 partial 記憶的抽吸式合併模組
 *
 * 核心思路（來自 MergeRAG 靈感，但不走 LLM 生成）：
 * 兩條 partial 記憶如果共享「橋接實體」（entity overlap），代表它們可能在描述
 * 同一事件的不同面向。合併時用「句子級 BM25」決定誰留誰砍，純抽取不生成。
 *
 * 流程：
 *  1. 用正則抽出命名實體（人/地/組織/時間/專有名詞）
 *  2. 找出 entity overlap 超過門檻的記憶對
 *  3. 對記憶文字做句子分割，保留 BM25 分數最高的句子（去冗餘）
 *  4. 合併後用 MiniLM 重新評估 relevanc → 過關就升級進結果池
 */
class EntitySynergyMerger {
  // ── 輕量 NER：正則抽取（零外部依賴，毫秒完成） ──────────────
  private static readonly ENTITY_PATTERNS = [
    // 中文姓名 (兩字以上)
    { type: "PERSON",     pattern: /[A-Za-z][a-z]+ [A-Z][a-z]+|[가-힣]{2,4}|[一二三李王張劉陳楊黃趙周吳徐孫馬朱胡郭何林高羅鄭梁謝宋唐許韓鄧馮曹曾程蔡潘田董袁于余蘇葉賈魏崔史侯孟龍万段雷钱汤白汪]|[A-Z][a-z]+/g },
    // 數數數數/基數（單用數值本身沒意義，要配合上下文）
    { type: "NUMBER",     pattern: /\d+(?:\.\d+)?[萬億千百十個多約大概約]/g },
    // 百分比
    { type: "PERCENT",    pattern: /\d+(?:\.\d+)?%/g },
    // 日期/時間
    { type: "DATE",       pattern: /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:\s*\d{1,2}[時:點]\d{1,2}分?)?|\d{1,2}[-/月]\d{1,2}[日]?(?:\s*\d{1,2}[時:點])?|昨[天日晚早]|今[天日晚早]|明[天日晚早]|上[周個月]|這[周個月]|大前|前天|後天|早上|下午|晚上|凌晨|傍晚/g },
    // 地點
    { type: "LOCATION",   pattern: /[臺台]北|[臺台]中|[臺台]南|[臺台]東|高雄|新北|桃園|彰化|宜蘭|花蓮|臺北市|新北市|桃園市|高雄市|[A-Z][a-z]+(?:市|縣|區|鎮|鄉|路|街|大道)/g },
    // URL / 網域
    { type: "URL",        pattern: /https?:\/\/[^\s]+|[a-zA-Z0-9_-]+\.(?:com|org|net|io|cc|tw|hk|ru|cn|me|info|biz|co|in|us|uk|au|jp|kr|dev|app|tech|ai|cloud|site|online|website|xyz|pro|live|ws|fm|ml|cc|ai)/gi },
    // 品牌 / 產品名（駝峰或全大寫）
    { type: "BRAND",      pattern: /[A-Z][a-z]+(?:[A-Z][a-z]|[0-9])+|\b(?:OpenClaw|Claude|MiniMax|Yeelight|NestHub|GPT|Claude|Cline|Codex|ArtiMart|Blend)|(?:[A-Z][a-z]+){2,}/g },
    // 技術術語 / 專案名
    { type: "TERM",      pattern: /(?<![a-zA-Z])[A-Z][a-z]+(?:[A-Z][a-z]|\d)*?(?![a-zA-Z])|(?:記憶庫|記憶引擎|CRAG|Hooks|因果鏈|Hebbian|濃縮引擎)/g },
  ];

  /**
   * 從文字抽出命名實體集合
   * @returns Map<entity_type, Set<entity_value>>
   */
  static extractEntities(text: string): Map<string, Set<string>> {
    const entities = new Map<string, Set<string>>();

    for (const { type, pattern } of this.ENTITY_PATTERNS) {
      const matches = text.match(pattern);
      if (!matches) continue;
      if (!entities.has(type)) entities.set(type, new Set());
      for (const m of matches) {
        const cleaned = m.trim().toLowerCase();
        if (cleaned.length > 1) entities.get(type)!.add(cleaned);
      }
    }

    // 全文切片：每個 Token（簡單分詞，空白+標點）
    const tokens = text.toLowerCase().split(/[\s\p{P}]+/u);
    // 把未分類的高信息量 token 當作 GENERAL 實體（過濾停用詞）
    const stopWords = new Set(["的","是","在","了","和","與","或","以及","以及","有","沒有","這個","那個","也","就","都","而","但","或","如果","因為","所以","可以","會","能","一個","什麼","怎麼","如何","為什麼","多少"]);
    const general = new Set<string>();
    for (const t of tokens) {
      const alreadyFound = [...entities.values()].some(s => s.has(t));
      if (t.length >= 3 && !stopWords.has(t) && !/^\d+$/.test(t) && !alreadyFound) {
        general.add(t);
      }
    }
    if (general.size > 0) entities.set("GENERAL", general);

    return entities;
  }

  /**
   * 計算兩個實體集合的 overlap 分數（IDF-weighted Jaccard）
   * 只看共享數量，不重複計
   */
  static computeOverlap(entitiesA: Map<string, Set<string>>, entitiesB: Map<string, Set<string>>): number {
    let sharedCount = 0;
    let totalUnique = 0;

    const allTypes = new Set([...entitiesA.keys(), ...entitiesB.keys()]);
    for (const type of allTypes) {
      const setA = entitiesA.get(type) || new Set();
      const setB = entitiesB.get(type) || new Set();
      // 同類型 overlap 權重更高
      const typeWeight = (type === "GENERAL") ? 0.5 : 1.5;

      for (const entity of setA) {
        if (setB.has(entity)) {
          sharedCount += typeWeight;
        }
        totalUnique += typeWeight;
      }
      for (const entity of setB) {
        if (!setA.has(entity)) totalUnique += typeWeight;
      }
    }

    return totalUnique > 0 ? sharedCount / totalUnique : 0;
  }

  /**
   * 合併兩條記憶：句子級拼接 + BM25 去冗餘
   *
   * @param texts 記憶文字陣列（來自不同記憶）
   * @param query 原始查詢（用於 BM25 打分）
   * @returns 合併後的文字
   */
  static mergeMemories(texts: string[], query: string): string {
    // Step 1: 句子分割（簡單正則，保持中文句式）
    const sentences: string[] = [];
    for (const text of texts) {
      // 按中英文句末標點分割
      const parts = text.split(/(?<=[。！？.!?])\s*/).filter(s => s.trim().length > 5);
      sentences.push(...parts);
    }

    if (sentences.length === 0) return texts.join("\n");
    if (sentences.length === 1) return sentences[0];

    // Step 2: 簡單 BM25 句子打分（query terms 在句中出現次數 / 句長標準化）
    const queryTerms = query.toLowerCase().split(/[\s\p{P}]+/u).filter(t => t.length > 1);
    const scored = sentences.map((sentence, idx) => {
      const lower = sentence.toLowerCase();
      let score = 0;
      for (const term of queryTerms) {
        // term comes from raw query text and can contain regex metachars (e.g. "c++"),
        // which crash new RegExp(); count non-overlapping occurrences via split instead.
        const count = lower.split(term).length - 1;
        score += count;
      }
      // 長句懲罰（避免稀釋重點）
      const lengthNorm = 1 / Math.log2(sentence.length + 3);
      return { sentence, score: score * lengthNorm, idx };
    });

    // Step 3: 取 top-N 句子（N = min(6, 全部)），去除重複描述
    const topN = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    // Step 4: 去除內容高度重疊的句子（simple char-level n-gram jaccard）
    const finalSentences: string[] = [];
    for (const { sentence } of topN) {
      const isDuplicate = finalSentences.some(existing =>
        this.ngramJaccard(existing, sentence, 3) > 0.6
      );
      if (!isDuplicate) finalSentences.push(sentence);
    }

    return finalSentences.join("。").replace(/。+/g, "。").trim() + "。";
  }

  /**
   * 計算兩個字串的 n-gram Jaccard 相似度（用於去重）
   */
  private static ngramJaccard(a: string, b: string, n = 3): number {
    const ng = (s: string) => {
      const chars = s.split("");
      const set = new Set<string>();
      for (let i = 0; i <= chars.length - n; i++) {
        set.add(chars.slice(i, i + n).join(""));
      }
      return set;
    };
    const setA = ng(a);
    const setB = ng(b);
    let intersection = 0;
    for (const g of setA) {
      if (setB.has(g)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }
}

/**
 * 本地 Reranker Singleton
 *
 * @deprecated DEAD as of the Qwen-cosine CRAG rerank (TICKET_CRAG_QWEN_RERANK).
 * No runtime path calls `evaluateRelevance` any more — CRAG and synergy merge now
 * score on Qwen cosine distance. Kept temporarily so the `transformers`/MiniLM
 * dependency removal can land as a separate, isolated follow-up. Do not add callers.
 */
class LocalReranker {
  private static extractor: any = null;
  private static initializing: Promise<any> | null = null;
  
  // 🛠️ 新增：Query 向量快取
  private static lastQuery: string = "";
  private static lastQueryEmb: any = null;

  static async init(cacheDir: string): Promise<any> {
    if (this.extractor) {
      return this.extractor;
    }

    if (this.initializing) {
      return this.initializing;
    }

    this.initializing = (async () => {
      console.log("[LocalReranker] Loading lightweight evaluation model...");
      const startTime = Date.now();

      const { pipeline, env } = await import("@xenova/transformers");
      env.cacheDir = cacheDir;

      this.extractor = await pipeline(
        "feature-extraction",
        "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        {
          quantized: true,
        } as any
      );

      console.log(`[LocalReranker] Model loaded in ${Date.now() - startTime}ms`);
      return this.extractor;
    })();

    return this.initializing;
  }

  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      if (isNaN(a[i]) || isNaN(b[i])) continue;
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const result = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    return isNaN(result) ? 0 : result;
  }

  static async evaluateRelevance(query: string, memoryText: string, cacheDir: string): Promise<CRAGEvaluation> {
    if (!this.extractor) {
      await this.init(cacheDir);
    }

    try {
      // 🛠️ 核心修復：只有當 query 改變時，才重新計算 Query Embedding (省 50% 算力)
      if (query !== this.lastQuery || !this.lastQueryEmb) {
        this.lastQueryEmb = await this.extractor(query, { pooling: "mean", normalize: true });
        this.lastQuery = query;
      }

      // 只計算 Memory 的 Embedding
      const mEmb = await this.extractor(memoryText, { pooling: "mean", normalize: true });

      const similarity = this.cosineSimilarity(this.lastQueryEmb.data, mEmb.data);

      if (similarity >= LOCAL_RERANK_THRESHOLD_CORRECT) {
        return { relevance: "yes", extracted_info: "" };
      } else if (similarity <= LOCAL_RERANK_THRESHOLD_INCORRECT) {
        return { relevance: "no", extracted_info: "" };
      } else {
        return { relevance: "partial", extracted_info: "" };
      }
    } catch (err) {
      console.error("[LocalReranker] Evaluation failed:", err);
      return { relevance: "no", extracted_info: "" };
    }
  }
}

export class Retriever {
  private vectorWeight: number;
  private bm25Weight: number;
  private candidatePoolMultiplier: number;
  private hooksEngine: HooksEngine | null = null;
  private boostHealthQueue: string[] = [];
  private boostHealthQueueRunning = false;
  private recallMetadataQueue: Array<Array<MemoryEntry | { id: string }>> = [];
  private recallMetadataQueueRunning = false;

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    config: PluginConfig["retrieval"],
    private readonly rerankerCacheDir: string,
    hooksEngine?: HooksEngine,
  ) {
    this.vectorWeight = config?.vectorWeight ?? 0.7;
    this.bm25Weight = config?.bm25Weight ?? 0.3;
    this.candidatePoolMultiplier = config?.candidatePoolMultiplier ?? 2;
    this.hooksEngine = hooksEngine || null;
  }

  async hybridSearch(query: string, limit = 5): Promise<HybridSearchResponse> {
    return await this.hybridSearchInternal(query, limit, true);
  }

  async hybridSearchWithoutBoost(query: string, limit = 5): Promise<HybridSearchResponse> {
    return await this.hybridSearchInternal(query, limit, false);
  }

  private async hybridSearchInternal(query: string, limit = 5, enableHebbian = true): Promise<HybridSearchResponse> {
    const queryHash = hashQuery(query);
    const poolSize = limit * this.candidatePoolMultiplier;

    // 統一使用 store 的 hybridVectorSearch（向量 + FTS + RRF Fusion）
    const fused = await this.store.hybridVectorSearch(query, poolSize);

    const weighted = fused.map((r) => ({
      ...r,
      fusedScore: (this.vectorWeight * r.rankScore) + (this.bm25Weight * r.bm25Score),
    }));

    const scored = weighted.sort((a, b) => b.fusedScore - a.fusedScore).slice(0, poolSize).map((r) => {
      let importance = 0.5;
      let health = 1.0;
      let entities: any[] = [];
      let meta: any = null;

      try {
        if (r.entry.metadata) {
          meta = typeof r.entry.metadata === 'string'
            ? JSON.parse(r.entry.metadata)
            : r.entry.metadata;

          if ((r.entry as any).importance !== undefined) importance = (r.entry as any).importance;
          if (meta?.health?.healthScore !== undefined) health = (typeof meta.health.healthScore === 'number' ? meta.health.healthScore : 100) / 100;
          if (meta?.entities) entities = meta.entities;
        }
      } catch { /* metadata parse fail, use defaults */ }

      const similarity = Math.min(r.fusedScore * 60, 1.0);
      let abstractness = 0;
      if (meta?.abstractness !== undefined) {
        abstractness = Number(meta.abstractness) || 0;
      } else {
        try {
          const judgement = judgeAbstractness(r.entry.text);
          abstractness = judgement.abstractness;
        } catch {
          abstractness = 0;
        }
      }

      const baseScore = (similarity * 0.5) + (importance * 0.3) + (health * 0.2);
      const penalty = 1 - (0.5 * abstractness);
      const finalScore = baseScore * penalty;

      if (abstractness > 0.3 && typeof (this.store as any).recordSubsystemEffectiveness === 'function') {
        void (this.store as any).recordSubsystemEffectiveness({
          subsystem: 'retrieval',
          event: 'abstract_penalized',
          entityId: r.entry.id,
          outcome: 'penalized',
          queryHash,
          score: penalty,
          count: 1,
          metadata: {
            abstractness,
            baseScore,
            finalScore,
            penalty,
            // P3.3: 雙寫冗餘期。新查詢用 isFromMetadata。Phase A 收尾後砍 hasMetadataAbstractness
            hasMetadataAbstractness: meta?.abstractness !== undefined,
            isFromMetadata: meta?.abstractness !== undefined,
            textPreview: r.entry.text.slice(0, 60),
          },
        }).catch(() => {});
      }

      return {
        ...r,
        finalScore,
      };
    });

    const reRanked = scored
      .sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0))
      .slice(0, poolSize);

    // ── Structured Slot 去重：同 slotKey 只留最新 active 版本 ─
    // Phase 1：slotKey 相同的多個版本，優先回傳 status=active 且 createdAt 最新者
    const slotVersionMap = new Map<string, { idx: number; createdAt: number; isActive: boolean }>();
    const dedupedResults: any[] = [];

    for (let i = 0; i < reRanked.length; i++) {
      const r = reRanked[i] as any;
      const slotKey = r.entry.slotKey as string | undefined;

      if (!slotKey) {
        // 無 slotKey → 直接保留
        dedupedResults.push(r);
        continue;
      }

      // 嘗試從 metadata 取 status（entry.status 可能未定義）
      let status = 'active';
      let createdAt = r.entry.createdAt || 0;
      try {
        const meta = typeof r.entry.metadata === 'string'
          ? JSON.parse(r.entry.metadata)
          : (r.entry.metadata || {});
        status = meta?.status || 'active';
      } catch { /* ignore */ }

      const isActive = status === 'active';
      const existing = slotVersionMap.get(slotKey);

      if (!existing) {
        if (isActive) {
          // 第一個版本是 active → 直接加入結果
          const idx = dedupedResults.length;
          slotVersionMap.set(slotKey, { idx, createdAt, isActive: true });
          dedupedResults.push(r);
        } else {
          // 第一個版本是 inactive → 暫存但不加入結果（idx = -1 表示未入列）
          slotVersionMap.set(slotKey, { idx: -1, createdAt, isActive: false });
        }
      } else if (isActive && createdAt > existing.createdAt) {
        // 更新的 active 版本
        if (existing.idx >= 0 && existing.idx < dedupedResults.length) {
          dedupedResults[existing.idx] = r; // 替換已存在的版本
        } else {
          // 之前沒入列（inactive）→ 現在加入
          const newIdx = dedupedResults.length;
          slotVersionMap.set(slotKey, { idx: newIdx, createdAt, isActive: true });
          dedupedResults.push(r);
          continue;
        }
        slotVersionMap.set(slotKey, { idx: existing.idx, createdAt, isActive: true });
      }
      // else: 非 active 或更舊的 active → 跳過
    }

    const finalResults = dedupedResults;

    // ── 記憶鉤子觸發（CRAG 之前，讓 hook 記憶也經過品質審核） ──
    // hookKeywordMap: EVERY triggered hook → drives reportHookOutcome so the engine's
    //   triggerCount denominator stays balanced (a triggered hook we don't inject must
    //   still get an outcome, else it is silently penalised toward eviction).
    // hookInjectedIds: ONLY hook-exclusive injected candidates → drives the stricter CRAG
    //   hook gate. A memory already retrieved on merit must NOT be subjected to it.
    const hookKeywordMap = new Map<string, string>();
    const hookInjectedIds = new Set<string>();
    const cragInput: any[] = [...finalResults]; // 以 finalResults 為基底（已做 slot 去重）
    try {
      const hookResult = await this.triggerHooks(query);
      if (hookResult.triggered) {
        console.log(`[Retriever] Hook triggered: ${hookResult.relatedMemories.length} related memories`);
        const existingIds = new Set(finalResults.map(r => r.entry.id));
        for (const hookMem of hookResult.relatedMemories) {
          const memoryId = hookMem.memory.id;
          hookKeywordMap.set(memoryId, hookMem.viaHook); // all triggered → balanced outcome
          this.recordHookEffectiveness({
            event: "hook_triggered",
            entityId: memoryId,
            queryHash,
            outcome: "triggered",
            score: hookMem.score,
            metadata: {
              keyword: hookMem.viaHook,
              sourceMemoryId: memoryId,
            },
          });
          if (existingIds.has(memoryId)) continue; // already retrieved on merit; don't re-inject / don't strict-gate
          // Fetch the real stored vector so the hook candidate goes through the SAME CRAG
          // vector-distance gate as everything else. queryHookBearing() returns vector:[]
          // (scan efficiency); only the few injected hooks pay this lookup, so Fix-1's
          // no-vector scan stays cheap.
          let hookVector: number[] = [];
          try {
            const full = await this.store.getById(memoryId, true);
            if (full && Array.isArray(full.vector)) hookVector = full.vector;
          } catch { /* fall through to vector-missing handling */ }
          if (hookVector.length === 0) {
            // Data-integrity miss (no stored vector), NOT a relevance failure. Skip
            // injection and record distinctly so quality tracking can tell them apart.
            this.recordHookEffectiveness({
              event: "hook_vector_missing",
              entityId: memoryId,
              queryHash,
              outcome: "dropped",
              score: hookMem.score,
              metadata: { keyword: hookMem.viaHook, sourceMemoryId: memoryId },
            });
            continue;
          }
          existingIds.add(memoryId);
          hookInjectedIds.add(memoryId); // subject to the stricter CRAG hook gate
          const injectScore = Math.min(hookMem.score, HOOK_INJECT_SCORE_CAP);
          cragInput.push({
            entry: { ...hookMem.memory, vector: hookVector },
            vectorScore: 0,
            rankScore: 0,
            rawDistance: Number.POSITIVE_INFINITY,
            bm25Score: 0,
            fusedScore: injectScore,
            finalScore: injectScore,
          });
        }
      }
    } catch (err) {
      console.warn('[Retriever] Hook execution failed:', err);
    }

    const cragFiltered = await this.cragEvaluate(query, cragInput, enableHebbian, hookInjectedIds);
    console.log(`[Retriever] Search complete: ${cragInput.length} candidates -> ${cragFiltered.length} CRAG results (hook-injected=${hookInjectedIds.size})`);

    // ── Hook 品質回報：CRAG 後比對哪些 hook 記憶存活 ──
    if (hookKeywordMap.size > 0 && this.hooksEngine) {
      const retainedIds = new Set(cragFiltered.map(r => r.entry.id));
      const cragInputById = new Map(cragInput.map(r => [r.entry.id, r]));
      const cragFilteredById = new Map(cragFiltered.map(r => [r.entry.id, r]));
      for (const [memId, keyword] of hookKeywordMap) {
        const retained = retainedIds.has(memId);
        await this.hooksEngine.reportHookOutcome(keyword, retained);
        const scored = cragFilteredById.get(memId) ?? cragInputById.get(memId);
        this.recordHookEffectiveness({
          event: "hook_crag_retained",
          entityId: memId,
          queryHash,
          outcome: retained ? "retained" : "dropped",
          score: Number((scored as any)?.finalScore ?? (scored as any)?.fusedScore ?? 0),
          metadata: { keyword },
        });
      }
    }

    // ── 因果鏈擴展 ──
    const chainResults: MemorySearchResult[] = [];
    const chainIds = new Set(cragFiltered.map(r => r.entry.id));
    const causalSeedMap = new Map<string, string>();

    for (const result of cragFiltered) {
      try {
        const chain = await this.getCausalChain(result.entry.id, 2);
        for (const node of chain) {
          if (node.origin === 'seed') continue;
          if (chainIds.has(node.entry.id)) continue;

          chainIds.add(node.entry.id);
          const seedFinalScore = (result as any).finalScore ?? result.fusedScore;
          const causalScore = seedFinalScore * 0.7;
          const chainIndex = chainResults.length;
          chainResults.push({
            entry: node.entry,
            vectorScore: 0,
            rankScore: 0,
            rawDistance: Number.POSITIVE_INFINITY,
            bm25Score: 0,
            fusedScore: causalScore,
            finalScore: causalScore,
          } as any);
          causalSeedMap.set(node.entry.id, result.entry.id);

          const recordSubsystemEffectiveness = (this.store as any).recordSubsystemEffectiveness;
          if (typeof recordSubsystemEffectiveness === 'function') {
            void recordSubsystemEffectiveness.call(this.store, {
              subsystem: 'causal',
              event: 'expansion_added',
              entityId: node.entry.id,
              relatedId: result.entry.id,
              queryHash,
              outcome: 'added',
              score: causalScore,
              count: 1,
              durationMs: 0,
              metadata: {
                seedFinalScore,
                seedViaHook: hookKeywordMap.has(result.entry.id),
                chainOrigin: node.origin,
                hopFromSeed: node.hopFromSeed,
                chainIndex,
              },
            }).catch((err: any) => {
              console.warn('[PR-A3] expansion_added write failed:', err?.message ?? err);
            });
          }
        }
      } catch (err) {
        console.warn(`[Retriever] Causal-chain expansion failed for ${result.entry.id.slice(0,8)}:`, err);
      }
    }

    let gatedChainResults = chainResults;
    if (chainResults.length > 0 && isCragCrossEncoderGateEnabled()) {
      gatedChainResults = await applyCragCrossEncoderGate(query, chainResults, {
        cacheDir: this.rerankerCacheDir,
        topK: chainResults.length,
        logger: console,
      });
      const dropped = chainResults.length - gatedChainResults.length;
      if (dropped > 0) {
        console.log(`[CRAG] causal-chain cross-encoder gate dropped ${dropped}/${chainResults.length} bypass candidates`);
      }
    }

    // 合併並重新排序
    const allResults: any[] = [...cragFiltered, ...gatedChainResults]
      .sort((a, b) => ((b as any).finalScore || 0) - ((a as any).finalScore || 0));
    let total = allResults.slice(0, limit);
    if (isCoverageSelectionEnabled(process.env)) {
      // Known limitation: flag ON causes a second cross-encode pass over survivors (separate from the gate pass). Sharing a single pass with the gate is a future optimization.
      const coverageScores = await scoreCandidates(query, allResults, {
        topK: allResults.length,
        cacheDir: this.rerankerCacheDir,
        logger: console,
      });
      if (coverageScores !== null) {
        const relevance = coverageScores.scored.map(scored => scored.logit);
        const vectors = coverageScores.scored.map(scored => (scored.candidate.entry as any).vector ?? null);
        const order = mmrOrder(relevance, vectors, coverageLambda(process.env));
        total = order.map(index => coverageScores.scored[index].candidate).slice(0, limit);
      }
    }
    if (gatedChainResults.length > 0) {
      const totalById = new Map<string, number>();
      total.forEach((r: any, idx: number) => {
        if (r?.entry?.id) totalById.set(r.entry.id, idx);
      });

      const recordSubsystemEffectiveness = (this.store as any).recordSubsystemEffectiveness;
      if (typeof recordSubsystemEffectiveness === 'function') {
        for (const cr of gatedChainResults) {
          const expandedId = (cr as any).entry.id;
          const rankInFinal = totalById.has(expandedId) ? totalById.get(expandedId)! : -1;
          const survived = rankInFinal >= 0;
          const seedId = causalSeedMap.get(expandedId) ?? '';

          void recordSubsystemEffectiveness.call(this.store, {
            subsystem: 'causal',
            event: 'expansion_survived_rank',
            entityId: expandedId,
            relatedId: seedId,
            queryHash,
            outcome: survived ? 'survived' : 'dropped',
            score: Number((cr as any).finalScore ?? 0),
            count: 1,
            durationMs: 0,
            metadata: {
              rankInFinal,
              totalLimit: limit,
              chainResultsCount: gatedChainResults.length,
              chainResultsBeforeGate: chainResults.length,
              cragFilteredCount: cragFiltered.length,
            },
          }).catch((err: any) => {
            console.warn('[PR-A3] expansion_survived_rank write failed:', err?.message ?? err);
          });
        }
      }
    }
    if (gatedChainResults.length > 0) {
      console.log(`[Retriever] Results: ${cragFiltered.length} direct + ${gatedChainResults.length} causal-chain = ${total.length} total`);
    }

    this.enqueueRecallMetadata(total.map(r => r.entry));

    return {
      results: total,
      hookOriginIds: Array.from(hookKeywordMap.keys()),
      hookOriginKeywords: Object.fromEntries(hookKeywordMap),
      queryHash,
    };
  }

  private recordHookEffectiveness(event: {
    event: string;
    entityId: string;
    queryHash: string;
    outcome: string;
    score?: number;
    metadata?: Record<string, unknown>;
  }): void {
    const recordSubsystemEffectiveness = (this.store as any).recordSubsystemEffectiveness;
    if (typeof recordSubsystemEffectiveness !== "function") return;
    void recordSubsystemEffectiveness.call(this.store, {
      subsystem: "hooks",
      relatedId: "",
      count: 1,
      durationMs: 0,
      ...event,
    }).catch((err: any) => {
      console.warn("[Retriever] hooks effectiveness write failed:", err?.message ?? err);
    });
  }

  private enqueueRecallMetadata(entries: Array<MemoryEntry | { id: string }>): void {
    if (entries.length === 0) return;
    // Same confirmatory-A/B rationale as enqueueBoostHealth: recall metadata (lastRecalledAt/recallCount)
    // is a cross-question write-on-read; coverage selects a different memory set per arm, so leaving it
    // un-gated drifts recall state differently between off/on. No-op only under the flag; production untouched.
    if (process.env.MR_OTTER_READONLY === '1') return;
    if (this.recallMetadataQueue.length >= BACKGROUND_WRITE_QUEUE_LIMIT) {
      this.recallMetadataQueue.shift();
      this.recordQueueDrop("recall_metadata_queue_drop");
    }
    this.recallMetadataQueue.push(entries);
    this.drainRecallMetadataQueue().catch((err: any) => {
      console.warn('[Retriever] recall metadata queue failed:', err?.message ?? err);
    });
  }

  private async drainRecallMetadataQueue(): Promise<void> {
    if (this.recallMetadataQueueRunning) return;
    this.recallMetadataQueueRunning = true;
    try {
      while (this.recallMetadataQueue.length > 0) {
        const entries = this.recallMetadataQueue.shift()!;
        try {
          await this.store.recordMemoryRecalls(entries);
        } catch (err: any) {
          console.warn('[Retriever] recall metadata update failed:', err?.message ?? err);
          this.recordBackgroundWriteFailure("recall_metadata_queue_worker", err);
        }
      }
    } finally {
      this.recallMetadataQueueRunning = false;
    }
  }

  private enqueueBoostHealth(id: string): void {
    // Benchmark confirmatory A/B (MR_OTTER_READONLY=1) freezes the river so each question is an
    // independent probe whose only cross-arm difference is coverage selection. The Hebbian/merge
    // boost is a cross-question write-on-read that drifts healthScore differently per arm (coverage
    // boosts a different memory set), so gate it at this single chokepoint for every boost path
    // (incl. the non-enableHebbian merge boosts). No-op only under the flag; production is untouched.
    if (process.env.MR_OTTER_READONLY === '1') return;
    if (this.boostHealthQueue.length >= BACKGROUND_WRITE_QUEUE_LIMIT) {
      this.boostHealthQueue.shift();
      this.recordQueueDrop("boost_health_queue_drop");
    }
    this.boostHealthQueue.push(id);
    this.drainBoostHealthQueue().catch((err: any) => {
      console.warn('[Retriever] boostHealth queue failed:', err?.message ?? err);
    });
  }

  private async drainBoostHealthQueue(): Promise<void> {
    if (this.boostHealthQueueRunning) return;
    this.boostHealthQueueRunning = true;
    try {
      while (this.boostHealthQueue.length > 0) {
        const id = this.boostHealthQueue.shift()!;
        try {
          await this.store.boostHealth(id);
        } catch (err: any) {
          console.warn(`[Retriever] boostHealth update failed for ${id.slice(0, 8)}:`, err?.message ?? err);
          this.recordBackgroundWriteFailure("boost_health_queue_worker", err);
        }
      }
    } finally {
      this.boostHealthQueueRunning = false;
    }
  }

  private recordQueueDrop(operationName: string): void {
    const recordConflictStat = (this.store as any).recordConflictStat;
    if (typeof recordConflictStat !== "function") return;
    recordConflictStat.call(this.store, {
      operationName,
      callerPath: "src/retriever-v4.ts",
      attempt: 0,
      finalOutcome: "dropped",
      fragmentId: null,
    }).catch((err: any) => {
      console.warn('[Retriever] conflict_stats drop metric failed:', err?.message ?? err);
    });
  }

  private recordBackgroundWriteFailure(operationName: string, err: any): void {
    const recordConflictStat = (this.store as any).recordConflictStat;
    if (typeof recordConflictStat !== "function") return;
    recordConflictStat.call(this.store, {
      operationName,
      callerPath: "src/retriever-v4.ts",
      attempt: 1,
      finalOutcome: "failed",
      fragmentId: this.extractFragmentId(err?.message ?? String(err)),
    }).catch((metricErr: any) => {
      console.warn('[Retriever] conflict_stats failure metric failed:', metricErr?.message ?? metricErr);
    });
  }

  private extractFragmentId(message: string): string | null {
    const match = message.match(/Fragment\s*\{\s*id:\s*(\d+)/);
    return match?.[1] ?? null;
  }



  async vectorOnly(query: string, limit = 5): Promise<MemorySearchResult[]> {
    const vector = await this.embedder.embed(query);
    return await this.store.vectorSearch(vector, limit);
  }

  async ftsOnly(query: string, limit = 5): Promise<MemorySearchResult[]> {
    return await this.store.ftsSearch(query, limit);
  }

  /**
   * 追蹤因果鏈：根據 parentId 向上找原因、向下找結果
   * @param memoryId 起點記憶 ID
   * @param depth 深度（預設 2：爺爺→爸爸→我→孩子→孫子）
   * @returns 因果鏈上的所有 MemoryEntry
   */
  async getCausalChain(memoryId: string, depth = 2): Promise<CausalChainNode[]> {
    const visited = new Set<string>();
    const chain: CausalChainNode[] = [];
    const queue: Array<{ id: string; currentDepth: number; origin: 'parent' | 'child' | 'seed' }> = [
      { id: memoryId, currentDepth: 0, origin: 'seed' }
    ];
    const MAX_CHAIN_NODES = 20; // P1-1 修復：硬性上限，防止大量子節點爆炸

    while (queue.length > 0 && chain.length < MAX_CHAIN_NODES) {
      const item = queue.shift()!;
      if (!item || typeof item.id !== 'string') continue;
      const { id, currentDepth, origin } = item;
      if (visited.has(id) || currentDepth > depth) continue;
      visited.add(id);

      let entry = await this.store.getById(id);
      // fallback：getById 找不到就 query 直接用 id 查（先驗 UUID 避免汙染）
      if (!entry) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          console.warn(`[Retriever] getCausalChain skipped invalid id: ${id.slice(0, 40)}`);
          continue;
        }
        const results = await this.store.query(`id = '${id}'`);
        entry = results[0];
      }
      if (!entry) {
        continue;
      }
      // PR-A3.1: 只在 fallback query 回傳的 entry.id 與查詢 id 不同時才做第二層去重。
      // 正常路徑 entry.id === id，id 已在迴圈開頭 visited.add 過，不可再擋（原 bug）。
      if (entry.id !== id) {
        if (visited.has(entry.id)) continue;
        visited.add(entry.id);
      }
      chain.push({
        entry,
        hopFromSeed: currentDepth,
        origin,
      });

      // 往上：找這個記憶的 parent（原因）
      if (entry.parentId && currentDepth < depth) {
        queue.push({ id: entry.parentId, currentDepth: currentDepth + 1, origin: 'parent' });
      }

      // 往下：找以這個記憶為 parent 的（結果）
      if (currentDepth < depth) {
        try {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.id)) {
            console.warn(`[Retriever] getCausalChain skipped invalid parent id: ${entry.id.slice(0, 40)}`);
            continue;
          }
          const children = await this.store.query(`\`parentId\` = '${entry.id}'`);
          for (const child of children) {
            if (!visited.has(child.id)) {
              queue.push({ id: child.id, currentDepth: currentDepth + 1, origin: 'child' });
            }
          }
        } catch (err) {
          console.warn(`[Retriever] Query children failed:`, (err as Error).message);
        }
      }
    }

    return chain;
  }

  setHooksEngine(engine: HooksEngine): void {
    this.hooksEngine = engine;
  }

  getStore(): MemoryStore {
    return this.store;
  }

  async updateMemoryRecord(
    id: string,
    updates: { text?: string; importance?: number },
  ): Promise<void> {
    await this.store.update(id, updates);
  }

  async triggerHooks(query: string): Promise<HookTriggerResult> {
    if (!this.hooksEngine) {
      return { triggered: false, relatedMemories: [], naturalLanguage: "" };
    }
    return await this.hooksEngine.triggerHooks(query);
  }

  async cragEvaluate(
    query: string,
    results: MemorySearchResult[],
    enableHebbian: boolean = true,
    hookInjectedIds?: Set<string>,
  ): Promise<MemorySearchResult[]> {
    const queryHash = hashQuery(query);
    const candidateMetaById = new Map<string, { rank: number; score: number }>();
    results.forEach((result, index) => {
      candidateMetaById.set(result.entry.id, {
        rank: index,
        score: Number((result as any).finalScore ?? result.fusedScore ?? 0),
      });
    });
    // Only hook-EXCLUSIVELY-injected candidates get the stricter hook gate; memories
    // retrieved on merit (even if also hook-triggered) follow the normal CRAG path.
    const hookSet = hookInjectedIds ?? new Set<string>();
    const hooksTotal = results.reduce(
      (acc, result) => acc + (hookSet.has(result.entry.id) ? 1 : 0),
      0,
    );

    let vipCount = 0;
    let rerankYesCount = 0;
    let rerankNoCount = 0;
    let partialMergedCount = 0;
    let partialDroppedCount = 0;
    let textEmptyDropCount = 0;
    let rerankerErrorCount = 0;

    const writeCandidateEvent = (
      result: MemorySearchResult,
      outcome: string,
      rerankerVerdict: string | undefined,
      rejectReason: string | undefined,
    ): void => {
      const meta = candidateMetaById.get(result.entry.id);
      const viaHook = hookSet.has(result.entry.id);
      const hookKeyword = undefined; // keyword lives in hook_triggered / hook_crag_retained events
      const recordSubsystemEffectiveness = (this.store as any).recordSubsystemEffectiveness;
      if (typeof recordSubsystemEffectiveness !== "function") return;
      void recordSubsystemEffectiveness.call(this.store, {
        subsystem: "retrieval",
        event: "crag_filter",
        outcome,
        entityId: result.entry.id,
        relatedId: "",
        queryHash,
        score: meta?.score ?? 0,
        count: 1,
        durationMs: 0,
        metadata: {
          candidateRank: meta?.rank ?? -1,
          candidateScore: meta?.score ?? 0,
          cragVipDist: CRAG_VIP_DIST,
          cragDistYes: CRAG_DIST_YES,
          cragDistNo: CRAG_DIST_NO,
          qwenDist: (result as any).__qwenDist,
          rerankerVerdict,
          rejectReason,
          viaHook,
          hookKeyword,
        },
      }).catch((err: any) => {
        console.warn("[PR-E8] crag candidate event failed:", err?.message ?? err);
      });
    };

    // ── Embed the query once (query mode); CRAG scores every candidate by Qwen
    //    cosine distance to its stored ('store'-mode) vector. See ticket §"Key
    //    enabler". null queryVector (embed outage) → degrade to pass-through. ──
    let queryVector: number[] | null = null;
    try {
      const v = await this.embedder.embed(query, "query");
      queryVector = Array.isArray(v) && v.length > 0 ? v : null;
    } catch (err) {
      console.warn("[CRAG] query embed failed; CRAG runs in pass-through:", (err as any)?.message ?? err);
    }
    // qwenDist: +Infinity when uncomputable (missing vector / no queryVector) so a
    // candidate is never silently dropped — it routes to the "partial" path.
    const qwenDist = (result: MemorySearchResult): number =>
      queryVector ? cosineDistance(queryVector, (result.entry as any).vector) : Number.POSITIVE_INFINITY;

    const vipMemories: MemorySearchResult[] = [];
    const reviewMemories: MemorySearchResult[] = [];

    for (const result of results) {
      if (result.entry.id.startsWith("init_")) continue;
      const dist = qwenDist(result);
      (result as any).__qwenDist = dist;
      // VIP = unambiguously close in Qwen space. Distance-confirmed only; no
      // top-rank auto-pass (finalScore blends importance/health, not pure vector).
      if (queryVector && dist <= CRAG_VIP_DIST) {
        vipMemories.push(result);
      } else {
        reviewMemories.push(result);
      }
    }


    const filteredResults: MemorySearchResult[] = [];
    /** 存放 partial 記憶，等待 Entity Synergy Merge */
    const partialMemories: MemorySearchResult[] = [];

    for (const result of vipMemories) {
      const processedText = this.filterHooks(result.entry.text);
      if (enableHebbian) this.enqueueBoostHealth(result.entry.id);

      if (processedText.trim()) {
        filteredResults.push({ ...result, entry: { ...result.entry, text: processedText } });
        vipCount += 1;
        writeCandidateEvent(result, "vip_pass", undefined, undefined);
      } else {
        textEmptyDropCount += 1;
        writeCandidateEvent(result, "text_empty_drop", undefined, "text_empty");
      }
    }

    for (const result of reviewMemories) {
      try {
        // Qwen-cosine verdict on the distance computed at the VIP split. An
        // uncomputable distance (embed outage / missing vector) keeps the
        // candidate, mirroring the old reranker error-path — never a silent drop.
        const d = (result as any).__qwenDist as number;
        const viaHook = hookSet.has(result.entry.id);
        // Hook candidates: stricter keep, and NEVER auto-keep an uncomputable distance
        // (no partial-merge rescue either — a bypass-recall hook must earn its place by
        // real vector relevance or be dropped).
        const relevance: "yes" | "no" | "partial" = viaHook
          ? (!Number.isFinite(d) ? "no" : d <= HOOK_CRAG_DIST_YES ? "yes" : "no")
          : (!Number.isFinite(d) ? "yes"
            : d <= CRAG_DIST_YES ? "yes"
            : d >= CRAG_DIST_NO ? "no"
            : "partial");
        const evaluation = { relevance };

        let processedText = result.entry.text;

        if (evaluation.relevance === "no") {
          rerankNoCount += 1;
          writeCandidateEvent(result, "rerank_no", "no", "reranker_no");
          continue;
        } else if (evaluation.relevance === "partial") {
          processedText = this.filterHooks(result.entry.text);
          // ── 收集 partial，嘗試合併搶救 ──
          partialMemories.push({ ...result, entry: { ...result.entry, text: processedText } });
          if (enableHebbian) this.enqueueBoostHealth(result.entry.id);
          continue;
        } else {
          processedText = this.filterHooks(result.entry.text);
        }

        if (enableHebbian && evaluation.relevance === "yes") {
          this.enqueueBoostHealth(result.entry.id);
        }

        if (processedText.trim()) {
          filteredResults.push({ ...result, entry: { ...result.entry, text: processedText } });
          if (evaluation.relevance === "yes") {
            rerankYesCount += 1;
            writeCandidateEvent(result, "rerank_yes", "yes", undefined);
          }
        } else if (evaluation.relevance === "yes") {
          textEmptyDropCount += 1;
          writeCandidateEvent(result, "text_empty_drop", "yes", "text_empty");
        }
      } catch (err) {
        console.error(`[CRAG] Evaluation failed ${result.entry.id}:`, err);
        filteredResults.push(result);
        rerankerErrorCount += 1;
        writeCandidateEvent(result, "reranker_error", undefined, undefined);
      }
    }

    // ── Entity Synergy Merge：搶救 partial 記憶 ──
    if (partialMemories.length >= 2) {
      const mergedCountBefore = partialMemories.length;
      const synergyMerged = await this.trySynergyMerge(query, partialMemories, enableHebbian, queryVector);
      for (const merged of synergyMerged) {
        filteredResults.push(merged);
      }
      const survivorIds = new Set(synergyMerged.map((result) => result.entry.id));
      for (const partial of partialMemories) {
        if (survivorIds.has(partial.entry.id)) {
          partialMergedCount += 1;
          writeCandidateEvent(partial, "partial_merged", "partial", undefined);
        } else {
          partialDroppedCount += 1;
          writeCandidateEvent(partial, "partial_dropped", "partial", "partial_dropped");
        }
      }
      console.log(`[CRAG] Synergy merge: ${mergedCountBefore} partial -> ${synergyMerged.length} promoted to result pool`);
    } else {
      for (const partial of partialMemories) {
        partialDroppedCount += 1;
        writeCandidateEvent(partial, "partial_dropped", "partial", "partial_dropped");
      }
    }

    const survivorsTotal = filteredResults.length;
    const hooksSurvivedTotal = filteredResults.reduce(
      (acc, result) => acc + (hookSet.has(result.entry.id) ? 1 : 0),
      0,
    );
    const recordSubsystemEffectiveness = (this.store as any).recordSubsystemEffectiveness;
    if (typeof recordSubsystemEffectiveness === "function") {
      void recordSubsystemEffectiveness.call(this.store, {
        subsystem: "retrieval",
        event: "crag_summary",
        outcome: "completed",
        entityId: "",
        relatedId: "",
        queryHash,
        score: 0,
        count: 1,
        durationMs: 0,
        metadata: {
          candidatesTotal: results.length,
          vipCount,
          rerankYesCount,
          rerankNoCount,
          partialMergedCount,
          partialDroppedCount,
          textEmptyDropCount,
          rerankerErrorCount,
          survivorsTotal,
          hooksTotal,
          hooksSurvivedTotal,
        },
      }).catch((err: any) => {
        console.warn("[PR-E8] crag summary event failed:", err?.message ?? err);
      });
    }

    console.log(`[CRAG] ${results.length} -> ${filteredResults.length} results (VIP ${vipMemories.length}, review ${reviewMemories.length}, partial=${partialMemories.length})`);
    if (isCragCrossEncoderGateEnabled()) {
      const gated = await applyCragCrossEncoderGate(query, filteredResults, {
        cacheDir: this.rerankerCacheDir,
        logger: console,
      });
      console.log(`[CRAG] cross-encoder gate ${filteredResults.length} -> ${gated.length} results`);
      return gated;
    }
    return filteredResults;
  }

  /**
   * Entity Synergy Merge 實作
   *
   * 對所有 partial 記憶：
   *  1. 兩兩抽取實體，計算 entity overlap
   *  2. overlap 超過門檻的記憶對 → 合併文字
   *  3. 合併後用 MiniLM 重新評估 relevancy
   *  4. 通過的升級進結果池
   */
  private async trySynergyMerge(
    query: string,
    partialMemories: MemorySearchResult[],
    enableHebbian: boolean,
    queryVector: number[] | null,
    overlapThreshold = 0.08,  // IDF-weighted Jaccard 超過此值視為可合併
  ): Promise<MemorySearchResult[]> {
    const merged: MemorySearchResult[] = [];
    const usedIds = new Set<string>();

    // 預先抽取所有 partial 的實體
    const entityMap = new Map<string, Map<string, Set<string>>>();
    for (const result of partialMemories) {
      entityMap.set(result.entry.id, EntitySynergyMerger.extractEntities(result.entry.text));
    }

    // 貪心配對：O(n²) 但 n 通常很小（partial 記憶通常 < 10 筆）
    for (let i = 0; i < partialMemories.length; i++) {
      const memA = partialMemories[i];
      if (usedIds.has(memA.entry.id)) continue;

      const entitiesA = entityMap.get(memA.entry.id)!;

      let bestPartner: MemorySearchResult | null = null;
      let bestOverlap = 0;

      for (let j = i + 1; j < partialMemories.length; j++) {
        const memB = partialMemories[j];
        if (usedIds.has(memB.entry.id)) continue;

        const entitiesB = entityMap.get(memB.entry.id)!;
        const overlap = EntitySynergyMerger.computeOverlap(entitiesA, entitiesB);

        if (overlap > bestOverlap && overlap >= overlapThreshold) {
          bestOverlap = overlap;
          bestPartner = memB;
        }
      }

      if (bestPartner) {
        usedIds.add(memA.entry.id);
        usedIds.add(bestPartner.entry.id);

        // 合併文字
        const mergedText = EntitySynergyMerger.mergeMemories(
          [memA.entry.text, bestPartner.entry.text],
          query
        );

        // Qwen 重新評估：合併後文字屬「記憶」→ 'store' 模式 embed,與 query 算 cosine。
        try {
          const mergedVector = queryVector ? await this.embedder.embed(mergedText, "store") : null;
          const reEvalDist = cosineDistance(queryVector, mergedVector);
          const reEval = { relevance: reEvalDist <= CRAG_DIST_YES ? "yes" : "no" };

          if (reEval.relevance === "yes") {
            // 升級：用較高分數的 entry 為基底，置換 text
            const base = (memA as any).finalScore >= (bestPartner as any).finalScore ? memA : bestPartner;
            const boostedScore = ((base as any).finalScore || 0) * 1.05; // 輕微加分（合併獎勵）

            if (enableHebbian) {
              this.enqueueBoostHealth(memA.entry.id);
              this.enqueueBoostHealth(bestPartner.entry.id);
            }

            merged.push({
              ...base,
              entry: { ...base.entry, text: mergedText },
              fusedScore: boostedScore,
              finalScore: boostedScore,
            } as MemorySearchResult);

            console.log(`[SynergyMerge] Merged ${memA.entry.id.slice(0,8)} + ${bestPartner.entry.id.slice(0,8)} -> overlap=${bestOverlap.toFixed(3)}`);
          } else {
            console.log(`[SynergyMerge] Merge failed (re-eval=${reEval.relevance}): ${memA.entry.id.slice(0,8)} + ${bestPartner.entry.id.slice(0,8)}`);
          }
        } catch (err) {
          console.warn(`[SynergyMerge] Re-evaluation failed:`, err);
        }
        } else {
        // 沒有可合併的夥伴，但仍是 partial → 保守保留（原始 partial 會被丟掉，這裡補救）
        // 但 partial 已在 cragEvaluate 被 drop 了...所以乾脆在這裡補一筆不重評的
        // 這樣至少能進入結果池
        console.log(`[SynergyMerge] Partial memory has no partner: ${memA.entry.id.slice(0,8)}`);
        
        // 🛠️ 補上這行！把孤獨的 partial 記憶救回來！
        merged.push(memA as MemorySearchResult); 
      }
    }

    return merged;
  }

  private filterHooks(text: string): string {
    const filtered = text.replace(/#[a-zA-Z0-9\u4e00-\u9fa5]+/g, "").trim();
    return filtered.replace(/\s+/g, " ").trim();
  }
}
