import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyBoundary } from "../src/policy/boundary.ts";
import { StaticRuleSource } from "../src/policy/rules.ts";
import type { PolicyConfig } from "../src/policy/rules.ts";
import { credentialBlock } from "../src/policy/hooks/credential-block.ts";
import { ToolRegistry, Executor, Sandbox } from "../src/execution/index.ts";
import { GrantStore } from "../src/policy/index.ts";
import type { ApprovalPort } from "../src/policy/index.ts";
import type { ActionContract, Provenance } from "../src/core/types.ts";
import type { ProposedAction } from "../src/runtime/types.ts";

const tools = new ToolRegistry();
const config: PolicyConfig = {
  mode: "default",
  rules: [
    { kind: "deny", match: { pathGlob: "**/.env" }, note: "no env" },
    { kind: "ask", match: { effect: "write" }, note: "confirm writes" },
    { kind: "allow", match: { tool: "fs.read" }, note: "reads ok" },
  ],
};

function action(over: Partial<ActionContract> = {}): ProposedAction {
  return {
    action: {
      id: "a1", tool: "fs.read", args: { path: "notes.md" },
      effect: "execute", reversible: false, risk: "high", classified: false,
      provenance: { origin: "model" } as Provenance, ...over,
    },
  };
}

/** A boundary whose decisions are captured into `events`. */
async function boundaryWithAudit(opts: { approvals?: ApprovalPort } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "alil-audit-"));
  await writeFile(join(dir, "notes.md"), "hello", "utf8");
  const events: Array<Record<string, unknown>> = [];
  const audit = { append: (evt: string, fields: Record<string, unknown> = {}) => { events.push({ evt, ...fields }); return {}; } };
  const boundary = new PolicyBoundary({
    rules: new StaticRuleSource(config),
    tools,
    hooks: [credentialBlock],
    executor: new Executor({ sandbox: new Sandbox(dir) }),
    audit,
    grants: new GrantStore(),
    workspaceRoot: dir,
    ...(opts.approvals ? { approvals: opts.approvals } : {}),
  });
  return { boundary, events, dir };
}

test("allow decision is audited with resolution executed", async () => {
  const { boundary, events } = await boundaryWithAudit();
  await boundary.submit(action({ tool: "fs.read", args: { path: "notes.md" } }));
  const rec = events.find((e) => e["evt"] === "policy")!;
  assert.equal(rec["decision"], "allow");
  assert.equal(rec["resolution"], "executed");
  assert.equal(rec["tool"], "fs.read");
});

test("credential-block deny is audited with its source", async () => {
  const { boundary, events } = await boundaryWithAudit();
  await boundary.submit(action({ tool: "fs.read", args: { path: ".env" } }));
  const rec = events.find((e) => e["evt"] === "policy")!;
  assert.equal(rec["decision"], "deny");
  assert.equal(rec["decidedBy"], "hook:credential-block");
  assert.equal(rec["resolution"], "denied");
});

test("ask that fails closed (no approver) is audited", async () => {
  const { boundary, events } = await boundaryWithAudit();
  await boundary.submit(action({ tool: "fs.write", args: { path: "out.md", content: "x" } }));
  const rec = events.find((e) => e["evt"] === "policy")!;
  assert.equal(rec["decision"], "ask");
  assert.equal(rec["resolution"], "denied:no-approval-channel");
});

test("provenance escalation is audited as tainted, decidedBy provenance", async () => {
  const { boundary, events } = await boundaryWithAudit();
  // fs.read is normally allowed; tainted ⇒ escalated to ask ⇒ (no approver) denied.
  await boundary.submit(action({ tool: "fs.read", args: { path: "notes.md" }, provenance: { origin: "model", taintedBy: ["web:evil"] } }));
  const rec = events.find((e) => e["evt"] === "policy")!;
  assert.equal(rec["decision"], "ask");
  assert.equal(rec["decidedBy"], "provenance");
  assert.equal(rec["tainted"], true);
  assert.deepEqual(rec["taintedBy"], ["web:evil"]);
});

test("approved write is audited with resolution approved", async () => {
  const autoApprove: ApprovalPort = { async request() { return { approved: true }; } };
  const { boundary, events } = await boundaryWithAudit({ approvals: autoApprove });
  await boundary.submit(action({ tool: "fs.write", args: { path: "out.md", content: "x" } }));
  const rec = events.find((e) => e["evt"] === "policy")!;
  assert.equal(rec["decision"], "ask");
  assert.equal(rec["resolution"], "approved");
});

test("declined action is audited as declined", async () => {
  const deny: ApprovalPort = { async request() { return { approved: false, reason: "no" }; } };
  const { boundary, events } = await boundaryWithAudit({ approvals: deny });
  await boundary.submit(action({ tool: "fs.write", args: { path: "out.md", content: "x" } }));
  const rec = events.find((e) => e["evt"] === "policy")!;
  assert.equal(rec["resolution"], "declined");
});

test("audit never logs full args — preview is bounded", async () => {
  const { boundary, events } = await boundaryWithAudit();
  const big = "z".repeat(5000);
  await boundary.submit(action({ tool: "fs.write", args: { path: "out.md", content: big } }));
  const rec = events.find((e) => e["evt"] === "policy")!;
  assert.ok((rec["argsPreview"] as string).length <= 200, "args preview is truncated");
});
