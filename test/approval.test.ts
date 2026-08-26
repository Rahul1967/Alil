import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GrantStore } from "../src/policy/approval/grants.ts";
import { captureBinding, verifyBinding } from "../src/policy/approval/binding.ts";
import type { ApprovalPort, ApprovalRequest, ApprovalDecision } from "../src/policy/approval/types.ts";
import { PolicyBoundary, StaticRuleSource, credentialBlock } from "../src/policy/index.ts";
import type { PolicyConfig } from "../src/policy/index.ts";
import { ToolRegistry, Executor, Sandbox } from "../src/execution/index.ts";
import type { Clock } from "../src/runtime/types.ts";
import type { ActionContract, Provenance } from "../src/core/types.ts";
import type { ProposedAction } from "../src/runtime/types.ts";

const tools = new ToolRegistry();
const config: PolicyConfig = {
  mode: "default",
  rules: [
    { kind: "ask", match: { effect: "write" }, note: "confirm writes" },
    { kind: "allow", match: { tool: "fs.read" }, note: "reads ok" },
  ],
};

function writeAction(id: string, path: string, content: string): ProposedAction {
  return {
    action: {
      id, tool: "fs.write", args: { path, content },
      effect: "execute", reversible: false, risk: "high", classified: false,
      provenance: { origin: "model" },
    },
  };
}

class FakeClock implements Clock {
  t = 1_000_000;
  now(): number {
    return this.t;
  }
}

const autoApprove: ApprovalPort = { async request() { return { approved: true }; } };
const autoDeny: ApprovalPort = { async request() { return { approved: false, reason: "no" }; } };

// ─── GrantStore ───
test("grant matches, consumes, expires", () => {
  const clock = new FakeClock();
  const store = new GrantStore(clock);
  const a: ActionContract = {
    id: "x", tool: "fs.write", args: { path: "a.md" },
    effect: "write", reversible: false, risk: "medium", classified: true,
    provenance: { origin: "model" },
  };
  assert.equal(store.match(a), undefined);
  store.mint({ tool: "fs.write", maxUses: 2, ttlMs: 1000, task: "t" });
  const g = store.match(a);
  assert.ok(g);
  store.consume(g!.id);
  store.consume(g!.id); // now 0 uses
  assert.equal(store.match(a), undefined);

  // fresh grant, then expire by advancing the clock
  store.mint({ tool: "fs.write", maxUses: 5, ttlMs: 1000, task: "t" });
  assert.ok(store.match(a));
  clock.t += 2000;
  assert.equal(store.match(a), undefined);
});

// ─── binding ───
test("binding verify fails when args drift", () => {
  const a: ActionContract = {
    id: "x", tool: "fs.write", args: { path: "a.md", content: "one" },
    effect: "write", reversible: false, risk: "medium", classified: true,
    provenance: { origin: "model" },
  };
  const b = captureBinding(a);
  assert.equal(verifyBinding(b, a), true);
  a.args["content"] = "TWO"; // drift
  assert.equal(verifyBinding(b, a), false);
});

