import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAlil } from "../src/app/core.ts";
import type { ChannelBinding } from "../src/app/core.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import type { ModelResponse } from "../src/providers/types.ts";
import type { ApprovalPort } from "../src/policy/index.ts";

const denyAll: ApprovalPort = { async request() { return { approved: false, reason: "test" }; } };
function endResp(text = "ok"): ModelResponse {
  return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
}

async function makeAlil(binding: Partial<ChannelBinding> = {}, ...responses: ModelResponse[]) {
  const dir = await mkdtemp(join(tmpdir(), "alil-core-"));
  const mock = new MockProvider().script(...(responses.length ? responses : [endResp("hi")]));
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const alil = createAlil(
    { modelId: "mock-model", registry, dbPath: ":memory:", auditPath: join(dir, "audit.jsonl"), worldPath: join(dir, "world.json"), worldMarkdownPath: join(dir, "WORLD.md") },
    { channel: "test", approvals: denyAll, ...binding },
  );
  return { alil, mock, dir };
}

test("createAlil runs a turn through the shared core", async () => {
  const { alil, mock } = await makeAlil({}, endResp("hello there"));
  const turn = await alil.runTurn("hi", { origin: "operator" });
  assert.equal(turn.stopReason, "complete");
  assert.equal(turn.assistantText, "hello there");
  // Recall is ON by construction: the brain was invoked (memory opened on :memory:).
  assert.equal(mock.received.length >= 1, true);
  assert.equal(alil.memoryOn, true);
});

test("createAlil exposes a working world-model and dry-run planning", async () => {
  const { alil } = await makeAlil({}, { text: '[{"id":"a","description":"step one","deps":[]}]', toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } });
  const result = await alil.runPlan("do a thing", { dryRun: true });
  assert.equal(result.status, "planned");
  assert.equal(result.nodes.length, 1);
});

test("an ambient event wakes a turn and notifies the channel", async () => {
  const notes: Array<{ text: string; source: string }> = [];
  const binding: Partial<ChannelBinding> = {
    notify: async (text, meta) => { notes.push({ text, source: meta.source }); },
  };
  // one response for the ambient turn
  const { alil } = await makeAlil(binding, endResp("noticed the alert"));
  await alil.ingestEvent({ channel: "webhook", subject: "URGENT: disk full" });
  // let the queued unprompted turn settle
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.source, "ambient");
  assert.match(notes[0]!.text, /noticed the alert/);
  // the event is recorded in the world-model, tainted
  const ev = alil.world.snapshot().events;
  assert.equal(ev.length >= 1, true);
  assert.equal(ev[0]!.provenance.origin, "ingested");
});

test("an inbound operator message fires a windowed event-intention (chat = an event)", async () => {
  const notes: Array<{ text: string; source: string }> = [];
  // one response for the user's own turn, one for the fired reminder turn
  const { alil } = await makeAlil({ notify: async (t, m) => { notes.push({ text: t, source: m.source }); } }, endResp("hi there"), endResp("↳ EMI reminder"));
  // Schedule an event-triggered reminder whose window is open right now.
  const now = Date.now();
  // Schedule a windowed event-intention directly in the store the core opened.
  alil.memory!.prospective.create({
    title: "EMI", action: "Remind about EMI", trigger: "event",
    eventMatch: { after: now - 60_000, before: now + 60_000 }, provenance: { origin: "operator" },
  });
  // The user chats → this should fire the windowed intention as a second (proactive) turn.
  await alil.runTurn("just saying hi", { origin: "operator" });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(notes.some((n) => n.source === "scheduled"), true, "the windowed reminder fired on the inbound message");
});

test("a context fact surfaces in the model's context when its topic comes up (§D)", async () => {
  const { alil, mock } = await makeAlil({}, endResp("aisle noted"), endResp("weather is fine"));
  // Save a fact-for-later: surface it when "booking travel" comes up.
  const it = alil.memory!.prospective.create({ title: "aisle", action: "prefers an aisle seat", trigger: "context", contextCue: "booking travel", provenance: { origin: "operator" } }).intention;
  await alil.memory!.store.indexContextCue(it.id, "booking travel", { origin: "operator" });

  // A relevant turn → the fact should be injected into the model's context.
  await alil.runTurn("help me book travel to Paris next week", { origin: "operator" });
  const relevant = mock.received[0]!.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  assert.match(relevant, /prefers an aisle seat/);

  // An unrelated turn → the fact should NOT be injected.
  await alil.runTurn("what's the weather today?", { origin: "operator" });
  const unrelated = mock.received[1]!.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  assert.doesNotMatch(unrelated, /prefers an aisle seat/);
});

test("a non-matching event is recorded but wakes nothing", async () => {
  const notes: string[] = [];
  const { alil } = await makeAlil({ notify: async (t) => { notes.push(t); } });
  await alil.ingestEvent({ channel: "webhook", subject: "weekly newsletter" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notes.length, 0);
  assert.equal(alil.world.snapshot().events.length, 1); // still recorded for awareness
});
