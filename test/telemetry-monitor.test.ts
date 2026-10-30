/**
 * The invariant monitor alerts only on hard failures: a broken invariant fires once (then again
 * only after the repeat window), its recovery sends `resolved`, matching events fire rate-limited
 * per key, and a failing delivery is recorded rather than lost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Telemetry, MemorySink, InvariantMonitor } from "../src/telemetry/index.ts";
import type { Alert } from "../src/telemetry/index.ts";

function setup(opts: { ok?: () => boolean; repeatMs?: number; deliver?: (a: Alert) => void } = {}) {
  let now = 0;
  const sink = new MemorySink();
  const tel = new Telemetry({ sink, process: "test" });
  const alerts: Alert[] = [];
  let ok = true;
  const mon = new InvariantMonitor({
    telemetry: tel,
    now: () => now,
    repeatMs: opts.repeatMs ?? 1000,
    invariants: [{ id: "ledger.verify", describe: "the audit ledger verifies", check: () => ({ ok: opts.ok ? opts.ok() : ok, detail: "broken at seq 7" }) }],
    rules: [{
      id: "binding.mismatch",
      describe: "an approved action never changes before it runs",
      match: (e) => (e.kind === "audit" && e["resolution"] === "denied:binding-mismatch" ? `tool ${String(e["tool"])}` : null),
      key: (e) => String(e["tool"]),
    }],
    deliver: opts.deliver ?? ((a) => { alerts.push(a); }),
  });
  return { mon, tel, sink, alerts, setOk: (v: boolean) => { ok = v; }, advance: (ms: number) => { now += ms; } };
}

test("a failing invariant fires once, repeats only after the window, and resolves", async () => {
  const s = setup();
  s.setOk(false);
  await s.mon.checkNow();
  await s.mon.checkNow();
  assert.equal(s.alerts.length, 1, "no repeat inside the window");
  assert.equal(s.alerts[0]!.state, "firing");
  assert.equal(s.alerts[0]!.detail, "broken at seq 7");
  s.advance(1000);
  await s.mon.checkNow();
  assert.equal(s.alerts.length, 2, "repeats after the window while still failing");
  s.setOk(true);
  await s.mon.checkNow();
  assert.equal(s.alerts.at(-1)!.state, "resolved");
  assert.deepEqual(s.mon.failing(), []);
});

test("a passing invariant never alerts", async () => {
  const s = setup();
  await s.mon.checkNow();
  assert.equal(s.alerts.length, 0);
});

test("a check that throws counts as failing (fail loud, not silent)", async () => {
  const s = setup({ ok: () => { throw new Error("cannot read ledger"); } });
  await s.mon.checkNow();
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0]!.detail ?? "", /cannot read ledger/);
});

test("event rules fire on matching events, rate-limited per key", () => {
  const s = setup();
  s.tel.emit("audit", { resolution: "denied:binding-mismatch", tool: "fs.write" });
  s.tel.emit("audit", { resolution: "denied:binding-mismatch", tool: "fs.write" });
  s.tel.emit("audit", { resolution: "denied:binding-mismatch", tool: "shell" });
  s.tel.emit("audit", { resolution: "approved", tool: "shell" });
  assert.deepEqual(s.alerts.map((a) => a.detail), ["tool fs.write", "tool shell"]);
});

test("alerts are recorded as telemetry events, and a failing delivery is reported", async () => {
  const s = setup({ deliver: () => { throw new Error("telegram down"); } });
  s.setOk(false);
  await s.mon.checkNow();
  assert.ok(s.sink.events.some((e) => e.kind === "alert" && e["id"] === "ledger.verify"));
  assert.ok(s.sink.events.some((e) => e.kind === "error" && e["where"] === "monitor.deliver"));
});
