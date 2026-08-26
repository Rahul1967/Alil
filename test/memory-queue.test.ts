import test from "node:test";
import assert from "node:assert/strict";
import { TurnQueue } from "../src/gateway/index.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A runner that blocks until it either finishes its timer or is aborted. */
function abortable(name: string, ms: number, log?: string[]): (signal: AbortSignal) => Promise<string> {
  return async (signal) => {
    log?.push(`${name}:start`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
      } else {
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }
    });
    log?.push(`${name}:${signal.aborted ? "aborted" : "end"}`);
    return signal.aborted ? `${name}:aborted` : name;
  };
}

test("turns execute one at a time (no overlap), FIFO by default", async () => {
  const q = new TurnQueue();
  const log: string[] = [];
  const a = q.submit(abortable("a", 30, log));
  const b = q.submit(abortable("b", 10, log));
  const results = await Promise.all([a, b]);
  assert.deepEqual(log, ["a:start", "a:end", "b:start", "b:end"]);
  assert.deepEqual(results, ["a", "b"]);
});

test("submitting while idle runs immediately", async () => {
  const q = new TurnQueue();
  assert.equal(q.busy, false);
  const r = await q.submit(async () => 42);
  assert.equal(r, 42);
  assert.equal(q.busy, false);
});

test("preemption aborts the in-flight turn and runs the urgent one next", async () => {
  const q = new TurnQueue();
  const log: string[] = [];
  const first = q.submit(abortable("first", 10_000, log)); // long-running
  await delay(15); // let it actually start
  assert.equal(q.busy, true);

  const urgent = q.submit(abortable("urgent", 5, log), { preempt: true });
  const [r1, r2] = await Promise.all([first, urgent]);

  assert.equal(r1, "first:aborted", "preempted turn observes the abort and settles");
  assert.equal(r2, "urgent", "urgent turn runs to completion");
  assert.deepEqual(log, ["first:start", "first:aborted", "urgent:start", "urgent:end"]);
});

test("a preempted turn's result is still delivered (auditable, not lost)", async () => {
  const q = new TurnQueue();
  const first = q.submit(abortable("t1", 10_000));
  await delay(15);
  const second = q.submit(async () => "t2", { preempt: true });
  const r1 = await first; // resolves, does not reject
  const r2 = await second;
  assert.equal(r1, "t1:aborted");
  assert.equal(r2, "t2");
});

test("preempt with nothing running just enqueues normally", async () => {
  const q = new TurnQueue();
  const r = await q.submit(async () => "solo", { preempt: true });
  assert.equal(r, "solo");
});

test("depth reflects turns waiting behind the running one", async () => {
  const q = new TurnQueue();
  const log: string[] = [];
  const a = q.submit(abortable("a", 30, log));
  await delay(5);
  q.submit(abortable("b", 5, log));
  q.submit(abortable("c", 5, log));
  assert.equal(q.depth, 2, "b and c wait behind a");
  await a;
});

test("a throwing runner rejects only its own submit, queue keeps draining", async () => {
  const q = new TurnQueue();
  const bad = q.submit(async () => {
    throw new Error("boom");
  });
  const good = q.submit(async () => "ok");
  await assert.rejects(bad, /boom/);
  assert.equal(await good, "ok");
});
