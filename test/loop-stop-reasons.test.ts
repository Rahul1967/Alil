/**
 * The loop acts on why the model stopped instead of treating every non-tool stop as an answer:
 * malformed output is retried like a transient error, a context overflow halts with a clear
 * reason, a refusal is reported as one (and not nudged to "answer anyway"). Every provider attempt
 * — success or failure — is reported to the observer with its timing and usage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Brain } from "../src/runtime/loop.ts";
import type { BrainPorts } from "../src/runtime/loop.ts";
import { DEFAULT_GUARDS } from "../src/runtime/types.ts";
import type { BrainObserver, ModelCallEvent } from "../src/runtime/types.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { ProviderRegistry, ProviderError } from "../src/providers/index.ts";
import type { ModelResponse, Provider } from "../src/providers/types.ts";

const usage = { inputTokens: 10, outputTokens: 5 };
const input = { sessionId: "s1", message: { text: "hi", provenance: { origin: "operator" as const } }, history: [] };

function ports(observer?: BrainObserver): BrainPorts {
  return {
    memory: { recall: async () => [] },
    skills: { eligible: async () => [] },
    tools: { list: async () => [] },
    prompt: { system: async () => "You are Alil." },
    actions: { submit: async (a) => ({ actionId: a.action.id, outcome: "ok", summary: "done" }) },
    ...(observer ? { observer } : {}),
  };
}
const brain = (p: Provider, observer?: BrainObserver) =>
  new Brain({ modelId: "mock-model", guards: DEFAULT_GUARDS, retry: { maxRetries: 2, baseDelayMs: 1 } }, new ProviderRegistry().register(p).registerModel(mockSpec), ports(observer));

test("malformed model output is retried, and the retry's answer is used", async () => {
  const mock = new MockProvider().script(
    { toolCalls: [{ id: "x", tool: "fs.list", args: {} }], stopReason: "malformed", rawStopReason: "malformed_tool_use", usage },
    { text: "fine now", toolCalls: [], stopReason: "end", usage },
  );
  let submitted = 0;
  const p = ports();
  p.actions = { submit: async (a) => { submitted++; return { actionId: a.action.id, outcome: "ok", summary: "" }; } };
  const turn = await new Brain({ modelId: "mock-model", guards: DEFAULT_GUARDS, retry: { maxRetries: 2, baseDelayMs: 1 } }, new ProviderRegistry().register(mock).registerModel(mockSpec), p).run(input);
  assert.equal(turn.stopReason, "complete");
  assert.equal(turn.assistantText, "fine now");
  assert.equal(submitted, 0, "a malformed tool use is never executed");
});

test("malformed output that persists past the retry budget halts as an error", async () => {
  const bad: ModelResponse = { text: "", toolCalls: [], stopReason: "malformed", rawStopReason: "malformed_model_output", usage };
  const mock = new MockProvider().script(bad, bad, bad, bad);
  const turn = await brain(mock).run(input);
  assert.equal(turn.stopReason, "error");
  assert.match(turn.haltReason ?? "", /malformed_model_output/);
  assert.equal(mock.received.length, 3, "1 try + 2 retries");
});

test("a context overflow halts with a clear reason, not a silent end", async () => {
  const mock = new MockProvider().script({ text: "partial", toolCalls: [], stopReason: "context_overflow", rawStopReason: "model_context_window_exceeded", usage });
  const halts: string[] = [];
  const turn = await brain(mock, { onHalt: (e) => halts.push(e.reason) }).run(input);
  assert.equal(turn.stopReason, "error");
  assert.match(turn.haltReason ?? "", /context window/);
  assert.equal(halts.length, 1);
});

test("a refusal completes with the model's words and is not nudged", async () => {
  const mock = new MockProvider().script({ text: "I can't help with that.", toolCalls: [], stopReason: "refusal", rawStopReason: "refusal", usage });
  const turn = await brain(mock).run(input);
  assert.equal(turn.stopReason, "complete");
  assert.equal(turn.assistantText, "I can't help with that.");
  assert.equal(mock.received.length, 1, "no empty-reply nudge after a refusal");
});

test("a silent refusal (content filter) still tells the operator why", async () => {
  const mock = new MockProvider().script({ toolCalls: [], stopReason: "refusal", rawStopReason: "content_filtered", usage });
  const turn = await brain(mock).run(input);
  assert.equal(turn.stopReason, "complete");
  assert.match(turn.assistantText ?? "", /content_filtered/);
  assert.equal(mock.received.length, 1);
});

test("every provider attempt reaches the observer with timing, usage and outcome", async () => {
  let calls = 0;
  const flaky: Provider = {
    name: "mock",
    supports: (id) => id === "mock-model",
    async invoke() {
      calls++;
      if (calls === 1) throw new ProviderError("bedrock ThrottlingException: slow down", true, 429, "ThrottlingException");
      return { text: "ok", toolCalls: [], stopReason: "end", rawStopReason: "end_turn", usage: { ...usage, cacheReadTokens: 7 }, latencyMs: 42, requestId: "r1" };
    },
  };
  const events: ModelCallEvent[] = [];
  const turn = await brain(flaky, { onModelCall: (e) => events.push(e) }).run(input);
  assert.equal(turn.stopReason, "complete");
  assert.equal(events.length, 2);
  assert.equal(events[0]!.outcome, "error");
  assert.equal(events[0]!.errorName, "ThrottlingException");
  assert.equal(events[0]!.retryable, true);
  assert.equal(events[0]!.attempt, 1);
  assert.equal(events[1]!.outcome, "ok");
  assert.equal(events[1]!.attempt, 2);
  assert.equal(events[1]!.rawStopReason, "end_turn");
  assert.equal(events[1]!.usage?.cacheReadTokens, 7);
  assert.equal(events[1]!.latencyMs, 42);
  assert.equal(events[1]!.requestId, "r1");
  assert.equal(events[1]!.model, "mock-model");
  assert.equal(typeof events[1]!.durationMs, "number");
});
