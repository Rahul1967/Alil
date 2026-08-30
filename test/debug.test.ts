import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAlil } from "../src/app/core.ts";
import { debugEnabled } from "../src/app/debug.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import type { ModelResponse } from "../src/providers/types.ts";
import type { ApprovalPort } from "../src/policy/index.ts";

const denyAll: ApprovalPort = { async request() { return { approved: false }; } };
function toolResp(id: string, tool: string, args: Record<string, unknown> = {}): ModelResponse {
  return { toolCalls: [{ id, tool, args }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
}
function endResp(text = "done"): ModelResponse {
  return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Capture everything written to stderr while `fn` runs. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => { buf += chunk.toString(); return true; };
  try { await fn(); } finally { (process.stderr as { write: unknown }).write = orig; }
  return strip(buf);
}

test("debug mode traces recall, the tool call, the policy verdict, and the tool response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-dbg-"));
  const mock = new MockProvider().script(toolResp("t1", "world.read"), endResp("here is your state"));
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const alil = createAlil(
    { modelId: "mock-model", registry, debug: true, dbPath: ":memory:", auditPath: join(dir, "a.jsonl"), worldPath: join(dir, "w.json"), worldMarkdownPath: join(dir, "W.md") },
    { channel: "test", approvals: denyAll },
  );

  const out = await captureStderr(async () => {
    await alil.runTurn("show me the world", { origin: "operator" });
  });

  // Turn frame
  assert.match(out, /turn ▸ test ▸ operator/);
  assert.match(out, /show me the world/);
  // Context taps
  assert.match(out, /⟐ recall/);
  assert.match(out, /⟐ world/);
  // The tool call, its policy verdict (world.read is allow-listed), and the response
  assert.match(out, /→ world\.read/);
  assert.match(out, /⚖ policy\s+allow \[allow-rule\] → executed/);
  assert.match(out, /✓ world\.read/);
  // Footer
  assert.match(out, /complete ▸ 2 iters/);
});

test("without debug, nothing is written to stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-nodbg-"));
  const mock = new MockProvider().script(endResp("hi"));
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const alil = createAlil(
    { modelId: "mock-model", registry, debug: false, dbPath: ":memory:", auditPath: join(dir, "a.jsonl"), worldPath: join(dir, "w.json"), worldMarkdownPath: join(dir, "W.md") },
    { channel: "test", approvals: denyAll },
  );
  const out = await captureStderr(async () => { await alil.runTurn("hi", { origin: "operator" }); });
  assert.equal(out, "");
});

test("debugEnabled reads --debug / ALIL_DEBUG / npm_config_debug", () => {
  const savedArgv = process.argv;
  const savedEnv = process.env.ALIL_DEBUG;
  try {
    process.argv = ["node", "x"]; delete process.env.ALIL_DEBUG;
    assert.equal(debugEnabled(), false);
    process.env.ALIL_DEBUG = "1";
    assert.equal(debugEnabled(), true);
  } finally {
    process.argv = savedArgv;
    if (savedEnv === undefined) delete process.env.ALIL_DEBUG; else process.env.ALIL_DEBUG = savedEnv;
  }
});
