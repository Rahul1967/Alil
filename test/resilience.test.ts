/**
 * Resilience: an operator's message is never lost, an interrupted turn is recorded (not erased),
 * transient model errors are retried, and episodes survive restarts with accurate close times and
 * no gaps in their summaries.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAlil } from "../src/app/index.ts";
import { Brain } from "../src/runtime/loop.ts";
import { DEFAULT_GUARDS } from "../src/runtime/types.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import { ProviderError } from "../src/providers/types.ts";
import type { Provider, ModelInvocation, ModelResponse, ModelSpec } from "../src/providers/types.ts";
import { mockSpec } from "./helpers/mock-provider.ts";
import { openMemory, EpisodeManager, ExtractiveSummarizer } from "../src/memory/index.ts";

const ok = (text = "ok"): ModelResponse => ({ text, toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } });

type Step = ModelResponse | Error | ((inv: ModelInvocation, signal?: AbortSignal) => Promise<ModelResponse>);

/** A provider whose behaviour per call is a script of responses, errors, or hooks. */
class ScriptedProvider implements Provider {
  readonly name = "mock";
  readonly received: ModelInvocation[] = [];
  readonly #steps: Step[];
  constructor(...steps: Step[]) {
    this.#steps = steps;
  }
  supports(id: string) { return id === "mock-model"; }
  async invoke(inv: ModelInvocation, _spec: ModelSpec, signal?: AbortSignal): Promise<ModelResponse> {
    this.received.push(structuredClone(inv));
    const step = this.#steps.shift() ?? ok("(done)");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(inv, signal);
    return step;
  }
}

function setup(provider: ScriptedProvider, opts: { dir?: string; dbPath?: string; retry?: { maxRetries: number; baseDelayMs: number }; maxIterations?: number } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "alil-res-"));
  const registry = new ProviderRegistry().register(provider).registerModel(mockSpec);
  const alil = createAlil(
    { modelId: "mock-model", registry, stateDir: dir, sandboxRoot: dir, dbPath: opts.dbPath ?? ":memory:", mcpConfigPath: join(dir, "none.json"), providerRetry: opts.retry ?? { maxRetries: 2, baseDelayMs: 1 }, ...(opts.maxIterations ? { guards: { ...DEFAULT_GUARDS, maxIterations: opts.maxIterations } } : {}) },
    { channel: "test", approvals: { async request() { return { approved: false }; } } },
  );
  return { alil, dir };
}

const lines = (alil: ReturnType<typeof setup>["alil"]) =>
  alil.memory!.timeline.workingSet(50).filter((l) => l.channel === "test").map((l) => `${l.role}: ${l.text}`);

// ── the operator's message is never lost ─────────────────────────────────────

test("the operator's message is in the timeline before the model is even called", async () => {
  let seenAtCall: string[] = [];
  const holder: { alil?: ReturnType<typeof setup>["alil"] } = {};
  const p = new ScriptedProvider(async () => { seenAtCall = lines(holder.alil!); return ok("reply"); });
  const { alil } = setup(p);
  holder.alil = alil;
  await alil.runTurn("remember this", { origin: "operator" });
  assert.deepEqual(seenAtCall, ["user: remember this"]);
  assert.deepEqual(lines(alil), ["user: remember this", "assistant: reply"]);
  assert.equal(p.received[0]!.messages.filter((m) => m.role === "user" && m.content === "remember this").length, 1, "the current message is not duplicated into history");
});

test("a failed turn keeps the message and records the interruption for the next turn", async () => {
  const p = new ScriptedProvider(new ProviderError("bad request", false, 400), ok("back"));
  const { alil } = setup(p);
  const t1 = await alil.runTurn("my friend will pay 26K every month", { origin: "operator" });
  assert.equal(t1.stopReason, "error");
  const l = lines(alil);
  assert.equal(l[0], "user: my friend will pay 26K every month");
  assert.match(l[1]!, /^assistant: \[harness note\] My reply to this message was interrupted \(provider error: bad request\)/);
  await alil.runTurn("did you get that?", { origin: "operator" });
  const history = p.received[1]!.messages.map((m) => m.content ?? "").join("\n");
  assert.match(history, /26K every month/, "the lost message is in the next turn's history");
  assert.match(history, /was interrupted/, "and so is the fact that no reply was sent");
});

