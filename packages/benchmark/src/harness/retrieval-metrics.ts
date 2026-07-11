/**
 * Retrieval-quality metrics for Benchmark B2.
 *
 * All functions are pure and deterministic: given a ranked list of memory ids
 * and the set of ground-truth relevant ids, they return standard IR metrics.
 * No embedder, store, or LLM is involved here, so this module is CI-safe and
 * unit-tested directly.
 */

export type RelevantSet = ReadonlySet<string>;

/** Recall@k = (relevant ids found in the top k) / (total relevant ids). */
export function recallAtK(ranked: readonly string[], relevant: RelevantSet, k: number): number {
  if (relevant.size === 0) return 0;
  const topK = ranked.slice(0, k);
  let found = 0;
  for (const id of relevant) if (topK.includes(id)) found++;
  return found / relevant.size;
}

/** Reciprocal rank of the first relevant id (0 if none appear). */
export function reciprocalRank(ranked: readonly string[], relevant: RelevantSet): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i]!)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * nDCG@k with binary relevance.
 * DCG = sum_{i<k} rel_i / log2(i + 2); IDCG is the DCG of the ideal ordering
 * (all relevant ids first). Returns 0 when there is no relevant id.
 */
export function ndcgAtK(ranked: readonly string[], relevant: RelevantSet, k: number): number {
  if (relevant.size === 0) return 0;
  let dcg = 0;
  const topK = ranked.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (relevant.has(topK[i]!)) dcg += 1 / Math.log2(i + 2);
  }
  const idealHits = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export interface PerQueryScore {
  'recall@1': number;
  'recall@3': number;
  'recall@5': number;
  mrr: number;
  'ndcg@5': number;
}

/** Score one ranked list against its relevant set across the standard metric set. */
export function scoreQuery(ranked: readonly string[], relevant: RelevantSet): PerQueryScore {
  return {
    'recall@1': recallAtK(ranked, relevant, 1),
    'recall@3': recallAtK(ranked, relevant, 3),
    'recall@5': recallAtK(ranked, relevant, 5),
    mrr: reciprocalRank(ranked, relevant),
    'ndcg@5': ndcgAtK(ranked, relevant, 5),
  };
}

/** Arithmetic mean of each metric across per-query scores. */
export function meanScores(scores: readonly PerQueryScore[]): PerQueryScore {
  const keys: (keyof PerQueryScore)[] = ['recall@1', 'recall@3', 'recall@5', 'mrr', 'ndcg@5'];
  const out = {} as PerQueryScore;
  for (const key of keys) {
    const sum = scores.reduce((acc, s) => acc + s[key], 0);
    out[key] = scores.length > 0 ? sum / scores.length : 0;
  }
  return out;
}
