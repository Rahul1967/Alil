/**
 * History is bounded by tokens, not rows: long messages shrink the window, short ones widen it,
 * the newest line always survives, and each prior line says which channel it came from (the
 * conversation spans Telegram, the browser and the CLI).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitToTokenBudget } from "../src/memory/working-set.ts";
import { createAlil } from "../src/app/index.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";

const len = (s: string) => s.length;

test("keeps the newest lines that fit the budget", () => {
  const r = fitToTokenBudget(["aaaa", "bb", "cc", "dd"], { maxTokens: 5, estimate: len });
  assert.deepEqual(r.lines, ["cc", "dd"]);
  assert.equal(r.tokens, 4);
  assert.equal(r.dropped, 2);
});

test("short lines allow more rows than long ones", () => {
  const short = Array.from({ length: 100 }, () => "x");
  const long = Array.from({ length: 100 }, () => "x".repeat(50));
  assert.equal(fitToTokenBudget(short, { maxTokens: 100, estimate: len }).lines.length, 100);
  assert.equal(fitToTokenBudget(long, { maxTokens: 100, estimate: len }).lines.length, 2);
});

test("the newest line is kept even when it alone exceeds the budget", () => {
  const r = fitToTokenBudget(["a", "x".repeat(1000)], { maxTokens: 10, estimate: len });
  assert.deepEqual(r.lines, ["x".repeat(1000)]);
});

test("the row ceiling still applies", () => {
  assert.equal(fitToTokenBudget(["a", "b", "c"], { maxTokens: 1e9, maxLines: 2, estimate: len }).lines.length, 2);
});

function channel(dir: string, name: string, mock: MockProvider, historyTokens?: number) {
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  return createAlil(
    { modelId: "mock-model", registry, stateDir: dir, sandboxRoot: dir, dbPath: join(dir, "memory.db"), mcpConfigPath: join(dir, "none.json"), ...(historyTokens ? { historyTokens } : {}) },
    { channel: name, approvals: { async request() { return { approved: false }; } } },
  );
}

test("prior user lines are labelled with their channel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alil-ws-"));
  const mock = new MockProvider();
  await channel(dir, "telegram", mock).runTurn("from my phone", { origin: "user_channel", channel: "telegram" });
  await channel(dir, "browser", mock).runTurn("from the browser", { origin: "operator", channel: "browser" });
  const msgs = mock.received.at(-1)!.messages.map((m) => m.content ?? "");
  assert.ok(msgs.some((c) => c.startsWith("[via telegram]") && c.includes("from my phone")), "prior line carries its channel");
  assert.equal(msgs.at(-1), "from the browser", "the current message is not relabelled");
});

test("a long earlier message is dropped from history when it would blow the budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alil-ws-"));
  const mock = new MockProvider();
  const alil = channel(dir, "browser", mock, 500);
  await alil.runTurn("PASTE " + "lorem ipsum ".repeat(400), { origin: "operator", channel: "browser" });
  await alil.runTurn("short follow-up", { origin: "operator", channel: "browser" });
  await alil.runTurn("and another", { origin: "operator", channel: "browser" });
  const text = mock.received.at(-1)!.messages.map((m) => m.content ?? "").join("\n");
  assert.doesNotMatch(text, /PASTE/);
  assert.match(text, /short follow-up/);
});