// ─── boundary: approval flows ───
test("ask → approved → write executes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-appr-"));
  try {
    const boundary = new PolicyBoundary({
      rules: new StaticRuleSource(config), tools, hooks: [credentialBlock],
      executor: new Executor({ sandbox: new Sandbox(dir) }),
      approvals: autoApprove, grants: new GrantStore(),
    });
    const r = await boundary.submit(writeAction("w1", "out.md", "hello"));
    assert.equal(r.outcome, "ok");
    assert.equal(await readFile(join(dir, "out.md"), "utf8"), "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ask → declined → not executed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-appr-"));
  try {
    const boundary = new PolicyBoundary({
      rules: new StaticRuleSource(config), tools, hooks: [credentialBlock],
      executor: new Executor({ sandbox: new Sandbox(dir) }),
      approvals: autoDeny, grants: new GrantStore(),
    });
    const r = await boundary.submit(writeAction("w1", "out.md", "hello"));
    assert.equal(r.outcome, "denied");
    assert.match(r.summary, /declined by operator/);
    await assert.rejects(readFile(join(dir, "out.md"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grant covers a second matching action without re-prompting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-appr-"));
  try {
    let prompts = 0;
    const grantOnce: ApprovalPort = {
      async request(): Promise<ApprovalDecision> {
        prompts += 1;
        return { approved: true, scope: { tool: "fs.write", maxUses: 5, ttlMs: 60_000, task: "t" } };
      },
    };
    const boundary = new PolicyBoundary({
      rules: new StaticRuleSource(config), tools, hooks: [credentialBlock],
      executor: new Executor({ sandbox: new Sandbox(dir) }),
      approvals: grantOnce, grants: new GrantStore(),
    });
    await boundary.submit(writeAction("w1", "a.md", "1"));
    await boundary.submit(writeAction("w2", "b.md", "2"));
    assert.equal(prompts, 1); // second write covered by the grant
    assert.equal(await readFile(join(dir, "b.md"), "utf8"), "2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a grant never covers an execute action — shell re-prompts every time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-appr-"));
  try {
    let prompts = 0;
    // Approves AND tries to mint a broad shell grant — which must be ignored for execute.
    const grantingApprove: ApprovalPort = {
      async request(): Promise<ApprovalDecision> {
        prompts += 1;
        return { approved: true, scope: { tool: "shell", maxUses: 5, ttlMs: 60_000, task: "t" } };
      },
    };
    const execConfig: PolicyConfig = {
      mode: "default",
      rules: [{ kind: "ask", match: { effect: "execute" }, note: "confirm exec" }],
    };
    const boundary = new PolicyBoundary({
      rules: new StaticRuleSource(execConfig), tools, hooks: [credentialBlock],
      executor: new Executor({ sandbox: new Sandbox(dir) }),
      approvals: grantingApprove, grants: new GrantStore(),
    });
    const shellAction = (id: string): ProposedAction => ({
      action: {
        id, tool: "shell", args: { command: "echo hi" },
        effect: "execute", reversible: false, risk: "medium", classified: false,
        provenance: { origin: "operator" },
      },
    });
    await boundary.submit(shellAction("s1"));
    await boundary.submit(shellAction("s2"));
    assert.equal(prompts, 2); // each execute re-prompts; the grant never covers it
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal deny (credential hook) never reaches approval", async () => {
  let prompted = false;
  const spy: ApprovalPort = { async request() { prompted = true; return { approved: true }; } };
  const boundary = new PolicyBoundary({
    rules: new StaticRuleSource(config), tools, hooks: [credentialBlock],
    executor: new Executor({ sandbox: new Sandbox("workspace") }),
    approvals: spy, grants: new GrantStore(),
  });
  const r = await boundary.submit(writeAction("w1", ".env", "x"));
  assert.equal(r.outcome, "denied");
  assert.equal(prompted, false); // credential deny is terminal
});

test("tainted action that escalates to deny never reaches approval", async () => {
  let prompted = false;
  const spy: ApprovalPort = { async request() { prompted = true; return { approved: true }; } };
  const boundary = new PolicyBoundary({
    rules: new StaticRuleSource(config), tools, hooks: [],
    executor: new Executor({ sandbox: new Sandbox("workspace") }),
    approvals: spy, grants: new GrantStore(),
  });
  const ingested: Provenance = { origin: "ingested" };
  // write is ask → tainted escalates ask→deny
  const a = writeAction("w1", "out.md", "x");
  a.action.provenance = ingested;
  const r = await boundary.submit(a);
  assert.equal(r.outcome, "denied");
  assert.equal(prompted, false);
} );

test("no approval port ⇒ ask fails closed", async () => {
  const boundary = new PolicyBoundary({
    rules: new StaticRuleSource(config), tools, hooks: [],
    executor: new Executor({ sandbox: new Sandbox("workspace") }),
    // no approvals
  });
  const r = await boundary.submit(writeAction("w1", "out.md", "x"));
  assert.equal(r.outcome, "denied");
  assert.match(r.summary, /HITL not wired/);
});
