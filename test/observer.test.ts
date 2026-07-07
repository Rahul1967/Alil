import { test } from "node:test";
import assert from "node:assert/strict";
import { Brain } from "../src/runtime/loop.ts";
import type { BrainPorts } from "../src/runtime/loop.ts";
import { DEFAULT_GUARDS } from "../src/runtime/types.ts";
import type { BrainInput, BrainObserver } from "../src/runtime/types.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import type { ModelResponse } from "../src/providers/types.ts";

function endResponse(text: string): ModelResponse {
  return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 5, outputTokens: 5 } };
}
function toolResponse(id: string, tool: string, args: Record<string, unknown>): ModelResponse {
  return { toolCalls: [{ id, tool, args }], stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 5 } };
}
function op(text: string): BrainInput {
  return { sessionId: "s", message: { text, provenance: { origin: "operator" } }, history: [] };
}

test("observer receives model turn, tool call, tool result in order", async () => {
  const mock = new MockProvider().script(
    toolResponse("t1", "fs.read", { path: "a.md" }),
    endResponse("done"),
  );
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);

  const events: string[] = [];
  const observer: BrainObserver = {
    onModelTurn: (e) => events.push(`model:${e.iteration}:${e.toolCalls}`),
    onToolCall: (e) => events.push(`call:${e.tool}`),
    onToolResult: (e) => events.push(`result:${e.tool}:${e.outcome}`),
    onHalt: (e) => events.push(`halt:${e.kind}`),
  };

  const ports: BrainPorts = {
    memory: { recall: async () => [] },
    skills: { eligible: async () => [] },
    tools: { list: async () => [] },
    prompt: { system: async () => "sys" },
    actions: { submit: async (a) => ({ actionId: a.action.id, outcome: "ok", summary: "read ok" }) },
    observer,
  };

  await new Brain({ modelId: "mock-model", guards: DEFAULT_GUARDS }, registry, ports).run(op("read a.md"));

  assert.deepEqual(events, [
    "model:1:1", // first model turn proposed 1 tool call
    "call:fs.read",
    "result:fs.read:ok",
    "model:2:0", // second turn: final answer, no tools
  ]);
});

test("observer is optional (no-op when absent)", async () => {
  const mock = new MockProvider().script(endResponse("hi"));
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const ports: BrainPorts = {
    memory: { recall: async () => [] },
    skills: { eligible: async () => [] },
    tools: { list: async () => [] },
    prompt: { system: async () => "sys" },
    actions: { submit: async (a) => ({ actionId: a.action.id, outcome: "ok", summary: "" }) },
  };
  const turn = await new Brain({ modelId: "mock-model", guards: DEFAULT_GUARDS }, registry, ports).run(op("hi"));
  assert.equal(turn.stopReason, "complete"); // no crash without an observer
});

test("observer sees a guard halt", async () => {
  const mock = new MockProvider().script(
    toolResponse("t1", "fs.read", { path: "a" }),
    toolResponse("t2", "fs.read", { path: "b" }),
  );
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const halts: string[] = [];
  const ports: BrainPorts = {
    memory: { recall: async () => [] },
    skills: { eligible: async () => [] },
    tools: { list: async () => [] },
    prompt: { system: async () => "sys" },
    actions: { submit: async (a) => ({ actionId: a.action.id, outcome: "ok", summary: "" }) },
    observer: { onHalt: (e) => halts.push(e.reason) },
  };
  await new Brain(
    { modelId: "mock-model", guards: { ...DEFAULT_GUARDS, maxIterations: 1 } },
    registry,
    ports,
  ).run(op("loop"));
  assert.equal(halts.length, 1);
  assert.match(halts[0]!, /iteration cap/);
});
