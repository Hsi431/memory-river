/**
 * Causal - 因果突觸判定
 * memory-lance-v4
 */

import { MemoryStore } from "../store/store-v4.js";
import { Embedder } from "../providers/embedder-v5.js";

export type CausalAction = "UPDATE" | "CAUSAL" | "INDEPENDENT";

export interface CausalResult {
  action: CausalAction;
  parentId: string | null;
  distance?: number;
}

/**
 * ⚠️ 此參數為 Qwen3 1024d 向量空間優化（2026-04 實測預設值）。
 * 更換 embedding 模型（如 OpenAI 1536d、Gemini 3072d）需自行重新校準。
 * 建議值：先用目前設定跑 50 筆 query 觀察 distance 分布，再調參。
 *
 * @example
 * // Qwen3 1024d（預設，Ollama 本地部署）
 * causalEngine: { updateThreshold: 0.25, causalThreshold: 0.40, embeddingModel: "hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF" }
 *
 * // Gemini 3072d（參考範圍，需重新觀察）
 * causalEngine: { updateThreshold: 0.15, causalThreshold: 0.45, embeddingModel: "gemini-embedding-exp-0325" }
 */
export interface CausalEngineConfig {
  /**
   * 標記目前使用的 embedding 模型維度。
   * Qwen3 1024d: 向量更緊密，相似度普遍較高，需較高閾值
   * Gemini 3072d: 向量更稀疏，相似度普遍較低，需較低閾值
   * 預設值：1024
   */
  embeddingDim?: number;

  /**
   * ⚠️ Qwen3 1024d 向量空間優化參數（維度調整後預設值）。
   * UPDATE threshold：低於此值視為同一記憶的更新（覆寫）。
   * 預設值：0.25
   */
  updateThreshold?: number;

  /**
   * ⚠️ Qwen3 1024d 向量空間優化參數（維度調整後預設值）。
   * CAUSAL threshold：低於此值視為因果關聯（建立 parentId 鏈）。
   * 預設值：0.40
   */
  causalThreshold?: number;

  /**
   * ⚠️ Qwen3 1024d 向量空間優化參數。
   * UPDATE 的字面重疊閾值（用於防止 distance 漂移誤判）。
   * 當 distance < updateThreshold 時，需同時滿足字面重疊度 >= 此值，才判定 UPDATE。
   * 預設值：0.30（Jaccard overlap，0=完全無重疊，1=完全相同）
   * ⚠️ 設太高會讓 UPDATE 幾乎失效，建議 0.25~0.35。
   */
  overlapThreshold?: number;

  /**
   * ⚠️ 標記目前使用的 embedding 模型。
   * 更換模型後強烈建議重新校準 updateThreshold / causalThreshold。
   * 預設值："hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF"（Ollama 本地部署 Qwen3 1024d）
   */
  embeddingModel?: string;
}

