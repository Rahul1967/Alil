/**
 * Providers keep what the API told them: the raw stop reason (refusals, malformed output and
 * context overflow must not pass as a normal "end"), server latency, request id and cache usage.
 * And Bedrock retries in exactly one layer — the loop's — so a throttled call is at most 3 attempts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BedrockProvider, AnthropicProvider, ProviderRegistry, bedrockClientConfig } from "../src/providers/index.ts";
import { ProviderError } from "../src/providers/types.ts";

const MODEL = "global.anthropic.claude-sonnet-5";

function bedrockReturning(out: Record<string, unknown>) {
  const p = new BedrockProvider({ send: async () => out } as never);
  const { spec } = new ProviderRegistry().register(p).resolve(MODEL);
  return () => p.invoke({ model: MODEL, messages: [{ role: "user", content: "hi" }] }, spec);
}

test("the Bedrock client does no retries of its own (the loop is the only retry layer)", () => {
  assert.equal(bedrockClientConfig().maxAttempts, 1);
});

const bedrockCases: Array<[string, string, boolean]> = [
  ["end_turn", "end", false],
  ["stop_sequence", "end", false],
  ["max_tokens", "max_tokens", false],
  ["tool_use", "tool_use", true],
  ["content_filtered", "refusal", false],
  ["guardrail_intervened", "refusal", false],
  ["model_context_window_exceeded", "context_overflow", false],
  ["malformed_model_output", "malformed", false],
  ["malformed_tool_use", "malformed", true],
];

for (const [raw, mapped, withTool] of bedrockCases) {
  test(`bedrock stop reason ${raw} → ${mapped}, raw kept`, async () => {
    const content = withTool ? [{ toolUse: { toolUseId: "t1", name: "fs_list", input: {} } }] : [{ text: "x" }];
    const r = await bedrockReturning({ output: { message: { content } }, stopReason: raw, usage: {} })();
    assert.equal(r.stopReason, mapped);
    assert.equal(r.rawStopReason, raw);
  });
}

test("bedrock keeps server latency, request id and cache token usage", async () => {
  const r = await bedrockReturning({
    output: { message: { content: [{ text: "ok" }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 900, cacheWriteInputTokens: 100 },
    metrics: { latencyMs: 1234 },
    $metadata: { requestId: "req-abc", attempts: 1 },
  })();
  assert.equal(r.latencyMs, 1234);
  assert.equal(r.requestId, "req-abc");
  assert.equal(r.usage.cacheReadTokens, 900);
  assert.equal(r.usage.cacheWriteTokens, 100);
});

test("bedrock errors carry the AWS exception name", async () => {
  const p = new BedrockProvider({
    send: async () => { throw Object.assign(new Error("slow down"), { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } }); },
  } as never);
  const { spec } = new ProviderRegistry().register(p).resolve(MODEL);
  await assert.rejects(p.invoke({ model: MODEL, messages: [{ role: "user", content: "hi" }] }, spec), (e: unknown) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.errorName, "ThrottlingException");
    assert.equal(e.retryable, true);
    return true;
  });
});

// ── Anthropic (fetch) ────────────────────────────────────────────────────────
async function anthropicReturning(json: Record<string, unknown>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(json), { status: 200, headers: { "request-id": "req-xyz" } })) as typeof fetch;
  try {
    const p = new AnthropicProvider("k");
    const { spec } = new ProviderRegistry().register(p).resolve("claude-fable-5");
    return await p.invoke({ model: "claude-fable-5", messages: [{ role: "user", content: "hi" }] }, spec);
  } finally {
    globalThis.fetch = realFetch;
  }
}

for (const [raw, mapped] of [["refusal", "refusal"], ["model_context_window_exceeded", "context_overflow"], ["pause_turn", "end"], ["end_turn", "end"]] as const) {
  test(`anthropic stop reason ${raw} → ${mapped}, raw kept`, async () => {
    const r = await anthropicReturning({ content: [{ type: "text", text: "x" }], stop_reason: raw, usage: {} });
    assert.equal(r.stopReason, mapped);
    assert.equal(r.rawStopReason, raw);
  });
}

test("anthropic keeps request id and cache token usage", async () => {
  const r = await anthropicReturning({
    content: [{ type: "text", text: "x" }], stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 700, cache_creation_input_tokens: 50 },
  });
  assert.equal(r.requestId, "req-xyz");
  assert.equal(r.usage.cacheReadTokens, 700);
  assert.equal(r.usage.cacheWriteTokens, 50);
});
