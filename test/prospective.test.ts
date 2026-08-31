import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { openMemory } from "../src/memory/index.ts";
import { Scheduler } from "../src/gateway/scheduler.ts";
import { Sandbox } from "../src/execution/index.ts";
import { remindCreate } from "../src/execution/tools/remind-create.ts";
import { remindList } from "../src/execution/tools/remind-list.ts";
import { remindCancel } from "../src/execution/tools/remind-cancel.ts";
import { remindSnooze } from "../src/execution/tools/remind-snooze.ts";
import { remindDone } from "../src/execution/tools/remind-done.ts";
import type { ProspectiveStore } from "../src/memory/prospective.ts";
import type { Intention, IncomingEvent, NewIntention } from "../src/memory/types.ts";
import type { ToolContext } from "../src/execution/tools/types.ts";

function fresh() {
  const path = join(tmpdir(), `alil-prosp-${randomUUID()}.db`);
  const m = openMemory({ path });
  const ctx: ToolContext = { sandbox: new Sandbox(tmpdir()), prospective: { store: m.prospective }, memory: { store: m.store } };
  return { m, store: m.prospective, ctx, cleanup: () => { m.close(); for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true }); } };
}
const T0 = Date.parse("2026-08-26T10:00:00Z");
function once(store: ProspectiveStore, fireAt: number, over: Partial<NewIntention> = {}) {
  return store.create({ title: "t", action: "do it", trigger: "once", fireAt, provenance: { origin: "operator" }, ...over }).intention;
}

// ─── store ───

test("create + dedup: same dedupKey returns the existing row", () => {
  const { store, cleanup } = fresh();
  try {
    const a = store.create({ title: "call", action: "call mom", trigger: "once", fireAt: T0, dedupKey: "k1", provenance: { origin: "operator" } });
    assert.equal(a.created, true);
    const b = store.create({ title: "call again", action: "x", trigger: "once", fireAt: T0 + 1, dedupKey: "k1", provenance: { origin: "operator" } });
    assert.equal(b.created, false);
    assert.equal(b.intention.id, a.intention.id);
    assert.equal(store.list().length, 1);
  } finally { cleanup(); }
});

test("due() returns time intentions at/before now, honoring expiry", () => {
  const { store, cleanup } = fresh();
  try {
    once(store, T0 - 1000); // due
    once(store, T0 + 60_000); // future
    once(store, T0 - 500, { expiresAt: T0 - 100 }); // due but expired

    const due = store.due(T0);
    assert.equal(due.length, 1);
    assert.equal(due[0]!.fireAt, T0 - 1000);
  } finally { cleanup(); }
});

test("claim is atomic: a second claim on the same row fails", () => {
  const { store, cleanup } = fresh();
  try {
    const i = once(store, T0 - 1);
    assert.equal(store.claim(i.id, T0), true);
    assert.equal(store.claim(i.id, T0), false); // already firing
    assert.equal(store.get(i.id)!.status, "firing");
  } finally { cleanup(); }
});

test("cancel + expireOverdue + recoverStale transition status", () => {
  const { store, cleanup } = fresh();
  try {
    const a = once(store, T0 + 1000);
    assert.equal(store.cancel(a.id), true);
    assert.equal(store.get(a.id)!.status, "cancelled");

    once(store, T0 - 1, { expiresAt: T0 - 1 } as Partial<NewIntention>);
    assert.equal(store.expireOverdue(T0), 1);

    const c = once(store, T0 - 1);
    store.claim(c.id, T0 - 10 * 60_000); // claimed long ago (stale)
    assert.equal(store.recoverStale(T0 - 5 * 60_000), 1);
    assert.equal(store.get(c.id)!.status, "pending");
  } finally { cleanup(); }
});

test("matchEvent matches on case-insensitive substrings across fields", () => {
  const { store, cleanup } = fresh();
  try {
    store.create({ title: "landlord", action: "flag it", trigger: "event", eventMatch: { channel: "email", from: "landlord" }, provenance: { origin: "operator" } });
    const hit: IncomingEvent = { channel: "email", from: "The Landlord <x@y.com>", subject: "rent", provenance: { origin: "ingested" } };
    const miss: IncomingEvent = { channel: "email", from: "bank", provenance: { origin: "ingested" } };
    assert.equal(store.matchEvent(hit, T0).length, 1);
    assert.equal(store.matchEvent(miss, T0).length, 0);
  } finally { cleanup(); }
});

