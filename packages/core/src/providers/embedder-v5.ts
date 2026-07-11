/**
 * Embedder v5 - Qwen3-Embedding via Ollama (Instruction-Aware)
 * memory-river v5
 *
 * [鐵律] 使用 Ollama 本地部署 Qwen3-Embedding-0.6B
 * 向量維度：1024（與 Gemini 3072維 不相容，強制使用獨立的 lancedb-v5-qwen）
 *
 * Instruction-Aware 前輟綁定：
 * - 寫入：瑪「Summarize this memory concisely:」
 * - 讀取：「Retrieve similar memory records from Memory River knowledge base:」
 */

import type { PluginConfig } from "../types.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ── Ollama 全域並發限制（防止大量並發打垮 Ollama）───────────────────────────
class Semaphore {
  private count: number;
  private queue: Array<() => void> = [];
  constructor(limit: number) { this.count = limit; }
  async acquire(): Promise<void> {
    if (this.count > 0) { this.count--; return; }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }
  release(): void {
    if (this.queue.length > 0) { this.queue.shift()!(); }
    else { this.count++; }
  }
}
const ollamaSemaphore = new Semaphore(4); // 最多 4 路並發

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

export class Embedder {
  private ollamaUrl: string;
  private model: string;
  // v4 相容性欄位（v5 不需要 apiKey，但其他模組有型別預期）
  apiKey = "";
  dimensions = 1024;

  constructor(config: PluginConfig["embedding"] & { ollamaUrl: string; embeddingModel?: string }) {
    this.ollamaUrl = config.ollamaUrl;
    // 綁死 Qwen3 Embedding 模型
    this.model = config.embeddingModel || "hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF";
  }

  /**
   * 單筆查詢向量化（Instruction-Aware）
   * @param text 原始查詢文字
   * @param mode 'store' → "Summarize this memory concisely:" | 'query' → "Retrieve similar..."
   * @param retries 重試次數
   */
  async embed(text: string, mode: 'store' | 'query' = 'query', retries = 3): Promise<number[]> {
    const prefix = mode === 'store'
      ? "Summarize this memory concisely:"
      : "Retrieve similar memory records from Memory River knowledge base:";

    await ollamaSemaphore.acquire();
    try {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(`${this.ollamaUrl}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            prompt: `${prefix} ${text}`,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          if (response.status === 503 || response.status === 429) {
            // 模型尚未載入或被限流，等待後重試
            if (attempt < retries) {
              const backoff = attempt * 2000;
              console.warn(`[Embedder-v5] Ollama returned ${response.status}; retrying in ${backoff}ms... (${attempt}/${retries})`);
              await sleep(backoff);
              continue;
            }
          }
          throw new Error(`Ollama embedding failed (${response.status}): ${errText}`);
        }

        const data = await response.json() as any;
        if (!data.embedding || !Array.isArray(data.embedding)) {
          throw new Error(`Invalid Ollama response: missing embedding field`);
        }

        return data.embedding;
      } catch (err: any) {
        if (attempt >= retries) throw err;
        console.warn(`[Embedder-v5] embed() failed (${attempt}/${retries}): ${err.message}`);
        await sleep(attempt * 1000);
      }
    }
    throw new Error("Should not reach here");
    } finally {
      ollamaSemaphore.release();
    }
  }

  /**
   * 批次向量化（寫入時使用，無 Instruction-Aware 前輟）
   * @param texts 字串陣列
   */
  async embedBatch(texts: string[], retries = 3): Promise<number[][]> {
    // Ollama /api/embeddings 只接受單一 prompt 字串，不支援陣列
    // 改用並發多支 embed() 呼叫，並加 concurrency 控制
    const BATCH_CONCURRENCY = 4;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_CONCURRENCY) {
      const chunk = texts.slice(i, i + BATCH_CONCURRENCY);
      const embeddings = await Promise.all(
        chunk.map(text => this.embed(text, 'store', retries))
      );
      results.push(...embeddings);
    }

    return results;
  }

  /** 回報維度 */
  getDimensions(): number {
    return 1024;
  }

  /** 回報模型名 */
  getModel(): string {
    return this.model;
  }

  /** Ping 測試 */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`, { method: "GET" });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ── v4 相容性包裝 ──────────────────────────────────────
  /** embed() 的 Float32Array 版本（v4 相容） */
  async embedText(text: string): Promise<Float32Array> {
    const vec = await this.embed(text);
    return new Float32Array(vec);
  }

  /** embedBatch() 的 Float32Array 版本（v4 相容） */
  async embedTextBatch(texts: string[], _concurrency = 5): Promise<Float32Array[]> {
    const vecs = await this.embedBatch(texts);
    return vecs.map(v => new Float32Array(v));
  }

  /** Ollama 不支援 generate（僅相容性 stub） */
  async generate(prompt: string): Promise<string> {
    throw new Error("[Embedder-v5] generate() 不支援，請使用 Ollama /api/generate 接口");
  }
}
