import { test } from "node:test";
import assert from "node:assert/strict";

import { EventBus } from "../src/gateway/ingest/event-bus.ts";
import { RateLimiter } from "../src/gateway/ingest/rate-limiter.ts";
import { PollingSource } from "../src/gateway/ingest/polling-source.ts";
import { keywordTrigger, thresholdTrigger } from "../src/gateway/ingest/triggers.ts";
import type { WakeRequest } from "../src/gateway/ingest/types.ts";
import { WorldStore } from "../src/world/store.ts";
import type { IncomingEvent } from "../src/memory/types.ts";

let t = 1000;
const clock = () => t;
function evt(over: Partial<IncomingEvent> = {}): IncomingEvent {
  return { channel: "email", provenance: { origin: "ingested" }, ...over };
}

// ─── world recording + taint ───
test("ingest records every event into the world-model as tainted", async () => {
  const world = new WorldStore({ now: clock });
  const bus = new EventBus({ world });
  await bus.ingest(evt({ type: "mail", from: "landlord", subject: "rent due" }));
  const events = world.snapshot().events;
  assert.equal(events.length, 1);
  assert.match(events[0]!.summary, /landlord/);
  assert.equal(events[0]!.provenance.origin, "ingested"); // stays untrusted
});

test("an event without taint is forced to ingested (no trusted-looking injection)", async () => {
  const world = new WorldStore({ now: clock });
  const bus = new EventBus({ world });
  // A misbehaving source claims operator origin — the bus must not honor it.
  await bus.ingest({ channel: "webhook", provenance: { origin: "operator" }, text: "hi" });
  const p = world.snapshot().events[0]!.provenance;
  assert.equal(p.origin, "ingested");
  assert.deepEqual(p.taintedBy, ["channel:webhook"]);
});

// ─── prospective forwarding ───
test("ingest forwards the event to the scheduler for prospective intentions", async () => {
  const seen: IncomingEvent[] = [];
  const bus = new EventBus({ scheduler: { fireEvent: async (e) => { seen.push(e); } } });
  await bus.ingest(evt({ from: "boss" }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.from, "boss");
});

// ─── triggers → unprompted wake ───
test("a matching trigger wakes an unprompted turn with an instruction", async () => {
  const wakes: WakeRequest[] = [];
  const bus = new EventBus({
    triggers: [keywordTrigger("urgent-watch", ["urgent", "asap"])],
    onWake: async (w) => { wakes.push(w); },
  });
  await bus.ingest(evt({ subject: "URGENT: server down" }));
  await bus.ingest(evt({ subject: "weekly newsletter" })); // no keyword → no wake
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.rule, "urgent-watch");
  assert.match(wakes[0]!.instruction, /urgent-watch/);
  assert.equal(wakes[0]!.event.provenance.origin, "ingested");
});

test("threshold trigger fires on a crossing and stays quiet otherwise", async () => {
  const wakes: WakeRequest[] = [];
  const bus = new EventBus({
    triggers: [thresholdTrigger("battery-low", "suit.battery", { below: 20 })],
    onWake: async (w) => { wakes.push(w); },
  });
  await bus.ingest(evt({ type: "telemetry", text: "battery at 12 percent" })); // 12 < 20 → wake
  await bus.ingest(evt({ type: "telemetry", text: "battery at 80 percent" })); // no
  assert.equal(wakes.length, 1);
  assert.match(wakes[0]!.instruction, /below 20/);
});

// ─── rate limiting ───
test("rate limiter caps unprompted wakes and audits throttles", async () => {
  const wakes: WakeRequest[] = [];
  const audits: string[] = [];
  const bus = new EventBus({
    triggers: [keywordTrigger("any", ["ping"])],
    onWake: async (w) => { wakes.push(w); },
    limiter: new RateLimiter(2, 60_000, clock),
    audit: { append: (evt) => { audits.push(evt); return {}; } },
  });
  for (let i = 0; i < 5; i++) await bus.ingest(evt({ text: "ping" }));
  assert.equal(wakes.length, 2, "only 2 wakes allowed in the window");
  assert.equal(audits.filter((a) => a === "wake.throttled").length, 3, "the other 3 are throttled + audited");
});

test("RateLimiter refills after the window passes", () => {
  const limiter = new RateLimiter(1, 100, clock);
  t = 1000;
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), false); // window full
  t = 1200; // > 100ms later
  assert.equal(limiter.allow(), true);
});

// ─── source adapter ───
test("PollingSource emits polled events tagged by source name", async () => {
  const src = new PollingSource({ name: "cron-mail", intervalMs: 10_000, poll: async () => [evt({ text: "new mail" })] });
  const out: IncomingEvent[] = [];
  await src.pollOnce((e) => out.push(e));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.provenance.taintedBy, ["source:cron-mail"]);
  src.stop();
});

// ─── end-to-end: source → bus → world + wake ───
test("end to end: a polled event lands in the world and wakes a turn", async () => {
  const world = new WorldStore({ now: clock });
  const wakes: WakeRequest[] = [];
  const bus = new EventBus({ world, triggers: [keywordTrigger("alert", ["alert"])], onWake: async (w) => { wakes.push(w); } });
  const src = new PollingSource({ name: "sensors", intervalMs: 10_000, poll: async () => [evt({ type: "sensor", text: "ALERT: pressure spike" })] });
  await src.pollOnce((e) => void bus.ingest(e));
  // allow the async ingest microtasks to settle
  await new Promise((r) => setImmediate(r));
  assert.equal(world.snapshot().events.length, 1);
  assert.equal(wakes.length, 1);
});
