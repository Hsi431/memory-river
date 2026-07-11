/**
 * Real embedder for Benchmark B2 retrieval quality.
 *
 * Unlike the deterministic hash embedder used by B1, retrieval quality requires
 * genuine semantic vectors, so B2 talks to a local Ollama server running the
 * Qwen3-Embedding model (1024-dimensional). This is why B2 is not a CI test: it
 * needs a running Ollama. `ollamaHealthy()` lets the dimension skip cleanly when
 * the server or model is unavailable.
 */

import { Embedder } from '@memory-river/core/providers/embedder-v5';

export const EMBED_MODEL = 'hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF';
export const EMBED_DIM = 1024;

export function ollamaUrl(): string {
  return process.env.OLLAMA_URL ?? 'http://localhost:11434';
}

/** Construct the production Ollama-backed embedder used by the real store. */
export function createRealEmbedder(): Embedder {
  return new Embedder({
    ollamaUrl: ollamaUrl(),
    embeddingModel: process.env.MR_BENCH_EMBED_MODEL ?? EMBED_MODEL,
  } as ConstructorParameters<typeof Embedder>[0]);
}

/** True when Ollama answers and the embedding model is pulled. */
export async function ollamaHealthy(): Promise<boolean> {
  const model = process.env.MR_BENCH_EMBED_MODEL ?? EMBED_MODEL;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const names = (data.models ?? []).map(m => m.name ?? '');
    return names.some(name => name.startsWith(model));
  } catch {
    return false;
  }
}
