import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderRegistry,
  AnthropicProvider,
  BedrockProvider,
} from "../src/providers/index.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { groupMessages } from "../src/providers/message-grouping.ts";
import type { ChatMessage } from "../src/providers/types.ts";

test("registry resolves a catalog model to its provider", () => {
  const reg = new ProviderRegistry().register(new AnthropicProvider("test-key"));
  const { spec, provider } = reg.resolve("claude-fable-5");
  assert.equal(spec.provider, "anthropic");
  assert.equal(provider.name, "anthropic");
  assert.equal(spec.displayName, "Claude Fable 5");
});

test("registry resolves a Bedrock model to the Bedrock provider", () => {
  // Construct with a stub client so no AWS credentials are needed at resolve time.
  const bedrock = new BedrockProvider({ send: async () => ({}) } as never);
  const reg = new ProviderRegistry().register(bedrock);
  const { spec, provider } = reg.resolve("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  assert.equal(spec.provider, "bedrock");
  assert.equal(provider.name, "bedrock");
});

test("unknown model throws", () => {
  const reg = new ProviderRegistry().register(new AnthropicProvider("k"));
  assert.throws(() => reg.resolve("no-such-model"), /unknown model/);
});

test("a test provider swaps in via registerModel with zero loop changes", () => {
  const reg = new ProviderRegistry()
    .register(new AnthropicProvider("k"))
    .register(new MockProvider())
    .registerModel(mockSpec);
  const { spec, provider } = reg.resolve("mock-model");
  assert.equal(provider.name, "mock");
  assert.equal(spec.provider, "mock");
});

test("model with no registered provider throws", () => {
  const reg = new ProviderRegistry(); // nothing registered
  assert.throws(() => reg.resolve("claude-fable-5"), /no registered provider/);
});

test("groupMessages collapses consecutive tool results into one group", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", toolCalls: [
      { id: "a", tool: "fs.list", args: {} },
      { id: "b", tool: "fs.grep", args: {} },
    ] },
    { role: "tool", toolCallId: "a", content: "listed" },
    { role: "tool", toolCallId: "b", content: "grepped" },
  ];
  const groups = groupMessages(messages);
  assert.equal(groups.length, 3); // user, assistant, one tool-result group
  const last = groups[2];
  assert.equal(last.kind, "toolResults");
  assert.deepEqual(
    last.kind === "toolResults" ? last.results.map((r) => r.toolCallId) : [],
    ["a", "b"],
  );
});

test("bedrock maps multiple tool calls to a single user message with all toolResults", async () => {
  // Regression: two tool calls in one turn must produce ONE user message carrying
  // both toolResult blocks, or Bedrock rejects with "Expected toolResult blocks ...".
  let captured: any;
  const bedrock = new BedrockProvider({
    send: async (cmd: any) => {
      captured = cmd.input;
      return { output: { message: { content: [{ text: "ok" }] } }, stopReason: "end_turn", usage: {} };
    },
  } as never);
  const { spec } = new ProviderRegistry().register(bedrock).resolve(
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  );
  await bedrock.invoke(
    {
      model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", toolCalls: [
          { id: "a", tool: "fs.list", args: {} },
          { id: "b", tool: "fs.grep", args: {} },
        ] },
        { role: "tool", toolCallId: "a", content: "listed" },
        { role: "tool", toolCallId: "b", content: "grepped" },
      ],
    },
    spec,
  );
  const msgs = captured.messages;
  assert.equal(msgs.length, 3);
  const toolMsg = msgs[2];
  assert.equal(toolMsg.role, "user");
  assert.equal(toolMsg.content.length, 2);
  assert.deepEqual(
    toolMsg.content.map((c: any) => c.toolResult.toolUseId),
    ["a", "b"],
  );
});