test("matchEvent honors the after/before window — the 'remind me if we chat on Oct 5' case", () => {
  const { store, cleanup } = fresh();
  try {
    const after = Date.parse("2026-10-05T00:00:00+05:30");
    const before = Date.parse("2026-10-06T00:00:00+05:30");
    // A date-only predicate: fires on ANY event within the window (an inbound message).
    store.create({ title: "EMI", action: "remind EMI", trigger: "event", eventMatch: { after, before }, provenance: { origin: "operator" } });
    const msg: IncomingEvent = { channel: "terminal", text: "hi", provenance: { origin: "user_channel" } };

    // A chat on Oct 4 (before the window) → no match.
    assert.equal(store.matchEvent(msg, Date.parse("2026-10-04T12:00:00+05:30")).length, 0);
    // A chat on Oct 5 (inside) → matches.
    assert.equal(store.matchEvent(msg, Date.parse("2026-10-05T09:15:00+05:30")).length, 1);
    // A chat on Oct 6 (after) → no match.
    assert.equal(store.matchEvent(msg, Date.parse("2026-10-06T09:00:00+05:30")).length, 0);
  } finally { cleanup(); }
});

test("remind.create accepts a windowed event trigger and self-expires at `before`", () => {
  const { store, ctx, cleanup } = fresh();
  try {
    const r = remindCreate.validate({
      title: "EMI", action: "remind EMI",
      event: { after: "2026-10-05T00:00:00+05:30", before: "2026-10-06T00:00:00+05:30" },
    });
    assert.equal(r.ok, true);
    // before must be later than after
    assert.equal(remindCreate.validate({ title: "t", action: "a", event: { after: "2026-10-06T00:00:00Z", before: "2026-10-05T00:00:00Z" } }).ok, false);
    // bad ISO rejected
    assert.equal(remindCreate.validate({ title: "t", action: "a", event: { after: "5pm" } }).ok, false);

    return remindCreate.run((r as { value: Parameters<typeof remindCreate.run>[0] }).value, ctx).then((out) => {
      const id = (out.data as { id: string }).id;
      const stored = store.get(id)!;
      assert.equal(stored.trigger, "event");
      assert.equal(stored.eventMatch!.after, Date.parse("2026-10-05T00:00:00+05:30"));
      // auto-expiry set to `before` so it lapses if the user never chats that day
      assert.equal(stored.expiresAt, Date.parse("2026-10-06T00:00:00+05:30"));
    }).finally(cleanup);
  } catch (e) { cleanup(); throw e; }
});

// ─── kind (Phase 1: generalized row) ───
test("kind defaults to reminder and round-trips through the store", () => {
  const { store, cleanup } = fresh();
  try {
    const def = once(store, T0); // no kind → default
    assert.equal(store.get(def.id)!.kind, "reminder");
    const fact = store.create({ title: "aisle", action: "prefer aisle", trigger: "event", eventMatch: { contains: "travel" }, kind: "fact", provenance: { origin: "operator" } }).intention;
    assert.equal(store.get(fact.id)!.kind, "fact");
  } finally { cleanup(); }
});

test("remind.create accepts a valid kind and rejects an unknown one", async () => {
  const { store, ctx, cleanup } = fresh();
  try {
    assert.equal(remindCreate.validate({ title: "t", action: "a", at: "2026-10-05T09:00:00Z", kind: "bogus" }).ok, false);
    const r = remindCreate.validate({ title: "someday", action: "read Thinking in Systems", at: "2026-12-01T09:00:00Z", kind: "aspiration" });
    assert.equal(r.ok, true);
    const out = await remindCreate.run((r as { value: Parameters<typeof remindCreate.run>[0] }).value, ctx);
    assert.equal(store.get((out.data as { id: string }).id)!.kind, "aspiration");
  } finally { cleanup(); }
});

