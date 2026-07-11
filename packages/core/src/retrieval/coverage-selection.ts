function cosineNumber(
  a: Float32Array | number[] | null | undefined,
  b: Float32Array | number[] | null | undefined,
): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const av = Number(a[i]);
    const bv = Number(b[i]);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export function mmrOrder(
  relevance: number[],
  vectors: (Float32Array | number[] | null | undefined)[],
  lambda: number,
): number[] {
  const lo = Math.min(...relevance);
  const hi = Math.max(...relevance);
  const rel = relevance.map(value => (hi > lo ? (value - lo) / (hi - lo) : 0));
  const selected: number[] = [];
  const remaining = new Set(relevance.map((_, index) => index));
  while (remaining.size > 0) {
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const index of remaining) {
      let maxSim = 0;
      for (const chosen of selected) {
        const sim = cosineNumber(vectors[index], vectors[chosen]);
        if (sim > maxSim) maxSim = sim;
      }
      const score = lambda * rel[index] - (1 - lambda) * maxSim;
      if (score > bestScore || (score === bestScore && index < best)) {
        bestScore = score;
        best = index;
      }
    }
    selected.push(best);
    remaining.delete(best);
  }
  return selected;
}

export function isCoverageSelectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MR_COVERAGE_SELECTION === "1";
}

export function coverageLambda(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.MR_COVERAGE_LAMBDA);
  return Number.isFinite(parsed) ? parsed : 0.5;
}
