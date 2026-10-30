/**
 * End to end: one turn produces a complete, joinable trace — telemetry events, ledger records and
 * timeline lines all carry the same turn id. The turn id is attribution only: it never enters an
 * approval binding (adversarial). Health reports real readiness, and a hard failure alerts the
 * operator through the channel.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlil } from "../src/app/index.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { Telemetry, MemorySink } from "../src/telemetry/index.ts";
import type { ApprovalRequest, ApprovalDecision } from "../src/policy/approval/types.ts";
import type { ModelResponse } from "../src/providers/types.ts";

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 };
const toolTurn = (id: string, tool: string, args: Record<string, unknown>): ModelResponse => ({ toolCalls: [{ id, tool, args }], stopReason: "tool_use", usage });
const end = (text: string): ModelResponse => ({ text, toolCalls: [], stopReason: "end", rawStopReason: "end_turn", usage });

function build(opts: { script: ModelResponse[]; decide?: (r: ApprovalRequest) => ApprovalDecision; notify?: (t: string) => void; dbPath?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "alil-teli-"));
  writeFileSync(join(dir, "notes.md"), "hello");
  const sink = new MemorySink();
  const telemetry = new Telemetry({ sink, process: "browser" });
  const mock = new MockProvider().script(...opts.script);
  const requests: ApprovalRequest[] = [];
  const alil = createAlil(
    {
      modelId: "mock-model", registry: new ProviderRegistry().register(mock).registerModel(mockSpec),
      stateDir: dir, sandboxRoot: dir, dbPath: opts.dbPath ?? join(dir, "memory.db"), mcpConfigPath: join(dir, "none.json"), telemetry,
    },
    {
      channel: "browser",
      approvals: { async request(r) { requests.push(r); return opts.decide ? opts.decide(r) : { approved: false, outcome: "declined" }; } },
      ...(opts.notify ? { notify: async (t: string) => opts.notify!(t) } : {}),
    },
  );
  return { alil, sink, dir, mock, requests };
}

test("one turn's telemetry, ledger records and timeline lines share one turn id", async () => {
  const { alil, sink, dir } = build({ script: [toolTurn("c1", "fs.read", { path: "notes.md" }), end("It says hello.")] });
  await alil.runTurn("what's in notes.md?", { origin: "operator", channel: "browser" });

  const kinds = sink.events.map((e) => e.kind);
  for (const k of ["turn.start", "recall", "model.call", "tool.call", "audit", "turn.end"]) assert.ok(kinds.includes(k), `emits ${k}`);
  const start = sink.events.find((e) => e.kind === "turn.start")!;
  const turnId = start.turnId!;
  assert.match(turnId, /^t_/);
  for (const e of sink.events.filter((x) => ["turn.start", "model.call", "tool.call", "turn.end", "recall"].includes(x.kind))) {
    assert.equal(e.turnId, turnId, `${e.kind} carries the turn id`);
    assert.equal(e.channel, "browser");
  }

  const endEv = sink.events.find((e) => e.kind === "turn.end")!;
  assert.equal(endEv["stopReason"], "complete");
  assert.equal(endEv["iterations"], 2);
  assert.equal(endEv["toolCalls"], 1);
  assert.equal((endEv["usage"] as { modelCalls: number }).modelCalls, 2);
  assert.equal((endEv["usage"] as { cacheReadTokens: number }).cacheReadTokens, 100);
  assert.ok((endEv["usage"] as { costUsd: number }).costUsd > 0);
  assert.equal(typeof endEv["durationMs"], "number");
  assert.equal(endEv["reply"], undefined, "content is off by default");

  const tool = sink.events.find((e) => e.kind === "tool.call")!;
  assert.equal(tool["tool"], "fs.read");
  assert.equal(tool["outcome"], "ok");
  assert.equal(typeof tool["durationMs"], "number");
  assert.ok((tool["resultChars"] as number) > 0);

  const ledger = readFileSync(join(dir, "logs", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const policy = ledger.find((r) => r.evt === "policy" && r.tool === "fs.read");
  const turn = ledger.find((r) => r.evt === "turn");
  assert.equal(policy.turnId, turnId);
  assert.equal(turn.turnId, turnId);
  assert.equal(typeof turn.durationMs, "number");
  assert.ok(turn.costUsd > 0);

  const lines = alil.memory!.timeline.workingSet(10).filter((l) => l.channel === "browser");
  assert.deepEqual(lines.map((l) => l.turnId), [turnId, turnId], "the user line and the reply");
});

test("two turns get different ids", async () => {
  const { alil, sink } = build({ script: [end("a"), end("b")] });
  await alil.runTurn("one", { origin: "operator", channel: "browser" });
  await alil.runTurn("two", { origin: "operator", channel: "browser" });
  const ids = sink.events.filter((e) => e.kind === "turn.end").map((e) => e.turnId);
  assert.equal(new Set(ids).size, 2);
});

test("the turn id never enters an approval binding (adversarial)", async () => {
  // The same write, proposed in two different turns, must bind identically: the binding is the
  // action (tool, args, cwd, target content) — not which turn asked.
  const write = () => toolTurn("w", "fs.write", { path: "out.md", content: "x" });
  const { alil, requests } = build({ script: [write(), end("ok"), write(), end("ok")] });
  await alil.runTurn("write it", { origin: "operator", channel: "browser" });
  await alil.runTurn("write it again", { origin: "operator", channel: "browser" });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]!.binding, requests[1]!.binding);
  assert.doesNotMatch(JSON.stringify(requests[0]!.binding), /t_[0-9a-z]+_/);
  assert.equal(JSON.stringify(requests[0]!.action).includes("turnId"), false, "nor the action contract");
});

test("approval waits and outcomes reach telemetry", async () => {
  const { alil, sink } = build({
    script: [toolTurn("w", "fs.write", { path: "out.md", content: "x" }), end("done")],
    decide: () => ({ approved: false, outcome: "timeout", reason: "approval timed out" }),
  });
  await alil.runTurn("write it", { origin: "operator", channel: "browser" });
  const audit = sink.events.find((e) => e.kind === "audit" && e["evt"] === "policy" && e["tool"] === "fs.write")!;
  assert.equal(audit["resolution"], "timeout");
  assert.equal(audit["by"], "harness");
  assert.equal(typeof audit["approvalWaitMs"], "number");
  const tool = sink.events.find((e) => e.kind === "tool.call" && e["tool"] === "fs.write")!;
  assert.equal(tool["outcome"], "denied");
  assert.equal(typeof tool["approvalWaitMs"], "number");
});

test("an approval that cannot reach the operator alerts through the channel", async () => {
  const sent: string[] = [];
  const { alil } = build({
    script: [toolTurn("w", "fs.write", { path: "out.md", content: "x" }), end("done")],
    decide: () => ({ approved: false, outcome: "unreachable", reason: "couldn't reach Telegram" }),
    notify: (t) => sent.push(t),
  });
  alil.start();
  try {
    await alil.runTurn("write it", { origin: "operator", channel: "browser" });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(sent.some((t) => /approval requests reach the operator/.test(t) && /fs\.write/.test(t)), sent.join("\n"));
  } finally {
    alil.stop();
  }
});

test("health is ok on a working instance and names what is broken otherwise", async () => {
  const good = build({ script: [] });
  const h = await good.alil.health();
  assert.equal(h.ok, true, JSON.stringify(h.failing));
  assert.equal(h.checks.memory.ok, true);
  assert.equal(h.checks.ledger.ok, true);
  assert.equal(h.process, "browser");

  const noMem = build({ script: [], dbPath: "/proc/alil-no-such/dir/memory.db" });
  const bad = await noMem.alil.health();
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.memory.ok, false);
  assert.ok(bad.failing.includes("memory.on"));
});

test("a broken ledger shows in health", async () => {
  const { alil, dir } = build({ script: [end("a"), end("b")] });
  // Two records: a hash chain protects a line through the NEXT line's prevHash.
  await alil.runTurn("one", { origin: "operator", channel: "browser" });
  await alil.runTurn("two", { origin: "operator", channel: "browser" });
  const path = join(dir, "logs", "audit.jsonl");
  const lines = readFileSync(path, "utf8").trim().split("\n");
  lines[0] = lines[0]!.replace(/"seq":1/, '"seq":1,"tampered":true');
  writeFileSync(path, lines.join("\n") + "\n");
  const h = await alil.health();
  assert.equal(h.checks.ledger.ok, false);
});