test("remind.list surfaces the kind", async () => {
  const { store, ctx, cleanup } = fresh();
  try {
    store.create({ title: "watch build", action: "notify", trigger: "event", eventMatch: { type: "ci" }, kind: "watch", provenance: { origin: "operator" } });
    const out = await remindList.run({ limit: 10 }, ctx);
    const rows = out.data as Array<{ kind: string }>;
    assert.equal(rows.some((r) => r.kind === "watch"), true);
  } finally { cleanup(); }
});

// ─── manual / someday trigger (Phase B) ───
test("a manual item is created with no trigger and never auto-fires", async () => {
  const { store, ctx, cleanup } = fresh();
  try {
    const r = remindCreate.validate({ title: "read Thinking in Systems", action: "surface in review", manual: true, kind: "aspiration" });
    assert.equal(r.ok, true);
    const out = await remindCreate.run((r as { value: Parameters<typeof remindCreate.run>[0] }).value, ctx);
    const item = store.get((out.data as { id: string }).id)!;
    assert.equal(item.trigger, "manual");
    assert.equal(item.kind, "aspiration");
    assert.equal(item.fireAt, null);
    // The scheduler ignores it: not time-due, not event-matched.
    assert.equal(store.due(Date.now() + 1e12).some((i) => i.id === item.id), false);
    assert.equal(store.matchEvent({ channel: "x", text: "anything", provenance: { origin: "user_channel" } }, Date.now()).some((i) => i.id === item.id), false);
  } finally { cleanup(); }
});

test("remind.create rejects manual combined with another trigger, and no-trigger-at-all", () => {
  assert.equal(remindCreate.validate({ title: "t", action: "a", manual: true, at: "2026-10-05T09:00:00Z" }).ok, false); // two triggers
  assert.equal(remindCreate.validate({ title: "t", action: "a" }).ok, false); // zero triggers (manual must be explicit)
  assert.equal(remindCreate.validate({ title: "t", action: "a", manual: true }).ok, true); // manual alone is fine
});

// ─── lifecycle: snooze + done (Phase C) ───
test("snooze re-arms a fired reminder to a new time", () => {
  const { store, cleanup } = fresh();
  try {
    const i = once(store, T0);
    store.markDone(i.id); // simulate it fired
    assert.equal(store.get(i.id)!.status, "done");
    const until = T0 + 3600_000;
    assert.equal(store.snooze(i.id, until), true);
    const after = store.get(i.id)!;
    assert.equal(after.status, "pending");
    assert.equal(after.fireAt, until);
    // now due at the snoozed time
    assert.equal(store.due(until).some((x) => x.id === i.id), true);
  } finally { cleanup(); }
});

test("done marks a live intention acknowledged; cancel is distinct", () => {
  const { store, cleanup } = fresh();
  try {
    const a = once(store, T0), b = once(store, T0);
    assert.equal(store.done(a.id), true);
    assert.equal(store.get(a.id)!.status, "done");
    assert.equal(store.cancel(b.id), true);
    assert.equal(store.get(b.id)!.status, "cancelled");
    // done on an already-done item is a no-op
    assert.equal(store.done(a.id), false);
  } finally { cleanup(); }
});

test("remind.snooze / remind.done validate and run through the tools", async () => {
  const { store, ctx, cleanup } = fresh();
  try {
    const i = once(store, T0);
    assert.equal(remindSnooze.effect, "write");
    assert.equal(remindDone.effect, "write");
    assert.equal(remindSnooze.validate({ id: i.id, until: "nope" }).ok, false);
    await remindSnooze.run({ id: i.id, until: "2026-09-01T09:00:00Z" }, ctx);
    assert.equal(store.get(i.id)!.fireAt, Date.parse("2026-09-01T09:00:00Z"));
    await remindDone.run({ id: i.id }, ctx);
    assert.equal(store.get(i.id)!.status, "done");
  } finally { cleanup(); }
});

