/**
 * Golden-task evaluation through the real harness and the real model, each task in a throwaway
 * sandbox. Run it when the model, the prompt or a lens changes — not on every commit (it makes
 * real model calls: tasks × trials turns).
 *
 *   npm run eval:tasks                         # evals/tasks.json, 3 trials each, pass^3
 *   npm run eval:tasks -- --trials 5 --k 3
 *   npm run eval:tasks -- --only empty-reply   # one task
 *   npm run eval:tasks -- --model <bedrock model id>
 *
 * Results are written to workspace/evals/results/tasks-<timestamp>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTaskSet, runTaskEval } from "../src/evals/index.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const stateDir = process.env.ALIL_STATE_DIR ?? "workspace";
const set = loadTaskSet(flag("--set") ?? "evals/tasks.json");
const only = flag("--only");
if (only) set.cases = set.cases.filter((c) => c.id === only);
const trials = Number(flag("--trials") ?? 3);
const k = Number(flag("--k") ?? trials);
const modelId = flag("--model") ?? process.env.BEDROCK_MODEL_ID ?? "global.anthropic.claude-sonnet-5";

console.log(`golden tasks · ${set.name} · ${set.cases.length} task(s) × ${trials} trial(s) · ${modelId}\n`);
const report = await runTaskEval(set, {
  modelId, trials, k,
  onTrial: (task, i, r) => console.log(`  ${r.pass ? "✓" : "✗"} ${task} #${i}  ${r.stopReason} · ${r.iterations} iters · ${(r.durationMs / 1000).toFixed(1)}s · $${r.costUsd.toFixed(4)}${r.failed.length ? `  — failed: ${r.failed.join("; ")}` : ""}`),
});

console.log(`\n${"task".padEnd(26)} pass^1  pass^${report.k}`);
for (const t of report.tasks) console.log(`${t.id.padEnd(26)} ${t.pass1.toFixed(2)}    ${Number.isNaN(t.passHatK) ? "  —" : t.passHatK.toFixed(2)}`);
console.log(`${"overall".padEnd(26)} ${report.pass1.toFixed(2)}    ${report.passHatK.toFixed(2)}`);

const outDir = join(stateDir, "evals", "results");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `tasks-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nsaved ${out}`);