test("a cancelled turn and a guard halt are recorded too (partial text kept)", async () => {
  const controller = new AbortController();
  const p = new ScriptedProvider(
    async (_inv, signal) => { controller.abort(); throw signal?.aborted ? new ProviderError("aborted", false) : new Error("x"); },
    { text: "partial answer", toolCalls: [{ id: "c", tool: "fs.list", args: { path: "." } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
  );
  const { alil } = setup(p);
  await alil.runTurn("first", { origin: "operator" }, { signal: controller.signal });
  assert.match(lines(alil)[1]!, /interrupted \(cancelled\)/);
  // A 1-iteration cap: the model speaks and calls a tool, then the loop halts before a 2nd call.
  const { alil: a2 } = setup(new ScriptedProvider(
    { text: "partial answer", toolCalls: [{ id: "c1", tool: "fs.list", args: { path: "." } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
  ), { maxIterations: 1 });
  const t = await a2.runTurn("second", { origin: "operator" });
  assert.equal(t.stopReason, "guard_halt");
  const l = lines(a2);
  assert.equal(l[0], "user: second");
  assert.match(l[1]!, /^assistant: partial answer\n\n\[harness note\] My reply to this message was interrupted \(halted: iteration cap \(1\)\)/);
});

test("a turn cut off by a crash is marked interrupted when the process starts again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alil-crash-"));
  const dbPath = join(dir, "memory.db");
  // Process 1: a turn starts (message saved) and then the process dies before replying.
  const { alil: a1 } = setup(new ScriptedProvider(() => new Promise<ModelResponse>(() => {})), { dir, dbPath });
  void a1.runTurn("one correction: he will pay 26K every month", { origin: "operator" });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(lines(a1), ["user: one correction: he will pay 26K every month"]);
  // Process 2 on the same memory.
  const p2 = new ScriptedProvider(ok("sorry, go on"));
  const { alil: a2 } = setup(p2, { dir, dbPath });
  const l = lines(a2);
  assert.equal(l.length, 2);
  assert.match(l[1]!, /interrupted \(the process stopped before I replied\)/);
  await a2.runTurn("did you catch that?", { origin: "operator" });
  assert.match(p2.received[0]!.messages.map((m) => m.content ?? "").join("\n"), /26K every month/);
  assert.ok(a2.audit.tail(20).some((e) => e.evt === "turn.recovered"));
});

// ── transient model errors are retried ───────────────────────────────────────

function brainWith(p: ScriptedProvider, retry = { maxRetries: 2, baseDelayMs: 1 }) {
  const registry = new ProviderRegistry().register(p).registerModel(mockSpec);
  return new Brain({ modelId: "mock-model", guards: DEFAULT_GUARDS, retry }, registry, {
    actions: { async submit(a) { return { actionId: a.action.id, outcome: "ok", summary: "" }; } },
    memory: { async recall() { return []; } }, skills: { async eligible() { return []; } },
    tools: { async list() { return []; } }, prompt: { async system() { return "sys"; } },
  });
}
const input = { sessionId: "s", message: { text: "hi", provenance: { origin: "operator" as const } }, history: [] };

test("retryable provider errors are retried with backoff, then succeed", async () => {
  const p = new ScriptedProvider(new ProviderError("throttled", true, 429), new ProviderError("503", true, 503), ok("finally"));
  const turn = await brainWith(p).run(input);
  assert.equal(turn.stopReason, "complete");
  assert.equal(turn.assistantText, "finally");
  assert.equal(p.received.length, 3);
});

test("non-retryable errors fail at once; retries are bounded", async () => {
  const p1 = new ScriptedProvider(new ProviderError("bad request", false, 400), ok());
  const t1 = await brainWith(p1).run(input);
  assert.equal(t1.stopReason, "error");
  assert.equal(p1.received.length, 1);
  const p2 = new ScriptedProvider(new ProviderError("t", true), new ProviderError("t", true), new ProviderError("t", true), ok());
  const t2 = await brainWith(p2).run(input);
  assert.equal(t2.stopReason, "error");
  assert.equal(p2.received.length, 3, "1 try + 2 retries");
  assert.match(t2.haltReason!, /after 3 attempts/);
});

test("a cancel during backoff stops retrying", async () => {
  const c = new AbortController();
  const p = new ScriptedProvider(new ProviderError("t", true), ok());
  const run = brainWith(p, { maxRetries: 2, baseDelayMs: 10_000 }).run(input, { signal: c.signal });
  setTimeout(() => c.abort(), 20);
  const t = await run;
  assert.equal(t.stopReason, "aborted");
  assert.equal(p.received.length, 1);
});

// ── episodes survive restarts ────────────────────────────────────────────────

function mem() {
  const m = openMemory({ path: ":memory:" });
  const mgr = () => new EpisodeManager({ db: m.db, timeline: m.timeline, store: m.store, summarizer: new ExtractiveSummarizer(), gapMs: 30 * 60_000 });
  return { m, mgr };
}

test("the idle gap runs from the END of the last turn, and ended_at is the last activity, not the close time", async () => {
  const { m, mgr } = mem();
  const e = mgr();
  const ep = await e.beginTurn("2026-09-30T10:00:00.000Z");
  m.timeline.append({ at: "2026-09-30T10:00:00.000Z", channel: "c", provenance: { origin: "operator" }, episodeId: ep, role: "user", text: "long task about the widget ledger" });
  e.endTurn("2026-09-30T10:20:00.000Z"); // a 20-minute turn
  // 15 min after it ENDED (35 min after it started): still the same episode.
  assert.equal(await e.beginTurn("2026-09-30T10:35:00.000Z"), ep);
  e.endTurn("2026-09-30T10:36:00.000Z");
  // Next morning: the old episode closes, dated when activity stopped.
  const next = await e.beginTurn("2026-10-01T09:00:00.000Z");
  assert.notEqual(next, ep);
  const row = m.db.prepare("SELECT ended_at FROM episodes WHERE id = ?").get(ep) as { ended_at: string };
  assert.equal(row.ended_at, "2026-09-30T10:36:00.000Z");
});

test("a closed episode left unsummarized by a crash is summarized on the next start (idempotently)", async () => {
  const { m, mgr } = mem();
  const e = mgr();
  const ep = await e.beginTurn("2026-09-30T10:00:00.000Z");
  m.timeline.append({ at: "2026-09-30T10:00:00.000Z", channel: "c", provenance: { origin: "operator" }, episodeId: ep, role: "user", text: "we planned the Jupiter loan foreclosure in detail" });
  // Simulate a crash between "episode closed" and "summary written".
  m.db.prepare("UPDATE episodes SET end_seq = ?, ended_at = ? WHERE id = ?").run(m.timeline.lastSeq(), "2026-09-30T10:05:00.000Z", ep);
  m.db.prepare("UPDATE agent_state SET active_episode_id = NULL WHERE id = 1").run();
  assert.equal((await m.store.searchEpisodes("Jupiter foreclosure", 3)).length, 0);
  const restarted = mgr();
  assert.equal(await restarted.recover(), 1);
  const hits = await m.store.searchEpisodes("Jupiter foreclosure", 3);
  assert.equal(hits.length, 1);
  assert.equal(await restarted.recover(), 0, "nothing left to recover");
  const chunks = m.db.prepare("SELECT COUNT(*) AS n FROM recall_chunk WHERE kind = 'episode' AND ref = ?").get(ep) as { n: number };
  assert.equal(chunks.n, 1, "no duplicate index entries");
});
