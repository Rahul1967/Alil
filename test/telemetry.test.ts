/**
 * The telemetry module: one versioned event envelope, sinks that never throw, a turn context that
 * stamps every event emitted inside a turn (including from components that know nothing about
 * turns), content kept out unless explicitly enabled, file rotation, and the report that reads the
 * files back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Telemetry, MemorySink, JsonlFileSink, FanoutSink, withTurn, currentTurn, newTurnId,
  TELEMETRY_SCHEMA_VERSION, readTelemetry, summarize, turnTimeline, Heartbeats,
} from "../src/telemetry/index.ts";
import type { TelemetryEvent, TelemetrySink } from "../src/telemetry/index.ts";

const t = (over: Partial<ConstructorParameters<typeof Telemetry>[0]> = {}) => {
  const sink = new MemorySink();
  return { tel: new Telemetry({ sink, process: "test", ...over }), sink };
};

test("every event carries the versioned envelope", () => {
  const { tel, sink } = t();
  tel.emit("model.call", { durationMs: 12 });
  const e = sink.events[0]!;
  assert.equal(e.v, TELEMETRY_SCHEMA_VERSION);
  assert.equal(e.kind, "model.call");
  assert.equal(e.process, "test");
  assert.equal(e.pid, process.pid);
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(e["durationMs"], 12);
});

test("events emitted inside a turn — at any depth, across awaits — carry its ids", async () => {
  const { tel, sink } = t();
  const turnId = newTurnId();
  await withTurn({ turnId, channel: "telegram", episodeId: "ep1" }, async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(currentTurn()?.turnId, turnId);
    tel.emit("tool.call", { tool: "fs.read" });
  });
  tel.emit("heartbeat", { name: "x" });
  assert.equal(sink.events[0]!.turnId, turnId);
  assert.equal(sink.events[0]!.channel, "telegram");
  assert.equal(sink.events[0]!.episodeId, "ep1");
  assert.equal(sink.events[1]!.turnId, undefined, "outside the turn: no turn id");
});

test("concurrent turns keep their own ids", async () => {
  const { tel, sink } = t();
  await Promise.all(["a", "b"].map((id) => withTurn({ turnId: id, channel: id }, async () => {
    await new Promise((r) => setTimeout(r, id === "a" ? 5 : 1));
    tel.emit("x", { who: id });
  })));
  for (const e of sink.events) assert.equal(e.turnId, e["who"]);
});

test("content is dropped unless content capture is enabled", () => {
  const off = t();
  off.tel.emit("tool.call", { tool: "fs.read" }, { args: { path: "/secret" } });
  assert.equal(off.sink.events[0]!["args"], undefined);
  assert.equal(off.sink.events[0]!["tool"], "fs.read");
  const on = t({ content: true });
  on.tel.emit("tool.call", { tool: "fs.read" }, { args: { path: "/secret" } });
  assert.deepEqual(on.sink.events[0]!["args"], { path: "/secret" });
});

test("a failing sink never throws into the caller, and drops are counted", () => {
  const broken: TelemetrySink = { write() { throw new Error("disk full"); } };
  const tel = new Telemetry({ sink: broken, process: "test" });
  assert.doesNotThrow(() => tel.emit("x", {}));
  assert.equal(tel.dropped, 1);
});

test("a fanout sink keeps writing to healthy sinks when one fails", () => {
  const good = new MemorySink();
  const tel = new Telemetry({ sink: new FanoutSink([{ write() { throw new Error("x"); } }, good]), process: "test" });
  tel.emit("x", {});
  assert.equal(good.events.length, 1);
});

test("the JSONL sink appends one event per line and rotates by size", () => {
  const dir = mkdtempSync(join(tmpdir(), "alil-tel-"));
  const path = join(dir, "telemetry-test.jsonl");
  const tel = new Telemetry({ sink: new JsonlFileSink(path, { maxBytes: 600, keep: 2 }), process: "test" });
  for (let i = 0; i < 40; i++) tel.emit("x", { i, pad: "y".repeat(20) });
  const files = readdirSync(dir).sort();
  assert.ok(files.includes("telemetry-test.jsonl"));
  assert.ok(files.includes("telemetry-test.jsonl.1"), `rotated: ${files.join(",")}`);
  assert.ok(files.length <= 3, "keeps at most `keep` old files");
  for (const line of readFileSync(path, "utf8").trim().split("\n")) assert.equal(JSON.parse(line).kind, "x");
});

test("the reader skips torn or foreign lines instead of failing", () => {
  const dir = mkdtempSync(join(tmpdir(), "alil-tel-"));
  const good = JSON.stringify({ v: 1, ts: "2026-10-31T00:00:00.000Z", kind: "x", process: "p", pid: 1 });
  writeFileSync(join(dir, "telemetry-a.jsonl"), `${good}\n{"torn\nnot json\n${JSON.stringify({ v: 99, kind: "future" })}\n`);
  const events = readTelemetry(dir);
  assert.equal(events.length, 1);
});

function ev(kind: string, f: Record<string, unknown>): TelemetryEvent {
  return { v: 1, ts: "2026-10-31T10:00:00.000Z", kind, process: "p", pid: 1, ...f } as TelemetryEvent;
}

test("summarize aggregates turns, model time, tokens, cost, tools and MCP", () => {
  const events = [
    ev("turn.end", { turnId: "t1", channel: "telegram", durationMs: 4000, stopReason: "complete", iterations: 2, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0, costUsd: 0.01, modelCalls: 2 } }),
    ev("turn.end", { turnId: "t2", channel: "browser", durationMs: 1000, stopReason: "guard_halt", iterations: 25, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002, modelCalls: 1 } }),
    ev("model.call", { turnId: "t1", durationMs: 1500, outcome: "ok" }),
    ev("model.call", { turnId: "t1", durationMs: 300, outcome: "error", errorName: "ThrottlingException" }),
    ev("tool.call", { turnId: "t1", tool: "fs.read", durationMs: 50, outcome: "ok" }),
    ev("tool.call", { turnId: "t1", tool: "shell", durationMs: 60_000, approvalWaitMs: 59_000, outcome: "ok" }),
    ev("mcp.call", { server: "crawl4ai", tool: "md", durationMs: 2000, outcome: "error" }),
    ev("error", { where: "scheduler.fire", message: "boom" }),
  ];
  const s = summarize(events);
  assert.equal(s.turns.count, 2);
  assert.equal(s.turns.byStop["guard_halt"], 1);
  assert.equal(s.turns.durationMs.max, 4000);
  assert.equal(s.tokens.cacheReadTokens, 900);
  assert.ok(Math.abs(s.cost.totalUsd - 0.012) < 1e-9);
  assert.equal(s.model.calls, 2);
  assert.equal(s.model.errors["ThrottlingException"], 1);
  assert.equal(s.tools.byTool["shell"]!.approvalWaitMs, 59_000);
  assert.equal(s.mcp.byServer["crawl4ai"]!.errors, 1);
  assert.equal(s.errors.byWhere["scheduler.fire"], 1);
  assert.ok(s.cache.hitRatio > 0.8, "cache reads / (reads + uncached input)");
});

test("turnTimeline orders one turn's events with offsets from its start", () => {
  const events = [
    { ...ev("turn.start", { turnId: "t1" }), ts: "2026-10-31T10:00:00.000Z" },
    { ...ev("model.call", { turnId: "t1", durationMs: 900 }), ts: "2026-10-31T10:00:01.000Z" },
    { ...ev("tool.call", { turnId: "t2" }), ts: "2026-10-31T10:00:01.500Z" },
    { ...ev("turn.end", { turnId: "t1" }), ts: "2026-10-31T10:00:02.000Z" },
  ] as TelemetryEvent[];
  const tl = turnTimeline(events, "t1");
  assert.deepEqual(tl.map((r) => [r.kind, r.offsetMs]), [["turn.start", 0], ["model.call", 1000], ["turn.end", 2000]]);
});

test("heartbeats report age, and persist through an injectable store", () => {
  let now = 1_000;
  const saved = new Map<string, string>();
  const hb = new Heartbeats({ process: "telegram", now: () => now, store: { save: (k, v) => saved.set(k, v), loadAll: () => [...saved.entries()] } });
  hb.beat("telegram.poll");
  now = 31_000;
  const snap = hb.snapshot();
  assert.equal(snap.find((h) => h.name === "telegram.poll")!.ageMs, 30_000);
  assert.ok(saved.has("heartbeat:telegram:telegram.poll"), "shared with other processes");
});
