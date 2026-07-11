/**
 * CRAG filter metrics (Benchmark — CRAG precision/recall slice).
 *
 * The CRAG reranker is a *filter*: given a query and a candidate pool, it keeps
 * some memories and drops the rest. The retrieval dimension already measures
 * ranking quality; this slice measures filter quality against planted labels.
 *
 * For one query we know, by construction:
 *   - relevantIds   : memories that DO answer the query  (must survive)
 *   - distractorIds : memories that look similar but DON'T (must be dropped)
 *
 * Given a path's top-k output we compute, over the labeled set only (unlabeled
 * filler is ignored):
 *
 *   tp = relevant kept        fn = relevant dropped   (the cost side — CRAG over-filtering)
 *   fp = distractor kept      tn = distractor dropped (the benefit side — noise suppression)
 *
 *   relevantRecall      = tp / (tp + fn)   how much signal survives
 *   distractorRejection = tn / (tn + fp)   how much noise is removed
 *   precision           = tp / (tp + fp)   purity of the kept labeled set
 *   f1                  = harmonic mean of precision and relevantRecall
 *
 * Comparing the `rrf` path (no CRAG) against `rerank` (CRAG) on the same fixture
 * isolates CRAG's contribution: it earns its keep only if it lifts
 * distractorRejection without sinking relevantRecall.
 */

export interface CragConfusion {
  tp: number;
  fn: number;
  fp: number;
  tn: number;
}

export interface CragScore extends CragConfusion {
  relevantRecall: number;
  distractorRejection: number;
  precision: number;
  f1: number;
}

const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0);

/**
 * Build the confusion counts for one query from a path's returned ids.
 * `kept` is the set of memory ids the path surfaced (already top-k sliced).
 * Distractor rejection is scored over ALL planted distractors for the query, so
 * the denominator is stable regardless of whether a distractor reached the pool.
 */
export function cragConfusion(
  kept: Iterable<string>,
  relevant: readonly string[],
  distractor: readonly string[],
): CragConfusion {
  const keptSet = kept instanceof Set ? kept : new Set(kept);
  let tp = 0;
  let fp = 0;
  for (const id of relevant) if (keptSet.has(id)) tp++;
  for (const id of distractor) if (keptSet.has(id)) fp++;
  return {
    tp,
    fn: relevant.length - tp,
    fp,
    tn: distractor.length - fp,
  };
}

export function scoreFromConfusion(c: CragConfusion): CragScore {
  const relevantRecall = ratio(c.tp, c.tp + c.fn);
  const distractorRejection = ratio(c.tn, c.tn + c.fp);
  const precision = ratio(c.tp, c.tp + c.fp);
  const f1 = ratio(2 * precision * relevantRecall, precision + relevantRecall);
  return { ...c, relevantRecall, distractorRejection, precision, f1 };
}

/** Sum per-query confusions, then derive rates from the totals (micro-average). */
export function aggregateConfusions(confusions: readonly CragConfusion[]): CragScore {
  const total = confusions.reduce<CragConfusion>(
    (acc, c) => ({ tp: acc.tp + c.tp, fn: acc.fn + c.fn, fp: acc.fp + c.fp, tn: acc.tn + c.tn }),
    { tp: 0, fn: 0, fp: 0, tn: 0 },
  );
  return scoreFromConfusion(total);
}
