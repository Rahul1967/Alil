/**
 * Fit the newest conversation lines into a token budget. A fixed row count lets context size swing
 * with message length — 40 short lines are tiny, 40 pasted documents overflow — so the window is
 * bounded by an estimated token cost instead, with a row ceiling as a backstop.
 *
 * Newest lines are kept first; the newest line is always kept (even alone over budget) so the
 * model never loses the turn it is answering. Pure and provider-agnostic: pass any estimator.
 */
export interface BudgetOptions<T> {
  maxTokens: number;
  /** Hard ceiling on lines regardless of size. */
  maxLines?: number;
  /** Token estimate for one line. Default ≈ chars / 4. */
  estimate?: (line: T) => number;
}

export interface BudgetResult<T> {
  lines: T[];
  tokens: number;
  /** Lines dropped from the old end to fit. */
  dropped: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function fitToTokenBudget<T>(lines: readonly T[], opts: BudgetOptions<T>): BudgetResult<T> {
  const estimate = opts.estimate ?? ((l: T) => estimateTokens(typeof l === "string" ? l : JSON.stringify(l)));
  const maxLines = opts.maxLines ?? Number.POSITIVE_INFINITY;
  const kept: T[] = [];
  let tokens = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const cost = estimate(lines[i]!);
    if (kept.length > 0 && tokens + cost > opts.maxTokens) break;
    kept.push(lines[i]!);
    tokens += cost;
  }
  kept.reverse();
  return { lines: kept, tokens, dropped: lines.length - kept.length };
}