// ─── nag-until-done + supersede (finish) ───
test("a nag reminder re-fires instead of completing, until done", async () => {
  const { store, cleanup } = fresh();
  try {
    const fired: Intention[] = [];
    let clock = T0;
    const s = schedulerWith(store, fired, () => clock);
    const i = store.create({ title: "book flight", action: "nudge", trigger: "once", fireAt: T0 - 1000, nag: true, provenance: { origin: "operator" } }).intention;

    await s.tick();
    assert.equal(fired.length, 1);
    // Instead of done, it's re-armed to a later time (nag interval).
    const after = store.get(i.id)!;
    assert.equal(after.status, "pending");
    assert.ok(after.fireAt! > clock, "re-armed into the future");

    // acknowledging it stops the nag
    store.done(i.id);
    clock = after.fireAt! + 1000;
    await s.tick();
    assert.equal(fired.length, 1, "done nag does not fire again");
  } finally { cleanup(); }
});

test("supersedes cancels the old intention on create", async () => {
  const { store, ctx, cleanup } = fresh();
  try {
    const old = once(store, T0);
    const r = remindCreate.validate({ title: "dentist", action: "call", at: "2026-10-05T09:00:00Z", supersedes: old.id });
    assert.equal(r.ok, true);
    await remindCreate.run((r as { value: Parameters<typeof remindCreate.run>[0] }).value, ctx);
    assert.equal(store.get(old.id)!.status, "cancelled");
    // nag requires an `at` trigger
    assert.equal(remindCreate.validate({ title: "t", action: "a", cron: "0 9 * * 1", nag: true }).ok, false);
  } finally { cleanup(); }
});

// ─── context trigger (Phase D: facts-for-later) ───
test("context cue: index, keyword-match, and remove", async () => {
  const { m, store, cleanup } = fresh();
  try {
    const it = store.create({ title: "aisle", action: "prefers an aisle seat", trigger: "context", contextCue: "booking travel", provenance: { origin: "operator" } }).intention;
    await m.store.indexContextCue(it.id, "booking travel", { origin: "operator" });
    // a relevant turn (shares "travel") surfaces it; an unrelated one doesn't.
    assert.equal((await m.store.searchContextCues("help me book travel to Paris", 4)).some((h) => h.id === it.id), true);
    assert.equal((await m.store.searchContextCues("what is the weather today", 4)).some((h) => h.id === it.id), false);
    m.store.removeContextCue(it.id);
    assert.equal((await m.store.searchContextCues("book travel", 4)).some((h) => h.id === it.id), false);
  } finally { cleanup(); }
});

test("remind.create context trigger creates + indexes the cue", async () => {
  const { m, store, ctx, cleanup } = fresh();
  try {
    const r = remindCreate.validate({ title: "aisle", action: "prefers an aisle seat", context: "booking travel", kind: "fact" });
    assert.equal(r.ok, true);
    const out = await remindCreate.run((r as { value: Parameters<typeof remindCreate.run>[0] }).value, ctx);
    const id = (out.data as { id: string }).id;
    assert.equal(store.get(id)!.trigger, "context");
    assert.equal(store.get(id)!.contextCue, "booking travel");
    assert.equal((await m.store.searchContextCues("planning travel", 4)).some((h) => h.id === id), true);
    // context is mutually exclusive with other triggers
    assert.equal(remindCreate.validate({ title: "t", action: "a", context: "x", at: "2026-10-05T09:00:00Z" }).ok, false);
  } finally { cleanup(); }
});

// ─── scheduler ───

function schedulerWith(store: ProspectiveStore, fired: Intention[], now: () => number, cronNext?: (e: string, a: number) => number | null) {
  return new Scheduler({ store, now, cronNext, deliver: async (i) => { fired.push(i); } });
}

test("scheduler.tick fires due intentions once (one-shot → done)", async () => {
  const { store, cleanup } = fresh();
  try {
    const fired: Intention[] = [];
    let clock = T0;
    const s = schedulerWith(store, fired, () => clock);
    once(store, T0 - 1000); // already due (catch-up)
    once(store, T0 + 10_000); // not yet

    await s.tick();
    assert.equal(fired.length, 1);
    await s.tick(); // second tick must not re-fire the done one
    assert.equal(fired.length, 1);

    clock = T0 + 20_000; // now the future one is due
    await s.tick();
    assert.equal(fired.length, 2);
  } finally { cleanup(); }
});