export class CausalEngine {
  private readonly updateThreshold: number;
  private readonly causalThreshold: number;
  private readonly overlapThreshold: number;
  private readonly embeddingModel: string;
  private readonly embeddingDim: number;

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    config: CausalEngineConfig = {},
  ) {
    // 儲存 embedding 維度（用於動態調整閾值）
    this.embeddingDim = config.embeddingDim ?? 1024;

    // 根據維度動態調整閾值
    // Qwen3 1024d: 維度較低，向量更緊密，相似度普遍較高 → 需較高閾值
    // Gemini 3072d: 維度較高，向量更稀疏，相似度普遍較低 → 需較低閾值
    const isLowDim = this.embeddingDim <= 1280; // 1024d
    const dimAdjustedUpdateThreshold = isLowDim ? 0.28 : 0.20;
    const dimAdjustedCausalThreshold = isLowDim ? 0.32 : 0.23;

    // 從 config 讀取，未提供時使用維度調整後的預設值
    this.updateThreshold = config.updateThreshold ?? dimAdjustedUpdateThreshold;
    this.causalThreshold = config.causalThreshold ?? dimAdjustedCausalThreshold;
    this.overlapThreshold = config.overlapThreshold ?? 0.30;
    this.embeddingModel = config.embeddingModel ?? "hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF";
  }

  /**
   * 判定新記憶與現有記憶的因果關係
   * @param category - 新記憶的類別（可選，用於 Category-aware UPDATE 加速）
   */
  async determineRelation(text: string, excludeId?: string, category?: string): Promise<CausalResult> {
    const vector = await this.embedder.embed(text);

    // 搜尋最相似的記憶 (取前 5 筆就夠了)
    const results = await this.store.vectorSearch(vector, 5);

    // 🛡️ 過濾掉自己，以及系統初始化專用的 init_ 記憶
    const filtered = results.filter(r => {
      const isSelf = excludeId ? r.entry.id === excludeId : false;
      const isInit = r.entry.id.startsWith("init_");
      return !isSelf && !isInit;
    });

    if (filtered.length === 0) {
      return { action: "INDEPENDENT", parentId: null };
    }

    const nearest = filtered[0];

    const distance = nearest.rawDistance;

    // ⚠️ 使用 configurable threshold（Gemini 3072d 預設值：0.15 / 0.45）
    if (distance < this.causalThreshold) {
      // 相似度高，判斷具體關係
      const action = await this.judgeAction(text, nearest.entry.text, distance, category, nearest.entry.category);
      return {
        action,
        parentId: action === "CAUSAL" || action === "UPDATE" ? nearest.entry.id : null,
        distance,
      };
    }

    return { action: "INDEPENDENT", parentId: null, distance };
  }

  /**
   * 判斷具體因果關係（使用精準距離判斷 + 字面重疊二次確認 + Category 感知）
   * ⚠️ threshold 來自 configurable 參數（Qwen3 1024d 預設：0.25 / 0.40）
   *
   * 🛡️ 距離漂移保護：當 distance < updateThreshold 時，
   * 需同時通過字面重疊度檢查（Jaccard >= overlapThreshold）才判定 UPDATE，
   * 否則降級為 CAUSAL，防止語意蒸餾後的向量飄移導致誤覆寫。
   *
   * 🆕 Category 同源加速：相同 category 的記憶，UPDATE 門檻放寬 50%，
   * 且 distance 極低時即使字面重疊不達標也判定 UPDATE。
   */
  private async judgeAction(
    newText: string,
    existingText: string,
    distance: number,
    newCategory?: string,
    existingCategory?: string,
  ): Promise<CausalAction> {
    // 🆕 Category 同源加速：相同 category → UPDATE 門檻放寬 50%
    const sameCategory = !!(newCategory && existingCategory && newCategory === existingCategory);
    const effectiveUpdateThreshold = sameCategory
      ? this.updateThreshold * 1.5
      : this.updateThreshold;

    // ⚠️ 第一分支：UPDATE threshold
    if (distance <= effectiveUpdateThreshold) {
      // 🛡️ 二次確認：distance 通過還不夠，字面也要有足夠重疊
      const overlap = this.computeOverlap(newText, existingText);
      if (overlap >= this.overlapThreshold) {
        return "UPDATE";
      }
      // 🆕 即使字面重疊不夠，同 category 且 distance 極低 → 仍判定 UPDATE
      if (sameCategory && distance < this.updateThreshold * 0.75) {
        return "UPDATE";
      }
      // 重疊度不足，降級為 CAUSAL（不覆寫，只建立關聯）
      return "CAUSAL";
      // ⚠️ 第二分支：CAUSAL threshold
    } else if (distance <= this.causalThreshold) {
      return "CAUSAL";
    } else {
      return "INDEPENDENT";
    }
  }

  /**
   * 計算兩段文字的字面重疊度（Jaccard similarity）
   * - 統一小寫、移除停用詞、比較 word-level set
   * - lightweight，無需額外依賴
   */
  private computeOverlap(textA: string, textB: string): number {
    const STOP_WORDS = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "must", "can", "to", "of", "in", "for",
      "on", "with", "at", "by", "from", "as", "into", "through", "during",
      "and", "or", "but", "if", "then", "so", "than", "that", "this",
      "it", "its", "i", "you", "he", "she", "we", "they", "what", "which",
      "who", "whom", "whose", "where", "when", "why", "how",
    ]);

    const normalize = (t: string) =>
      t.toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 1 && !STOP_WORDS.has(w));

    const setA = new Set(normalize(textA));
    const setB = new Set(normalize(textB));

    if (setA.size === 0 || setB.size === 0) return 0;

    // Jaccard = |A ∩ B| / |A ∪ B|
    let intersection = 0;
    for (const w of setA) {
      if (setB.has(w)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /**
   * 回傳目前 embedding 模型建議的 threshold 組。
   * 閾值會根據 embeddingDim 動態調整：
   * - Qwen3 1024d（低維）：updateThreshold=0.28, causalThreshold=0.32
   * - Gemini 3072d（高維）：updateThreshold=0.20, causalThreshold=0.23
   */
  getRecommendedThresholds(): {
    updateThreshold: number;
    causalThreshold: number;
    overlapThreshold: number;
    embeddingDim: number;
    note: string;
  } {
    const isLowDim = this.embeddingDim <= 1280;
    return {
      updateThreshold: isLowDim ? 0.28 : 0.20,
      causalThreshold: isLowDim ? 0.32 : 0.23,
      overlapThreshold: 0.30,
      embeddingDim: this.embeddingDim,
      note: isLowDim
        ? "Qwen3 1024d optimized (dense vectors, higher similarity)"
        : "Gemini 3072d optimized (sparse vectors, lower similarity)",
    };
  }
}
