import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderRegistry,
  AnthropicProvider,
  BedrockProvider,
} from "../src/providers/index.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";

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

test("bedrock maps a multi-result tool turn to a single user message with all toolResults", async () => {
  // Regression: a turn's tool results (one `tool` message carrying many blocks) must map
  // to ONE user message with all toolResult blocks, or Bedrock rejects the turn with
  // "Expected toolResult blocks at messages.N.content for the following Ids: ...".
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
        { role: "tool", toolResults: [
          { toolCallId: "a", content: "listed" },
          { toolCallId: "b", content: "grepped" },
        ] },
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
