import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { visionView } from "../src/execution/tools/vision-view.ts";
import { Sandbox } from "../src/execution/index.ts";
import type { ToolContext } from "../src/execution/tools/types.ts";
import {
  ProviderRegistry,
  BedrockProvider,
  type ChatMessage,
} from "../src/providers/index.ts";
import { AnthropicProvider } from "../src/providers/index.ts";

// A 1×1 transparent PNG (valid magic bytes + IHDR/IDAT/IEND). Base64-decoded into the fixture.
const PNG_1x1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_1x1_B64, "base64"));

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "alil-vision-"));
  const ctx: ToolContext = { sandbox: new Sandbox(dir) };
  return { dir, ctx, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("vision.view returns the image as a base64 block, tainted ingested", async () => {
  const { dir, ctx, cleanup } = fresh();
  try {
    writeFileSync(join(dir, "shot.png"), PNG_BYTES);
    const res = await visionView.run({ path: "shot.png", prompt: "what is here?" }, ctx);

    assert.equal(res.images?.length, 1);
    assert.equal(res.images?.[0]?.mediaType, "image/png");
    assert.equal(res.images?.[0]?.data, PNG_1x1_B64);
    // Untrusted: must be fenced/tainted like doc.read.
    assert.equal(res.provenance?.origin, "ingested");
    // The prompt is threaded into the summary the model reads.
    assert.match(res.summary, /what is here\?/);
  } finally {
    cleanup();
  }
});

test("vision.view refuses an unsupported extension", async () => {
  const { dir, ctx, cleanup } = fresh();
  try {
    writeFileSync(join(dir, "notes.txt"), "hello");
    const res = await visionView.run({ path: "notes.txt" }, ctx);
    assert.equal(res.images, undefined);
    assert.match(res.summary, /cannot read/);
  } finally {
    cleanup();
  }
});

test("vision.view refuses a file whose bytes are not a real image", async () => {
  const { dir, ctx, cleanup } = fresh();
  try {
    // A .png extension but the bytes are plain text — magic-byte sniff must catch it.
    writeFileSync(join(dir, "fake.png"), "not actually a png");
    const res = await visionView.run({ path: "fake.png" }, ctx);
    assert.equal(res.images, undefined);
    assert.match(res.summary, /not a recognized image/);
  } finally {
    cleanup();
  }
});

test("vision.view refuses an empty file", async () => {
  const { dir, ctx, cleanup } = fresh();
  try {
    writeFileSync(join(dir, "empty.png"), new Uint8Array(0));
    const res = await visionView.run({ path: "empty.png" }, ctx);
    assert.equal(res.images, undefined);
    assert.match(res.summary, /empty/);
  } finally {
    cleanup();
  }
});

test("vision.view validate rejects a missing path", () => {
  const v = visionView.validate({});
  assert.equal(v.ok, false);
});

// ─── provider mapping: image blocks ride the tool-result message when the model has vision ───

/** A tool message carrying one result with an image. */
function toolMsgWithImage(): ChatMessage {
  return {
    role: "tool",
    toolResults: [
      {
        toolCallId: "call_1",
        content: "viewing image shot.png",
        images: [{ data: PNG_1x1_B64, mediaType: "image/png" }],
      },
    ],
  };
}

test("bedrock emits a native image block on a vision model, before the text", async () => {
  let captured: any;
  const bedrock = new BedrockProvider({
    send: async (cmd: any) => {
      captured = cmd.input;
      return { output: { message: { content: [{ text: "a 1x1 image" }] } }, stopReason: "end_turn", usage: {} };
    },
  } as never);
  const { spec, provider } = new ProviderRegistry()
    .register(bedrock)
    .resolve("global.anthropic.claude-sonnet-5");
  assert.equal(spec.capabilities.vision, true);

  await provider.invoke(
    { model: spec.id, messages: [toolMsgWithImage()] },
    spec,
  );

  const content = captured.messages[0].content[0].toolResult.content;
  // image block first, text second
  assert.ok(content[0].image, "expected an image block");
  assert.equal(content[0].image.format, "png");
  assert.ok(content[0].image.source.bytes instanceof Uint8Array);
  assert.equal(content[1].text, "viewing image shot.png");
});

test("bedrock drops image bytes for a non-vision model, keeping the text", async () => {
  let captured: any;
  const bedrock = new BedrockProvider({
    send: async (cmd: any) => {
      captured = cmd.input;
      return { output: { message: { content: [{ text: "no vision" }] } }, stopReason: "end_turn", usage: {} };
    },
  } as never);
  const { spec } = new ProviderRegistry()
    .register(bedrock)
    .resolve("global.anthropic.claude-sonnet-5");

  // Force a non-vision spec to exercise the degrade path.
  const noVision = { ...spec, capabilities: { ...spec.capabilities, vision: false } };
  await bedrock.invoke({ model: spec.id, messages: [toolMsgWithImage()] }, noVision);

  const content = captured.messages[0].content[0].toolResult.content;
  assert.equal(content.length, 1);
  assert.equal(content[0].text, "viewing image shot.png");
});

test("anthropic emits an image source block on a vision model", async () => {
  const captured: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    captured.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} }),
    };
  }) as never;
  try {
    const anthropic = new AnthropicProvider("test-key");
    const { spec } = new ProviderRegistry().register(anthropic).resolve("claude-fable-5");
    assert.equal(spec.capabilities.vision, true);

    await anthropic.invoke({ model: spec.id, messages: [toolMsgWithImage()] }, spec);

    const trContent = captured[0].messages[0].content[0].content;
    assert.equal(trContent[0].type, "image");
    assert.equal(trContent[0].source.type, "base64");
    assert.equal(trContent[0].source.media_type, "image/png");
    assert.equal(trContent[0].source.data, PNG_1x1_B64);
    assert.equal(trContent[1].type, "text");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("anthropic keeps a plain string tool_result for a non-vision model", async () => {
  const captured: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    captured.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} }),
    };
  }) as never;
  try {
    const anthropic = new AnthropicProvider("test-key");
    const { spec } = new ProviderRegistry().register(anthropic).resolve("claude-fable-5");
    const noVision = { ...spec, capabilities: { ...spec.capabilities, vision: false } };

    await anthropic.invoke({ model: spec.id, messages: [toolMsgWithImage()] }, noVision);

    // Degrade path: content is the plain string, no image block.
    assert.equal(captured[0].messages[0].content[0].content, "viewing image shot.png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