test("scheduler reschedules a cron intention to its next run", async () => {
  const { store, cleanup } = fresh();
  try {
    const fired: Intention[] = [];
    let clock = T0;
    const next = T0 + 3600_000;
    const s = schedulerWith(store, fired, () => clock, () => next);
    store.create({ title: "hourly", action: "tick", trigger: "cron", cronExpr: "0 * * * *", fireAt: T0 - 1, provenance: { origin: "operator" } });

    await s.tick();
    assert.equal(fired.length, 1);
    const row = store.list()[0]!;
    assert.equal(row.status, "pending"); // re-armed, not done
    assert.equal(row.fireAt, next);
  } finally { cleanup(); }
});

test("scheduler.fireEvent fires a matching event intention (as one-shot)", async () => {
  const { store, cleanup } = fresh();
  try {
    const fired: Intention[] = [];
    const s = schedulerWith(store, fired, () => T0);
    store.create({ title: "landlord", action: "flag", trigger: "event", eventMatch: { from: "landlord" }, provenance: { origin: "operator" } });

    await s.fireEvent({ channel: "email", from: "my landlord", provenance: { origin: "ingested" } });
    assert.equal(fired.length, 1);
    assert.equal(store.list()[0]!.status, "done");
  } finally { cleanup(); }
});

test("scheduler leaves a failed delivery re-armable (stays firing, then recovered)", async () => {
  const { store, cleanup } = fresh();
  try {
    let clock = T0;
    const s = new Scheduler({ store, now: () => clock, deliver: async () => { throw new Error("boom"); }, staleMs: 60_000 });
    once(store, T0 - 1);
    await s.tick();
    assert.equal(store.list()[0]!.status, "firing"); // not done — delivery threw

    clock = T0 + 120_000; // past staleMs (60s) → next tick recovers it
    const fired2: Intention[] = [];
    const s2 = new Scheduler({ store, now: () => clock, staleMs: 60_000, deliver: async (i) => { fired2.push(i); } });
    await s2.tick();
    assert.equal(fired2.length, 1); // recovered and re-fired
  } finally { cleanup(); }
});

// ─── tools ───

test("remind.create validates exactly one trigger and ISO/cron", () => {
  assert.equal(remindCreate.effect, "write");
  assert.equal(remindCreate.validate({ title: "t", action: "a" }).ok, false); // no trigger
  assert.equal(remindCreate.validate({ title: "t", action: "a", at: "5pm" }).ok, false); // bad date
  assert.equal(remindCreate.validate({ title: "t", action: "a", at: "2026-08-27T17:00:00Z", cron: "0 9 * * 1" }).ok, false); // two triggers
  assert.equal(remindCreate.validate({ title: "t", action: "a", cron: "not a cron" }).ok, false);
  const v = remindCreate.validate({ title: "t", action: "a", at: "2026-08-27T17:00:00Z" });
  assert.ok(v.ok);
});

test("remind.create + list + cancel round-trip through the tools", async () => {
  const { ctx, cleanup } = fresh();
  try {
    const created = await remindCreate.run({ title: "dentist", action: "remind to call the dentist", at: "2026-08-27T17:00:00Z" }, ctx);
    const id = (created.data as { id: string }).id;
    assert.match(created.summary, /saved "dentist"/);

    const listed = await remindList.run({ limit: 50 }, ctx);
    assert.match(listed.summary, /1 intention/);
    assert.equal((listed.data as { id: string }[])[0]!.id, id);

    const cancelled = await remindCancel.run({ id }, ctx);
    assert.match(cancelled.summary, /cancelled/);
  } finally { cleanup(); }
});

test("remind tools fail gracefully without prospective memory", async () => {
  const ctx: ToolContext = { sandbox: new Sandbox(tmpdir()) };
  await assert.rejects(remindList.run({ limit: 10 }, ctx), /not available/);
  await assert.rejects(remindCreate.run({ title: "t", action: "a", at: "2026-08-27T17:00:00Z" }, ctx), /not available/);
});
