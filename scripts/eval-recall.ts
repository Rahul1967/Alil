/**
 * Must-recall evaluation over your real memory. Works on a COPY of memory.db (the live file is
 * only read), so it is safe while the channels run.
 *
 *   npm run eval:recall                                  # workspace/evals/recall.json, k=5
 *   npm run eval:recall -- --k 3 --set path/to/set.json
 *   npm run eval:recall -- --summaries extractive        # also re-distill the copy offline and compare
 *
 * Scores episode search three ways on the same copy — hybrid (BM25 + vectors, what runs today),
 * lexical (FTS5/BM25 only) and vector (hashing vectors only) — so you can see what each ranker
 * contributes. With --summaries extractive it adds a fourth run in which every episode was re-
 * summarized by the offline ExtractiveSummarizer, to compare against the LLM summaries.
 *
 * Results are written to workspace/evals/results/recall-<timestamp>.json.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, ExtractiveSummarizer } from "../src/memory/index.ts";
import type { RetrievalMode } from "../src/memory/index.ts";
import { loadRecallSet, runRecallEval } from "../src/evals/index.ts";
import type { RecallReport } from "../src/evals/index.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const stateDir = process.env.ALIL_STATE_DIR ?? "workspace";
const dbPath = flag("--db") ?? process.env.ALIL_DB ?? join(stateDir, "memory.db");
const setPath = flag("--set") ?? join(stateDir, "evals", "recall.json");
const k = Number(flag("--k") ?? 5);
const summaries = flag("--summaries");

if (!existsSync(setPath)) {
  console.error(`No recall set at ${setPath}. Copy evals/examples/recall.example.json there and label it with your own episode ids.`);
  process.exit(1);
}
const set = loadRecallSet(setPath);

function copyDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "alil-eval-recall-"));
  const to = join(dir, "memory.db");
  copyFileSync(dbPath, to);
  for (const ext of ["-wal", "-shm"]) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, to + ext);
  return to;
}

const runs: Array<{ name: string; report: RecallReport }> = [];
for (const mode of ["hybrid", "lexical", "vector"] as RetrievalMode[]) {
  const mem = openMemory({ path: copyDb(), retrieval: mode });
  runs.push({ name: `${mode} · current summaries`, report: await runRecallEval(mem.store, set, k) });
  mem.close();
}

if (summaries === "extractive") {
  const path = copyDb();
  const mem = openMemory({ path });
  const summarizer = new ExtractiveSummarizer();
  const rows = mem.db.prepare("SELECT id, start_seq, end_seq, started_at, ended_at FROM episodes WHERE end_seq IS NOT NULL").all() as Array<{ id: string; start_seq: number; end_seq: number; started_at: string; ended_at: string | null }>;
  for (const r of rows) {
    const lines = mem.timeline.range(r.start_seq, r.end_seq);
    const out = await summarizer.summarize(lines);
    await mem.store.index({ id: r.id, startSeq: r.start_seq, endSeq: r.end_seq, startedAt: r.started_at, ...(r.ended_at ? { endedAt: r.ended_at } : {}), summary: out.summary, salientFacts: out.salientFacts }, lines);
  }
  mem.close();
  const again = openMemory({ path, retrieval: "hybrid" });
  runs.push({ name: "hybrid · extractive summaries", report: await runRecallEval(again.store, set, k) });
  again.close();
}

const f = (x: number) => x.toFixed(2);
console.log(`must-recall · ${set.name} · ${set.cases.length} cases · k=${k} · db ${dbPath} (copied)\n`);
console.log(`${"run".padEnd(34)} ${"n".padStart(3)}  recall@k   MRR   hit@k  nDCG@k`);
for (const r of runs) {
  const o = r.report.overall;
  console.log(`${r.name.padEnd(34)} ${String(o.n).padStart(3)}    ${f(o.recallAtK)}    ${f(o.mrr)}   ${f(o.hitAtK)}   ${f(o.ndcgAtK)}`);
}
const base = runs[0]!.report;
console.log(`\nby category (${runs[0]!.name}):`);
for (const [cat, s] of Object.entries(base.byCategory)) console.log(`  ${cat.padEnd(14)} n=${s!.n}  recall@k ${f(s!.recallAtK)}  MRR ${f(s!.mrr)}`);
const missed = base.cases.filter((c) => c.hit === 0);
if (missed.length) {
  console.log(`\nmissed in the top ${k} (${runs[0]!.name}):`);
  for (const c of missed) console.log(`  ${c.id.padEnd(22)} ${set.cases.find((x) => x.id === c.id)!.query}`);
}

const outDir = join(stateDir, "evals", "results");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `recall-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ set: set.name, k, db: dbPath, at: new Date().toISOString(), runs }, null, 2));
console.log(`\nsaved ${out}`);
