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
