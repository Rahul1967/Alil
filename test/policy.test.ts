import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classify } from "../src/policy/classifier.ts";
import { evaluate } from "../src/policy/engine.ts";
import { escalateForProvenance } from "../src/policy/provenance-check.ts";
import { credentialBlock } from "../src/policy/hooks/credential-block.ts";
import { StaticRuleSource } from "../src/policy/rules.ts";
import type { PolicyConfig } from "../src/policy/rules.ts";
import { PolicyBoundary } from "../src/policy/boundary.ts";
import { ToolRegistry } from "../src/execution/tools/registry.ts";
import { Executor } from "../src/execution/executor.ts";
import { Sandbox } from "../src/execution/sandbox.ts";
import type { ActionContract, Provenance } from "../src/core/types.ts";
import type { ProposedAction } from "../src/runtime/types.ts";

// ─── fixtures ───
const tools = new ToolRegistry();

function action(over: Partial<ActionContract> = {}): ActionContract {
  return {
    id: "act_1",
    tool: "fs.read",
    args: { path: "notes.md" },
    effect: "execute", // placeholder as the brain would send
    reversible: false,
    risk: "high",
    classified: false,
    provenance: { origin: "model" },
    ...over,
  };
}

const config: PolicyConfig = {
  mode: "default",
  rules: [
    { kind: "deny", match: { pathGlob: "**/.env" }, note: "no env" },
    { kind: "ask", match: { effect: "write" }, note: "confirm writes" },
    { kind: "ask", match: { minRisk: "high" }, note: "confirm high risk" },
    { kind: "allow", match: { tool: "fs.read" }, note: "reads ok" },
  ],
};

// ─── classifier ───
test("classifier fills effect/risk from the tool and marks classified", () => {
  const { action: a, unknown } = classify(action({ tool: "fs.write", args: { path: "x", content: "y" } }), tools);
  assert.equal(unknown, false);
  assert.equal(a.effect, "write");
  assert.equal(a.risk, "medium");
  assert.equal(a.classified, true);
});

test("classifier flags an unknown tool", () => {
  const { unknown } = classify(action({ tool: "no.such.tool" }), tools);
  assert.equal(unknown, true);
});

// ─── engine precedence ───
test("deny beats ask beats allow", () => {
  // fs.read of .env: allow rule matches, but deny rule wins.
  const a = classify(action({ tool: "fs.read", args: { path: ".env" } }), tools).action;
  const v = evaluate(a, config, []); // no hooks here — testing rule precedence
  assert.equal(v.decision, "deny");
});

test("fs.read in workspace is allowed under default mode", () => {
  const a = classify(action({ tool: "fs.read", args: { path: "notes.md" } }), tools).action;
  const v = evaluate(a, config, []);
  assert.equal(v.decision, "allow");
});

test("fs.write asks under default mode", () => {
  const a = classify(action({ tool: "fs.write", args: { path: "notes.md", content: "hi" } }), tools).action;
  const v = evaluate(a, config, []);
  assert.equal(v.decision, "ask");
});

// ─── credential hook ───
test("credential hook denies .env read even when an allow rule matches", () => {
  const a = classify(action({ tool: "fs.read", args: { path: "config/.env" } }), tools).action;
  const v = evaluate(a, config, [credentialBlock]);
  assert.equal(v.decision, "deny");
  assert.equal(v.decidedBy, "hook:credential-block");
});

// ─── provenance escalation ───
test("tainted (ingested) allow escalates to ask", () => {
  const ingested: Provenance = { origin: "ingested" };
  const a = classify(action({ tool: "fs.read", args: { path: "notes.md" }, provenance: ingested }), tools).action;
  const base = evaluate(a, config, []);
  assert.equal(base.decision, "allow");
  const escalated = escalateForProvenance(base, a);
  assert.equal(escalated.decision, "ask");
});

test("tainted ask stays ask for low/medium risk (human stays in the loop)", () => {
  // A tainted, medium-risk action that's already `ask` must NOT become a hard deny — the operator
  // must still be able to approve legitimate follow-up work (e.g. searching after reading a page).
  const a = classify(action({ tool: "fs.write", args: { path: "n.md", content: "x" }, provenance: { origin: "ingested" } }), tools).action;
  const escalated = escalateForProvenance({ decision: "ask", reason: "write", decidedBy: "rule" }, a);
  assert.equal(escalated.decision, "ask");
  assert.equal(escalated.decidedBy, "provenance");
});

test("tainted ask becomes deny only for high/critical risk (genuinely dangerous)", () => {
  const a: ActionContract = {
    id: "x", tool: "shell", args: { command: "rm -rf x" },
    effect: "execute", reversible: false, risk: "high", classified: true,
    provenance: { origin: "ingested" },
  };
  const escalated = escalateForProvenance({ decision: "ask", reason: "exec", decidedBy: "rule" }, a);
  assert.equal(escalated.decision, "deny");
});

// ─── end-to-end boundary + real executor (temp workspace) ───
test("boundary: allowed read executes; write is asked (stub-denied)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-ws-"));
  try {
    await writeFile(join(dir, "notes.md"), "hello world", "utf8");
    const boundary = new PolicyBoundary({
      rules: new StaticRuleSource(config),
      tools,
      hooks: [credentialBlock],
      executor: new Executor({ sandbox: new Sandbox(dir) }),
    });

    const read: ProposedAction = { action: action({ id: "r1", tool: "fs.read", args: { path: "notes.md" } }) };
    const rr = await boundary.submit(read);
    assert.equal(rr.outcome, "ok");
    assert.equal(rr.data, "hello world");

    const write: ProposedAction = { action: action({ id: "w1", tool: "fs.write", args: { path: "out.md", content: "x" } }) };
    const wr = await boundary.submit(write);
    assert.equal(wr.outcome, "denied");
    assert.match(wr.summary, /approval required/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── sandbox jail ───
test("boundary: path escaping the workspace is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-ws-"));
  try {
    // Allow reads of any path so we reach the executor, then the sandbox must reject it.
    const openCfg: PolicyConfig = { mode: "auto", rules: [] };
    const boundary = new PolicyBoundary({
      rules: new StaticRuleSource(openCfg),
      tools,
      hooks: [],
      executor: new Executor({ sandbox: new Sandbox(dir) }),
    });
    const esc: ProposedAction = { action: action({ id: "e1", tool: "fs.read", args: { path: "../../etc/passwd" } }) };
    const r = await boundary.submit(esc);
    assert.equal(r.outcome, "error");
    assert.match(r.summary, /escapes the workspace/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── idempotency ───
test("executor writes once for a repeated action id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-ws-"));
  try {
    const exec = new Executor({ sandbox: new Sandbox(dir) });
    const a = action({ id: "same", tool: "fs.write", args: { path: "f.md", content: "first" } });
    const write = tools.get("fs.write")!;
    const r1 = await exec.execute(a, write);
    // Second call with the same id but different content must NOT re-run.
    const a2 = action({ id: "same", tool: "fs.write", args: { path: "f.md", content: "SECOND" } });
    const r2 = await exec.execute(a2, write);
    assert.equal(r1.outcome, "ok");
    assert.equal(r2.summary, r1.summary); // cached result returned
    assert.equal(await readFile(join(dir, "f.md"), "utf8"), "first");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
