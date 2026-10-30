/**
 * The evaluation harness: retrieval metrics and pass^k are computed correctly, the recall evaluator
 * scores a seeded store per category and can compare rankers, and the task runner grades end state
 * and trajectory over several trials.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openMemory } from "../src/memory/index.ts";
import type { RetrievalMode } from "../src/memory/index.ts";
import {
  precisionAtK, recallAtK, hitAtK, reciprocalRank, ndcgAtK, passAtK, passHatK,
  runRecallEval, runTaskEval,
} from "../src/evals/index.ts";
import type { RecallSet, TaskSet } from "../src/evals/index.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";

const rel = (...ids: string[]) => new Set(ids);

test("retrieval metrics", () => {
  const ranked = ["a", "x", "b", "y"];
  assert.equal(precisionAtK(ranked, rel("a", "b"), 2), 0.5);
  assert.equal(recallAtK(ranked, rel("a", "b"), 2), 0.5);
  assert.equal(recallAtK(ranked, rel("a", "b"), 3), 1);
  assert.equal(hitAtK(ranked, rel("y"), 3), 0);
  assert.equal(reciprocalRank(ranked, rel("b")), 1 / 3);
  assert.equal(reciprocalRank(ranked, rel("z")), 0);
  assert.equal(ndcgAtK(["a", "b"], rel("a", "b"), 2), 1);
  const swapped = ndcgAtK(["x", "a"], rel("a"), 2);
  assert.ok(Math.abs(swapped - 1 / Math.log2(3)) < 1e-12);
});

test("pass@k and pass^k", () => {
  // 4 trials, 2 passed.
  assert.equal(passHatK(4, 2, 1), 0.5);
  assert.equal(passHatK(4, 2, 2), 1 / 6, "C(2,2)/C(4,2)");
  assert.equal(passHatK(4, 4, 3), 1);
  assert.equal(passHatK(4, 0, 1), 0);
  assert.equal(passAtK(4, 2, 2), 1 - 1 / 6, "1 − C(2,2)/C(4,2)");
  assert.ok(Number.isNaN(passHatK(2, 1, 3)), "k > n is undefined");
});

async function seeded(retrieval: RetrievalMode) {
  const mem = openMemory({ path: ":memory:", retrieval });
  const ep = (id: string, summary: string, salientFacts: string[]) =>
    mem.store.index({ id, startSeq: 1, endSeq: 1, startedAt: "2026-10-01T00:00:00.000Z", endedAt: "2026-10-01T01:00:00.000Z", summary, salientFacts }, []);
  await ep("ep_car", "Saved the operator's car to the dossier.", ["The operator drives a Honda City, registration KA01-AB-1234."]);
  await ep("ep_trip_old", "Trip planning: Meghalaya, tentatively the first week of November.", ["Meghalaya trip tentatively early November 2026."]);
  await ep("ep_trip_new", "Trip dates confirmed for Meghalaya: Nov 21–29, leave Nov 23–27.", ["Meghalaya trip is Nov 21–29, 2026."]);
  await ep("ep_loan", "IDFC personal loan EMI ₹19,570 due on the 3rd.", ["IDFC EMI ₹19,570 auto-debits on the 3rd of each month."]);
  return mem;
}

const SET: RecallSet = {
  name: "fixture",
  cases: [
    { id: "car", query: "what car do I drive", category: "single", expect: ["ep_car"] },
    { id: "plate", query: "KA01-AB-1234", category: "single", expect: ["ep_car"] },
    { id: "emi", query: "when does the IDFC EMI get debited", category: "temporal", expect: ["ep_loan"] },
    { id: "trip", query: "final Meghalaya dates", category: "superseded", expect: ["ep_trip_new"] },
    { id: "pet", query: "what is my dog's name", category: "unanswerable", expect: [] },
  ],
};

test("the recall evaluator scores per category and keeps unanswerable cases apart", async () => {
  const r = await runRecallEval((await seeded("hybrid")).store, SET, 3);
  assert.equal(r.overall.n, 4);
  assert.equal(r.unanswerable.length, 1);
  assert.equal(r.byCategory.single!.n, 2);
  assert.equal(r.byCategory.single!.hitAtK, 1, "both car queries find the car episode");
  assert.ok(r.overall.mrr > 0.5);
});

test("the recall evaluator can compare rankers on the same set", async () => {
  const modes: RetrievalMode[] = ["hybrid", "lexical", "vector"];
  const reports = await Promise.all(modes.map(async (m) => [m, await runRecallEval((await seeded(m)).store, SET, 3)] as const));
  for (const [, r] of reports) assert.equal(r.overall.n, 4);
  const lexical = reports.find(([m]) => m === "lexical")![1];
  assert.equal(lexical.cases.find((c) => c.id === "plate")!.hit, 1, "an exact registration number is a lexical match");
});

const TASKS: TaskSet = {
  name: "fixture",
  cases: [{
    id: "read-file",
    turns: ["what does notes.md say?"],
    fixtures: { "notes.md": "the codename is BLUE HERON" },
    graders: [{ type: "tool_called", tool: "fs.read" }, { type: "reply_matches", pattern: "blue heron" }, { type: "stop_reason", value: "complete" }, { type: "max_iterations", value: 4 }],
  }],
};

test("the task runner grades every trial and reports pass^1 and pass^k", async () => {
  const usage = { inputTokens: 1, outputTokens: 1 };
  // Trial 1 reads and answers; trial 2 answers without reading (fails the trajectory check).
  const mock = new MockProvider().script(
    { toolCalls: [{ id: "a", tool: "fs.read", args: { path: "notes.md" } }], stopReason: "tool_use", usage },
    { text: "It says the codename is BLUE HERON.", toolCalls: [], stopReason: "end", usage },
    { text: "Probably BLUE HERON.", toolCalls: [], stopReason: "end", usage },
  );
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const r = await runTaskEval(TASKS, { modelId: "mock-model", registry, trials: 2, k: 2 });
  const t = r.tasks[0]!;
  assert.equal(t.passes, 1);
  assert.equal(t.pass1, 0.5);
  assert.equal(t.passHatK, 0, "not every trial passed");
  assert.equal(t.passAtK, 1);
  assert.deepEqual(t.trials[1]!.failed, ["called fs.read"]);
});
