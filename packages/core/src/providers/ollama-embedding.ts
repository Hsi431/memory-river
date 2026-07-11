/**
 * OllamaEmbeddingFunction - LanceDB 0.14 compatible embedding function
 * for Qwen3-Embedding via Ollama
 */
import { TextEmbeddingFunction, register } from "@lancedb/lancedb/embedding";
import { Float32 } from "apache-arrow";

const SEMAPHORE_LIMIT = 4;

// ── Semaphore for Ollama concurrency control ────────────────────────────────
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

const ollamaSemaphore = new Semaphore(SEMAPHORE_LIMIT);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Ollama Embedding Function ────────────────────────────────────────────────

@register("ollama")
export class OllamaEmbeddingFunction extends TextEmbeddingFunction {
  private url: string;
  private model: string;
  private _initialized = false;

  constructor(options?: { url?: string; model?: string }) {
    super();
    this.url = options?.url ?? "http://localhost:11434";
    this.model = options?.model ?? "hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF";
  }

  async init(): Promise<void> {
    this._initialized = true;
  }

  ndims(): number {
    return 1024;
  }

  toJSON(): object {
    return {
      url: this.url,
      model: this.model,
    };
  }

  embeddingDataType() {
    // arrow Float32
    return new Float32();
  }

  /**
   * generateEmbeddings — LanceDB calls this for source column (store mode)
   * Uses "Summarize this memory concisely:" prefix
   */
  async generateEmbeddings(data: string[]): Promise<number[][]> {
    await ollamaSemaphore.acquire();
    try {
      const results: number[][] = [];
      for (const text of data) {
        const embedding = await this._embedOne(text, "store");
        results.push(embedding);
      }
      return results;
    } finally {
      ollamaSemaphore.release();
    }
  }

  private async _embedOne(text: string, mode: "store" | "query"): Promise<number[]> {
    const prefix = mode === "store"
      ? "Summarize this memory concisely:"
      : "Retrieve similar memory records from Memory River knowledge base:";

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(`${this.url}/api/embeddings`, {
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
            if (attempt < 3) {
              await sleep(attempt * 2000);
              continue;
            }
          }
          throw new Error(`Ollama ${response.status}: ${errText}`);
        }

        const json = await response.json() as any;
        if (!json.embedding || !Array.isArray(json.embedding)) {
          throw new Error("Missing embedding in response");
        }
        return json.embedding;
      } catch (err) {
        if (attempt >= 3) throw err;
        await sleep(attempt * 1000);
      }
    }
    throw new Error("unreachable");
  }
}
