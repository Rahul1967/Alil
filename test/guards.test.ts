import { test } from "node:test";
import assert from "node:assert/strict";
import { Guards } from "../src/runtime/guards.ts";
import type { GuardLimits, Clock } from "../src/runtime/types.ts";
import type { ModelSpec } from "../src/providers/types.ts";

const spec: ModelSpec = {
  id: "mock-model",
  provider: "mock",
  displayName: "Mock",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
  pricing: { inputPerMTok: 1000, outputPerMTok: 1000 },
  capabilities: { tools: true, streaming: false, vision: false },
};

function limits(over: Partial<GuardLimits> = {}): GuardLimits {
  return {
    maxIterations: 10,
    maxWallClockMs: 120_000,
    maxTokens: 500_000,
    maxCostUsd: 5,
    stallWindow: 3,
    ...over,
  };
}

class FakeClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
}

test("iteration cap trips", () => {
  const g = new Guards(limits({ maxIterations: 2 }));
  assert.equal(g.check().halt, false); // 1
  assert.equal(g.check().halt, false); // 2
  const third = g.check(); // 3 > 2
  assert.equal(third.halt, true);
  assert.match(third.reason ?? "", /iteration cap/);
});

test("timeout trips", () => {
  const clock = new FakeClock();
  const g = new Guards(limits({ maxWallClockMs: 1000 }), clock);
  assert.equal(g.check().halt, false);
  clock.t = 1500;
  const out = g.check();
  assert.equal(out.halt, true);
  assert.match(out.reason ?? "", /timeout/);
});

test("token budget trips after usage", () => {
  const g = new Guards(limits({ maxTokens: 100 }));
  assert.equal(g.check().halt, false);
  g.recordUsage({ inputTokens: 80, outputTokens: 40 }, spec); // 120 > 100
  const out = g.check();
  assert.equal(out.halt, true);
  assert.match(out.reason ?? "", /token budget/);
});

test("cost budget trips after usage", () => {
  const g = new Guards(limits({ maxCostUsd: 0.1 }));
  assert.equal(g.check().halt, false);
  // 1000 in + 1000 out tokens at $1000/Mtok each = $2 total.
  g.recordUsage({ inputTokens: 1000, outputTokens: 1000 }, spec);
  const out = g.check();
  assert.equal(out.halt, true);
  assert.match(out.reason ?? "", /cost budget/);
});

test("stall trips on repeated identical tool signatures", () => {
  const g = new Guards(limits({ stallWindow: 3, maxIterations: 100 }));
  for (let i = 0; i < 3; i++) {
    g.check();
    g.recordToolSignatures(["fs.read({\"path\":\"/a\"})"]);
  }
  const out = g.check();
  assert.equal(out.halt, true);
  assert.match(out.reason ?? "", /stall/);
});

test("no-tool turns never count as a stall", () => {
  const g = new Guards(limits({ stallWindow: 2, maxIterations: 100 }));
  for (let i = 0; i < 5; i++) {
    g.check();
    g.recordToolSignatures([]); // empty signature
  }
  assert.equal(g.check().halt, false);
});
