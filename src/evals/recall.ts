import { readFileSync } from "node:fs";
import type { MemoryStore } from "../memory/types.ts";
import { recallAtK, reciprocalRank, hitAtK, ndcgAtK, precisionAtK, mean } from "./metrics.ts";

/**
 * Must-recall evaluation: does episode search find the episode that holds a fact the operator
 * expects Alil to remember? Labels are ids (episode ids), so scoring is deterministic — no judge
 * model. Categories follow LongMemEval's abilities, adapted: a single fact, facts spread across
 * sessions, time-anchored facts, facts that were later superseded (the NEWER episode is expected),
 * and unanswerable questions (no episode should be needed; reported separately, not scored as
 * retrieval).
 */
export type RecallCategory = "single" | "multi-session" | "temporal" | "superseded" | "unanswerable";

export interface RecallCase {
  id: string;
  query: string;
  category: RecallCategory;
  /** Episode ids that contain the answer. Empty for `unanswerable`. */
  expect: string[];
  note?: string;
}

export interface RecallSet {
  name: string;
  /** Free text: where the labels came from and when. */
  about?: string;
  cases: RecallCase[];
}

export function loadRecallSet(path: string): RecallSet {
  const set = JSON.parse(readFileSync(path, "utf8")) as RecallSet;
  if (!Array.isArray(set.cases)) throw new Error(`${path}: expected { cases: [...] }`);
  for (const c of set.cases) {
    if (!c.id || !c.query || !Array.isArray(c.expect)) throw new Error(`${path}: case ${JSON.stringify(c.id)} needs id, query, expect[]`);
    if (c.category !== "unanswerable" && c.expect.length === 0) throw new Error(`${path}: case ${c.id} expects nothing but is not 'unanswerable'`);
  }
  return set;
}

export interface CaseResult {
  id: string;
  category: RecallCategory;
  ranked: string[];
  recallAtK: number;
  rr: number;
  hit: number;
  ndcg: number;
  precision: number;
}

export interface Scores {
  n: number;
  recallAtK: number;
  mrr: number;
  hitAtK: number;
  ndcgAtK: number;
  precisionAtK: number;
}

export interface RecallReport {
  k: number;
  overall: Scores;
  byCategory: Partial<Record<RecallCategory, Scores>>;
  cases: CaseResult[];
  /** Unanswerable cases with what search returned (for answer-level review). */
  unanswerable: Array<{ id: string; ranked: string[] }>;
}

function scores(rs: CaseResult[]): Scores {
  return {
    n: rs.length,
    recallAtK: mean(rs.map((r) => r.recallAtK)),
    mrr: mean(rs.map((r) => r.rr)),
    hitAtK: mean(rs.map((r) => r.hit)),
    ndcgAtK: mean(rs.map((r) => r.ndcg)),
    precisionAtK: mean(rs.map((r) => r.precision)),
  };
}

export async function runRecallEval(store: Pick<MemoryStore, "searchEpisodes">, set: RecallSet, k = 5): Promise<RecallReport> {
  const cases: CaseResult[] = [];
  const unanswerable: RecallReport["unanswerable"] = [];
  for (const c of set.cases) {
    const ranked = (await store.searchEpisodes(c.query, k)).map((h) => h.episodeId);
    if (c.category === "unanswerable") { unanswerable.push({ id: c.id, ranked }); continue; }
    const rel = new Set(c.expect);
    cases.push({
      id: c.id, category: c.category, ranked,
      recallAtK: recallAtK(ranked, rel, k), rr: reciprocalRank(ranked, rel), hit: hitAtK(ranked, rel, k),
      ndcg: ndcgAtK(ranked, rel, k), precision: precisionAtK(ranked, rel, k),
    });
  }
  const byCategory: RecallReport["byCategory"] = {};
  for (const cat of [...new Set(cases.map((c) => c.category))]) byCategory[cat] = scores(cases.filter((c) => c.category === cat));
  return { k, overall: scores(cases), byCategory, cases, unanswerable };
}
