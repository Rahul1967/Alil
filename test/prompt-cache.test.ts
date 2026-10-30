/**
 * Prompt caching: the system prompt, the tool block and the conversation so far are marked as
 * cache points, so iterations 2+ of a turn re-read that prefix at the cache rate instead of paying
 * full input price for it every time. Off for models that don't declare support, and when the
 * invocation opts out. Cache usage is priced into the turn's cost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BedrockProvider, AnthropicProvider, ProviderRegistry, costOf } from "../src/providers/index.ts";
import type { ModelInvocation, ModelSpec } from "../src/providers/types.ts";

const MODEL = "global.anthropic.claude-sonnet-5";
const inv = (over: Partial<ModelInvocation> = {}): ModelInvocation => ({
  model: MODEL,
  system: "You are Alil.",
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", toolCalls: [{ id: "a", tool: "fs.list", args: {} }] },
    { role: "tool", toolResults: [{ toolCallId: "a", content: "listed" }] },
  ],
  tools: [{ name: "fs.list", description: "list", parameters: { type: "object", properties: {} } }],
  cache: true,
  ...over,
});

async function bedrockRequest(over: Partial<ModelInvocation> = {}, specOver: Partial<ModelSpec["capabilities"]> = {}) {
  let captured: any;
  const p = new BedrockProvider({ send: async (cmd: any) => { captured = cmd.input; return { output: { message: { content: [{ text: "ok" }] } }, stopReason: "end_turn", usage: {} }; } } as never);
  const { spec } = new ProviderRegistry().register(p).resolve(MODEL);
  await p.invoke(inv(over), { ...spec, capabilities: { ...spec.capabilities, ...specOver } });
  return captured;
}

test("bedrock: cache points after the system prompt, the tools and the last message", async () => {
  const req = await bedrockRequest();
  assert.deepEqual(req.system.at(-1), { cachePoint: { type: "default" } });
  assert.deepEqual(req.toolConfig.tools.at(-1), { cachePoint: { type: "default" } });
  assert.deepEqual(req.messages.at(-1).content.at(-1), { cachePoint: { type: "default" } });
  assert.equal(req.messages.slice(0, -1).flatMap((m: any) => m.content).filter((c: any) => c.cachePoint).length, 0, "only the last message carries one");
});

test("bedrock: no cache points when the model doesn't support caching or the call opts out", async () => {
  for (const req of [await bedrockRequest({}, { promptCache: false }), await bedrockRequest({ cache: false })]) {
    assert.equal(JSON.stringify(req).includes("cachePoint"), false);
  }
});

test("anthropic: cache_control on the system prompt, the last tool and the last message block", async () => {
  let body: any;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    const p = new AnthropicProvider("k");
    const { spec } = new ProviderRegistry().register(p).resolve("claude-fable-5");
    await p.invoke(inv({ model: "claude-fable-5" }), spec);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(body.system.at(-1).cache_control, { type: "ephemeral" });
  assert.deepEqual(body.tools.at(-1).cache_control, { type: "ephemeral" });
  assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });
  assert.equal(JSON.stringify(body).split("cache_control").length - 1, 3, "three breakpoints, under the limit of four");
});

test("cost prices cache reads and writes", () => {
  const pricing = { inputPerMTok: 2, outputPerMTok: 10 };
  // 1M cache-read tokens at 0.1× input, 1M cache-write at 1.25× input.
  assert.equal(costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, pricing), 0.2);
  assert.equal(costOf({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 }, pricing), 2.5);
  assert.equal(costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, { ...pricing, cacheReadPerMTok: 0.5 }), 0.5);
});

test("bedrock: a model that rejects cache points is retried without them, and not sent them again", async () => {
  const sent: any[] = [];
  const p = new BedrockProvider({
    send: async (cmd: any) => {
      sent.push(cmd.input);
      if (JSON.stringify(cmd.input).includes("cachePoint")) {
        throw Object.assign(new Error("This model doesn't support prompt caching"), { name: "ValidationException", $metadata: { httpStatusCode: 400 } });
      }
      return { output: { message: { content: [{ text: "ok" }] } }, stopReason: "end_turn", usage: {} };
    },
  } as never);
  const { spec } = new ProviderRegistry().register(p).resolve(MODEL);
  const r1 = await p.invoke(inv(), spec);
  assert.equal(r1.text, "ok");
  assert.equal(sent.length, 2);
  await p.invoke(inv(), spec);
  assert.equal(sent.length, 3, "remembered: no cached attempt the second time");
  assert.equal(JSON.stringify(sent[2]).includes("cachePoint"), false);
});
