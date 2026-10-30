/**
 * The ledger must name who actually decided. A timed-out or unreachable approval is the harness
 * failing closed, not the operator saying no — recording it as `declined by operator` blames a
 * human who never acted. Every resolved approval also records how long it waited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyBoundary } from "../src/policy/boundary.ts";
import { StaticRuleSource } from "../src/policy/rules.ts";
import { ToolRegistry, Executor, Sandbox } from "../src/execution/index.ts";
import { GrantStore } from "../src/policy/index.ts";
import type { ApprovalPort, ApprovalDecision } from "../src/policy/index.ts";
import type { ProposedAction } from "../src/runtime/types.ts";

const write: ProposedAction = {
  action: {
    id: "a1", tool: "fs.write", args: { path: "out.md", content: "x" },
    effect: "write", reversible: true, risk: "medium", classified: false, provenance: { origin: "model" },
  },
};

async function run(decide: () => Promise<ApprovalDecision>) {
  const dir = await mkdtemp(join(tmpdir(), "alil-attr-"));
  await writeFile(join(dir, "notes.md"), "hello", "utf8");
  const events: Array<Record<string, unknown>> = [];
  const approvals: ApprovalPort = { request: decide };
  const boundary = new PolicyBoundary({
    rules: new StaticRuleSource({ mode: "default", rules: [{ kind: "ask", match: { effect: "write" }, note: "confirm writes" }] }),
    tools: new ToolRegistry(),
    hooks: [],
    executor: new Executor({ sandbox: new Sandbox(dir) }),
    audit: { append: (evt, fields = {}) => { events.push({ evt, ...fields }); return {}; } },
    grants: new GrantStore(),
    approvals,
    workspaceRoot: dir,
  });
  const result = await boundary.submit(write);
  return { rec: events.find((e) => e["evt"] === "policy")!, result };
}

test("an approval that timed out is recorded as a harness timeout, not an operator decline", async () => {
  const { rec, result } = await run(async () => ({ approved: false, outcome: "timeout", reason: "approval timed out" }));
  assert.equal(rec["resolution"], "timeout");
  assert.equal(rec["by"], "harness");
  assert.notEqual(rec["resolution"], "declined");
  assert.equal(rec["detail"], "approval timed out");
  assert.equal(result.outcome, "denied");
  assert.match(result.summary, /timed out/);
});

test("an approval channel that could not be reached is recorded as no-channel by the harness", async () => {
  const { rec } = await run(async () => ({ approved: false, outcome: "unreachable", reason: "couldn't reach Telegram" }));
  assert.equal(rec["resolution"], "no-channel");
  assert.equal(rec["by"], "harness");
});

test("a human decline is still recorded as declined by the operator", async () => {
  const { rec } = await run(async () => ({ approved: false, outcome: "declined", reason: "declined in the browser" }));
  assert.equal(rec["resolution"], "declined");
  assert.equal(rec["by"], "operator");
});

test("a decline with no stated outcome is not attributed to a human (adversarial: legacy port)", async () => {
  // A port that does not say who decided must not get a human's name on the record.
  const { rec } = await run(async () => ({ approved: false }));
  assert.equal(rec["resolution"], "declined");
  assert.equal(rec["by"], "unknown");
});

test("every resolution records how long the approval waited", async () => {
  const slow = (d: ApprovalDecision) => async () => { await new Promise((r) => setTimeout(r, 25)); return d; };
  for (const d of [{ approved: true }, { approved: false, outcome: "declined" as const }, { approved: false, outcome: "timeout" as const }]) {
    const { rec } = await run(slow(d));
    assert.equal(typeof rec["approvalWaitMs"], "number", `waitMs on ${String(rec["resolution"])}`);
    assert.ok((rec["approvalWaitMs"] as number) >= 20);
  }
  const { rec } = await run(async () => { throw new Error("port crashed"); });
  assert.equal(rec["resolution"], "denied:approval-error");
  assert.equal(rec["by"], "harness");
  assert.equal(typeof rec["approvalWaitMs"], "number");
});
