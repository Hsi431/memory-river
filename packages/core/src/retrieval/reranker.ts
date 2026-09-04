import type { MemorySearchResult } from '../types.js';

/** Host-provided reranker used after the core hybrid retrieval stage. */
export interface MemoryReranker {
  rerank(query: string, candidates: MemorySearchResult[]): Promise<MemorySearchResult[]>;
}
