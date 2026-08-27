import { test } from "node:test";
import assert from "node:assert/strict";

import { SubagentRunner, ScopedActionSink } from "../src/runtime/subagent.ts";
import { SubagentNodeExecutor } from "../src/runtime/subagent-node-executor.ts";
import { PlanRunner } from "../src/runtime/plan-runner.ts";
import { Planner } from "../src/runtime/planner.ts";
import type { ActionSink, ProposedAction, ToolCatalogPort } from "../src/runtime/types.ts";
import type { ToolResult, ActionContract } from "../src/core/types.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import type { ModelResponse } from "../src/providers/types.ts";

function toolResp(id: string, tool: string, args: Record<string, unknown> = {}): ModelResponse {
  return { toolCalls: [{ id, tool, args }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
}
function endResp(): ModelResponse {
  return { text: "done", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
}
function action(tool: string): ProposedAction {
  return { action: { id: "x", tool, args: {}, effect: "read", reversible: true, risk: "low", classified: true, provenance: { origin: "model" } } as ActionContract };
}
/** A parent boundary that records what actually reached it and always allows. */
function recordingBoundary(): { sink: ActionSink; reached: string[] } {
  const reached: string[] = [];
  const sink: ActionSink = { async submit(a) { reached.push(a.action.tool); return { actionId: a.action.id, outcome: "ok", summary: "ok" } as ToolResult; } };
  return { sink, reached };
}
const catalog: ToolCatalogPort = {
  async list() {
    return ["fs.read", "fs.write", "web.fetch", "shell"].map((name) => ({ name, description: name, parameters: {} }));
  },
};

// ─── ScopedActionSink: structural non-inheritance ───
test("ScopedActionSink denies out-of-grant tools before the boundary", async () => {
  const { sink, reached } = recordingBoundary();
  const scoped = new ScopedActionSink(sink, ["fs.read"]);
  const ok = await scoped.submit(action("fs.read"));
  const no = await scoped.submit(action("shell"));
  assert.equal(ok.outcome, "ok");
  assert.equal(no.outcome, "denied");
  assert.match(no.summary, /not in this subagent's grant/);
  assert.deepEqual(reached, ["fs.read"], "the denied tool never reached the real boundary");
});

// ─── SubagentRunner: grant must be a subset of the parent's tools ───
test("subagent grant exceeding parent tools is rejected", async () => {
  const mock = new MockProvider();
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const { sink } = recordingBoundary();
  const runner = new SubagentRunner({ registry, modelId: "mock-model", catalog, boundary: sink });
  await assert.rejects(() => runner.run({ goal: "g", tools: ["fs.read", "rm.rf"] }), /exceeds parent tools/);
});

test("a subagent can only call tools within its grant, even if the model tries others", async () => {
  // The subagent's model tries fs.read (granted) then shell (NOT granted).
  const mock = new MockProvider().script(
    toolResp("t1", "fs.read"),
    toolResp("t2", "shell"),
    endResp(),
  );
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const { sink, reached } = recordingBoundary();
  const runner = new SubagentRunner({ registry, modelId: "mock-model", catalog, boundary: sink });
  const turn = await runner.run({ goal: "read a file", tools: ["fs.read"] });
  assert.deepEqual(reached, ["fs.read"], "shell never reached the boundary");
  assert.equal(turn.results.some((r) => r.outcome === "denied"), true, "the out-of-grant shell call was denied");
});

test("subagent is advertised only its granted tools", async () => {
  const mock = new MockProvider().script(endResp());
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const { sink } = recordingBoundary();
  const runner = new SubagentRunner({ registry, modelId: "mock-model", catalog, boundary: sink });
  await runner.run({ goal: "g", tools: ["fs.read", "web.fetch"] });
  const advertised = (mock.received[0]?.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(advertised, ["fs.read", "web.fetch"]);
});

// ─── runMany: bounded concurrency ───
test("runMany runs subagents and returns index-aligned results", async () => {
  const mock = new MockProvider().script(endResp(), endResp(), endResp());
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const { sink } = recordingBoundary();
  const runner = new SubagentRunner({ registry, modelId: "mock-model", catalog, boundary: sink, maxConcurrency: 2 });
  const turns = await runner.runMany([
    { goal: "a", tools: ["fs.read"] },
    { goal: "b", tools: ["fs.read"] },
    { goal: "c", tools: ["fs.read"] },
  ]);
  assert.equal(turns.length, 3);
  assert.ok(turns.every((t) => t.stopReason === "complete"));
});

// ─── PlanRunner parallel execution of independent nodes ───
test("PlanRunner runs independent ready nodes concurrently (maxParallel>1)", async () => {
  const planner = new Planner("mock-model", new ProviderRegistry()
    .register(new MockProvider().script({ text: '[{"id":"a","description":"A","deps":[]},{"id":"b","description":"B","deps":[]}]', toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } }))
    .registerModel(mockSpec));
  let concurrent = 0, peak = 0;
  const executor = {
    async execute() {
      concurrent++; peak = Math.max(peak, concurrent);
      await new Promise((r) => setImmediate(r));
      concurrent--;
      return { ok: true, summary: "ok" };
    },
  };
  const result = await new PlanRunner({ planner, executor, limits: { maxReplans: 0, maxNodes: 20, maxParallel: 2 } }).run("two independent steps");
  assert.equal(result.status, "done");
  assert.equal(peak, 2, "both independent nodes ran at the same time");
});

// ─── SubagentNodeExecutor: node runs in its scoped lane ───
test("SubagentNodeExecutor confines a node to its tool grant", async () => {
  // node model tries shell (not granted) → node fails
  const mock = new MockProvider().script(toolResp("t1", "shell"), endResp());
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const { sink, reached } = recordingBoundary();
  const runner = new SubagentRunner({ registry, modelId: "mock-model", catalog, boundary: sink });
  const nodeExec = new SubagentNodeExecutor(runner, { tools: ["fs.read"] });
  const outcome = await nodeExec.execute({ id: "n1", description: "do it", deps: [], status: "pending" }, "goal");
  assert.equal(outcome.ok, false); // the denied shell call failed the node
  assert.deepEqual(reached, [], "nothing out-of-grant reached the boundary");
});
