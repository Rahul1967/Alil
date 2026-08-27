import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorldStore } from "../src/world/store.ts";
import { worldRead } from "../src/execution/tools/world-read.ts";
import { worldTrack } from "../src/execution/tools/world-track.ts";
import { worldNote } from "../src/execution/tools/world-note.ts";
import type { ToolContext } from "../src/execution/tools/types.ts";
import { initialMessages } from "../src/runtime/context-assembler.ts";
import type { BrainInput } from "../src/runtime/types.ts";
import { Brain } from "../src/runtime/loop.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import { DEFAULT_GUARDS } from "../src/runtime/types.ts";

let t = 1000;
const clock = () => t;
function ctxWith(store?: WorldStore): ToolContext {
  return { sandbox: { resolve: (p: string) => p, root: "/ws" } as never, world: { store } };
}

test("snapshot reflects tracked systems, tasks, and events", () => {
  const w = new WorldStore({ now: clock });
  w.upsertTask({ id: "t1", goal: "prep the Mk7", status: "running", provenance: { origin: "model" } });
  w.upsertSystem("suit.battery", 0.8, "diag", { origin: "model" });
  w.applyEvent("started", "began diagnostics", { origin: "model" });
  const s = w.snapshot();
  assert.equal(s.tasks.length, 1);
  assert.equal(s.systems.length, 1);
  assert.equal(s.events.length, 1);
});

test("events are ring-buffered to maxEvents", () => {
  const w = new WorldStore({ now: clock, maxEvents: 3 });
  for (let i = 0; i < 5; i++) w.applyEvent("n", `e${i}`, { origin: "model" });
  const s = w.snapshot();
  assert.equal(s.events.length, 3);
  assert.deepEqual(s.events.map((e) => e.summary), ["e2", "e3", "e4"]); // oldest dropped
});

test("stateBlock marks tainted (ingested) entries and hides closed tasks", () => {
  const w = new WorldStore({ now: clock });
  w.upsertTask({ id: "open", goal: "do X", status: "running", provenance: { origin: "model" } });
  w.upsertTask({ id: "closed", goal: "done Y", status: "done", provenance: { origin: "model" } });
  w.applyEvent("observed", "value from a web page", { origin: "ingested", ingestedFrom: "https://x" });
  const block = w.stateBlock()!;
  assert.match(block, /do X/);
  assert.doesNotMatch(block, /done Y/); // closed tasks are omitted
  assert.match(block, /value from a web page ⚠untrusted/); // taint surfaced
});

test("world persists to JSON and reloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-world-"));
  const path = join(dir, "world.json");
  const md = join(dir, "WORLD.md");
  const w1 = new WorldStore({ path, markdownPath: md, now: clock });
  w1.upsertSystem("k", { v: 1 }, "src", { origin: "model" });
  w1.applyEvent("note", "hi", { origin: "model" });
  // markdown mirror written
  assert.match(await readFile(md, "utf8"), /world-model/);
  // reload from JSON
  const w2 = new WorldStore({ path, now: clock });
  const s = w2.snapshot();
  assert.equal(s.systems.length, 1);
  assert.equal(s.events.length, 1);
  assert.deepEqual(s.systems[0]!.value, { v: 1 });
});

test("corrupt world file loads clean instead of throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-world2-"));
  const path = join(dir, "world.json");
  await writeFile(path, "{ not json");
  const w = new WorldStore({ path, now: clock });
  assert.deepEqual(w.snapshot().events, []);
});

// ─── tools ───
test("world.read is read-only and returns the snapshot", async () => {
  assert.equal(worldRead.effect, "read");
  const w = new WorldStore({ now: clock });
  w.applyEvent("note", "x", { origin: "model" });
  const out = await worldRead.run({}, ctxWith(w));
  assert.match(out.summary, /1 event/);
});

test("world.track and world.note are writes and mutate the store", async () => {
  assert.equal(worldTrack.effect, "write");
  assert.equal(worldNote.effect, "write");
  const w = new WorldStore({ now: clock });
  await worldTrack.run({ key: "suit.mk7", value: { ready: true } }, ctxWith(w));
  await worldNote.run({ summary: "armed" }, ctxWith(w));
  const s = w.snapshot();
  assert.equal(s.systems[0]!.key, "suit.mk7");
  assert.equal(s.events[0]!.summary, "armed");
});

test("world tools fail gracefully when the world-model is off", async () => {
  await assert.rejects(() => worldRead.run({}, ctxWith(undefined)), /not available/);
});

// ─── context assembly ───
test("initialMessages injects the world state block first", () => {
  const input: BrainInput = { sessionId: "s", message: { text: "hi", provenance: { origin: "operator" } }, history: [] };
  const msgs = initialMessages({ input, recalled: [], skills: [], worldState: "Open tasks:\n  - [running] prep" });
  const ctx = msgs.find((m) => typeof m.content === "string" && m.content.includes("[current state]"));
  assert.ok(ctx, "state block present");
  assert.match(ctx!.content as string, /prep/);
});

test("a real Brain turn receives BOTH the world state block and recalled memory", async () => {
  const world = new WorldStore({ now: clock });
  world.upsertTask({ id: "t1", goal: "prep the Mk7", status: "running", provenance: { origin: "model" } });
  const mock = new MockProvider().script({
    text: "ok", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 },
  });
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const brain = new Brain({ modelId: "mock-model", guards: DEFAULT_GUARDS }, registry, {
    memory: { recall: async () => [{ text: "Sokovia incident: reroute power", provenance: { origin: "system" }, source: "episode:9" }] },
    skills: { eligible: async () => [] },
    tools: { list: async () => [] },
    prompt: { system: async () => "sys" },
    actions: { submit: async (a) => ({ actionId: a.action.id, outcome: "ok", summary: "" }) },
    world, // WorldStore is a WorldPort (stateBlock)
  });
  await brain.run({ sessionId: "s", message: { text: "prep it", provenance: { origin: "operator" } }, history: [] });

  const firstMsgs = mock.received[0]!.messages;
  const blob = firstMsgs.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  assert.match(blob, /\[current state\][\s\S]*prep the Mk7/, "present-tense world state reached the model");
  assert.match(blob, /Sokovia incident/, "situational recall reached the model");
});
