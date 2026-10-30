/**
 * Evaluation metrics — plain functions, no I/O.
 *
 * Retrieval (one query, a ranked list of ids, the set of relevant ids):
 *   precision@k = |relevant ∩ top-k| / k
 *   recall@k    = |relevant ∩ top-k| / |relevant|
 *   hit@k       = 1 if any relevant id is in the top k, else 0
 *   RR          = 1 / rank of the first relevant id (0 if none)  — averaged over queries ⇒ MRR
 *   nDCG@k      = DCG@k / IDCG@k with binary gains, DCG = Σ rel_i / log2(i + 1)
 *
 * Agent reliability (n trials of one task, c of them passed):
 *   pass@k = 1 − C(n−c, k) / C(n, k)   — at least one of k tries succeeds (capability)
 *   pass^k = C(c, k) / C(n, k)         — all k tries succeed (reliability; τ-bench)
 */
export function precisionAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (k <= 0) return 0;
  return ranked.slice(0, k).filter((id) => relevant.has(id)).length / k;
}

export function recallAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 0;
  return new Set(ranked.slice(0, k).filter((id) => relevant.has(id))).size / relevant.size;
}

export function hitAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  return ranked.slice(0, k).some((id) => relevant.has(id)) ? 1 : 0;
}

export function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number {
  const i = ranked.findIndex((id) => relevant.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
}

export function ndcgAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const seen = new Set<string>();
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => {
    if (relevant.has(id) && !seen.has(id)) { dcg += 1 / Math.log2(i + 2); seen.add(id); }
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Probability at least one of k sampled trials passes, estimated from n trials with c passes. */
export function passAtK(n: number, c: number, k: number): number {
  if (k > n || n === 0) return Number.NaN;
  return 1 - choose(n - c, k) / choose(n, k);
}

/** Probability all k sampled trials pass (τ-bench's pass^k), estimated from n trials with c passes. */
export function passHatK(n: number, c: number, k: number): number {
  if (k > n || n === 0) return Number.NaN;
  return choose(c, k) / choose(n, k);
}

export function mean(xs: readonly number[]): number {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length === 0 ? 0 : v.reduce((s, x) => s + x, 0) / v.length;
}
