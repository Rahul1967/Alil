import { test } from "node:test";
import assert from "node:assert/strict";

import { parseNodes, PlanError, Planner } from "../src/runtime/planner.ts";
import { PlanRunner } from "../src/runtime/plan-runner.ts";
import type { NodeExecutor, PlanNode, NodeOutcome } from "../src/runtime/plan-types.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import type { ModelResponse } from "../src/providers/types.ts";
import { WorldStore } from "../src/world/store.ts";

function textResp(text: string): ModelResponse {
  return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
}
function plannerWith(...texts: string[]): Planner {
  const mock = new MockProvider().script(...texts.map(textResp));
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  return new Planner("mock-model", registry);
}

/** Executor that fails a named set of node ids on their first attempt, succeeds otherwise. */
function scriptedExecutor(failIds: Set<string>): { exec: NodeExecutor; order: string[] } {
  const order: string[] = [];
  const exec: NodeExecutor = {
    async execute(node: PlanNode): Promise<NodeOutcome> {
      order.push(node.id);
      if (failIds.has(node.id)) {
        failIds.delete(node.id); // fail once, then let the replanned version pass
        return { ok: false, summary: `boom ${node.id}` };
      }
      return { ok: true, summary: `ok ${node.id}` };
    },
  };
  return { exec, order };
}

// ─── parsing ───
test("parseNodes tolerates code fences and prose, validates shape", () => {
  const nodes = parseNodes('here is the plan:\n```json\n[{"id":"a","description":"do A","deps":[]},{"id":"b","description":"do B","deps":["a"]}]\n```');
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes.map((n) => n.id), ["a", "b"]);
  assert.deepEqual(nodes[1]!.deps, ["a"]);
  assert.equal(nodes[0]!.status, "pending");
});

test("parseNodes drops edges to unknown ids and rejects junk", () => {
  const nodes = parseNodes('[{"id":"a","description":"A","deps":["ghost"]}]');
  assert.deepEqual(nodes[0]!.deps, []); // unknown dep dropped
  assert.throws(() => parseNodes("not json at all"), PlanError);
  assert.throws(() => parseNodes('[{"deps":[]}]'), PlanError); // no description
});

// ─── decomposition + happy-path execution in dependency order ───
test("runner executes a DAG in topological order and finishes done", async () => {
  const planner = plannerWith('[{"id":"a","description":"A","deps":[]},{"id":"b","description":"B","deps":["a"]}]');
  const { exec, order } = scriptedExecutor(new Set());
  const world = new WorldStore({ now: () => 1 });
  const result = await new PlanRunner({ planner, executor: exec, world }).run("build it");
  assert.equal(result.status, "done");
  assert.deepEqual(order, ["a", "b"]); // b waited for a
  // world reflects the finished task
  assert.equal(world.snapshot().tasks[0]!.status, "done");
});

// ─── the flagship behavior: replan on failure instead of halting ───
test("runner REPLANS a failed step and recovers to done", async () => {
  const planner = plannerWith(
    '[{"id":"a","description":"first try","deps":[]}]', // decompose
    '[{"id":"a2","description":"corrected approach","deps":[]}]', // replan output
  );
  const { exec, order } = scriptedExecutor(new Set(["a"])); // node a fails once
  let replanned = 0;
  const result = await new PlanRunner({
    planner, executor: exec,
    observer: { onReplan: () => { replanned++; } },
  }).run("do the thing");
  assert.equal(replanned, 1, "replanned exactly once");
  assert.equal(result.status, "done");
  assert.equal(result.replans, 1);
  assert.deepEqual(order, ["a", "a2"]); // failed a, then ran the replanned a2
});

test("runner ABANDONS cleanly when the replan budget is exhausted", async () => {
  const planner = plannerWith(
    '[{"id":"a","description":"try","deps":[]}]',
    '[{"id":"a","description":"try again","deps":[]}]',
    '[{"id":"a","description":"try yet again","deps":[]}]',
  );
  // always fails
  const exec: NodeExecutor = { async execute(n) { return { ok: false, summary: `fail ${n.id}` }; } };
  const world = new WorldStore({ now: () => 1 });
  const result = await new PlanRunner({ planner, executor: exec, world, limits: { maxReplans: 2, maxNodes: 20 } }).run("impossible");
  assert.equal(result.status, "abandoned");
  assert.equal(result.replans, 2); // used the whole budget, then stopped — did not loop forever
  assert.equal(world.snapshot().tasks[0]!.status, "abandoned");
  assert.match(result.reason ?? "", /fail/);
});

test("plan size is capped at maxNodes", async () => {
  const big = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, description: `step ${i}`, deps: [] })));
  const planner = plannerWith(big);
  const { exec } = scriptedExecutor(new Set());
  const result = await new PlanRunner({ planner, executor: exec, limits: { maxReplans: 0, maxNodes: 5 } }).run("many steps");
  assert.equal(result.nodes.length, 5);
  assert.equal(result.status, "done");
});
