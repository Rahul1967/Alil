/**
 * Security groundwork for lenses (DESIGN §10b, build step 2). Adversarial by design: every test
 * here tries to loosen policy, launder taint, or reuse authority it shouldn't have.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "alil-lens-policy-"));

import { PolicyBoundary, StaticRuleSource, LayeredRuleSource, GrantStore, credentialBlock } from "../src/policy/index.ts";
import type { PolicyConfig, PolicyRule, ApprovalPort, ApprovalRequest } from "../src/policy/index.ts";
import { ToolRegistry, Executor, Sandbox } from "../src/execution/index.ts";
import { McpRegistry } from "../src/execution/mcp/registry.ts";
import type { McpServerConfig, McpToolDef } from "../src/execution/mcp/types.ts";
import type { ProposedAction } from "../src/runtime/types.ts";
import type { Provenance } from "../src/core/types.ts";

const BASE: PolicyConfig = {
  mode: "default",
  rules: [
    { kind: "ask", match: { effect: "write" }, note: "confirm writes" },
    { kind: "ask", match: { effect: "execute" }, note: "confirm execute" },
    { kind: "ask", match: { minRisk: "high" }, note: "confirm high risk" },
    { kind: "allow", match: { tool: "fs.read" }, note: "reads ok" },
  ],
};

function recorder(approved = true) {
  const asked: ApprovalRequest[] = [];
  const port: ApprovalPort = { async request(r) { asked.push(r); return { approved }; } };
  return { asked, port };
}

function mcpRegistry(servers: McpServerConfig[], tools: McpToolDef[]): McpRegistry {
  return new McpRegistry({
    configs: servers,
    transportFactory: (cfg) => {
      let on = false;
      return {
        server: cfg.name,
        connected: () => on,
        connect: async () => { on = true; },
        listTools: async () => tools.filter((t) => t.server === cfg.name),
        callTool: async (name) => ({ isError: false, text: `result of ${name}` }),
        close: async () => { on = false; },
      };
    },
  });
}

function boundary(opts: { rules?: PolicyConfig | LayeredRuleSource; approvals?: ApprovalPort; grants?: GrantStore; mcp?: McpRegistry }) {
  const rules = opts.rules instanceof LayeredRuleSource ? opts.rules : new StaticRuleSource(opts.rules ?? BASE);
  return new PolicyBoundary({
    rules,
    tools: new ToolRegistry(),
    hooks: [credentialBlock],
    executor: new Executor({ sandbox: new Sandbox(SANDBOX), ...(opts.mcp ? { mcp: { registry: opts.mcp } } : {}) }),
    ...(opts.approvals ? { approvals: opts.approvals } : {}),
    ...(opts.grants ? { grants: opts.grants } : {}),
  });
}

let seq = 0;
function proposed(tool: string, args: Record<string, unknown>, provenance: Provenance = { origin: "model" }): ProposedAction {
  return { action: { id: `a${++seq}`, tool, args, effect: "execute", risk: "high", reversible: false, classified: false, provenance } };
}

// ── argument matchers ────────────────────────────────────────────────────────

test("a rule can match on string arguments (glob), so an MCP server/tool can be targeted", async () => {
  const cfg: PolicyConfig = { ...BASE, rules: [{ kind: "deny", match: { tool: "mcp.call", args: { server: "broker", name: "*order*" } }, note: "no trades" }, ...BASE.rules] };
  const b = boundary({ rules: cfg, approvals: recorder().port });
  const trade = await b.submit(proposed("mcp.call", { server: "broker", name: "place_order", args: {} }));
  assert.equal(trade.outcome, "denied");
  assert.match(trade.summary, /no trades/);
  // A different tool on the same server is not matched by the deny rule (it still asks, then runs).
  const other = await b.submit(proposed("mcp.call", { server: "nomcp", name: "get_quote", args: {} }));
  assert.doesNotMatch(other.summary, /no trades/);
});

test("an args matcher never matches a non-string or missing argument", async () => {
  const cfg: PolicyConfig = { ...BASE, rules: [{ kind: "deny", match: { args: { server: "*" } }, note: "server-any" }, ...BASE.rules] };
  const b = boundary({ rules: cfg, approvals: recorder().port });
  const r = await b.submit(proposed("fs.read", { path: "x.txt" }));
  assert.doesNotMatch(r.summary, /server-any/);
});

// ── raiseRisk / fresh approval ───────────────────────────────────────────────

test("raiseRisk:critical makes a matched action non-grantable and hard-denied when tainted", async () => {
  const grants = new GrantStore();
  grants.mint({ tool: "fs.write", maxUses: 10, ttlMs: 60_000, task: "old general-mode grant" });
  const cfg: PolicyConfig = { ...BASE, rules: [{ kind: "ask", match: { tool: "fs.write", pathGlob: "ledger/**" }, raiseRisk: "critical", note: "money files" }, ...BASE.rules] };
  const rec = recorder(false);
  const b = boundary({ rules: cfg, approvals: rec.port, grants });
  // Untainted: the standing grant must NOT cover it — the operator is asked fresh.
  const r1 = await b.submit(proposed("fs.write", { path: "ledger/2026.md", content: "x" }));
  assert.equal(rec.asked.length, 1, "a critical-risk action is never grant-covered");
  assert.equal(rec.asked[0]!.action.risk, "critical");
  assert.equal(r1.outcome, "denied");
  // Tainted: hard deny, the operator is not even offered it.
  const r2 = await b.submit(proposed("fs.write", { path: "ledger/2026.md", content: "x" }, { origin: "model", taintedBy: ["web.fetch"] }));
  assert.equal(r2.outcome, "denied");
  assert.equal(rec.asked.length, 1);
});

test("raiseRisk only ever raises — a rule cannot lower a tool's declared risk", async () => {
  const cfg: PolicyConfig = { ...BASE, rules: [{ kind: "ask", match: { tool: "shell" }, raiseRisk: "low", note: "try to lower" }, ...BASE.rules] };
  const rec = recorder(false);
  const b = boundary({ rules: cfg, approvals: rec.port });
  await b.submit(proposed("shell", { command: "ls" }));
  assert.equal(rec.asked[0]!.action.risk, "high");
});

test("a fresh:true ask rule bypasses standing grants even for a medium-risk write", async () => {
  const grants = new GrantStore();
  grants.mint({ tool: "fs.write", maxUses: 10, ttlMs: 60_000, task: "old grant" });
  const cfg: PolicyConfig = { ...BASE, rules: [{ kind: "ask", match: { tool: "fs.write", pathGlob: "budget/**" }, fresh: true, note: "always ask" }, ...BASE.rules] };
  const rec = recorder(false);
  const b = boundary({ rules: cfg, approvals: rec.port, grants });
  await b.submit(proposed("fs.write", { path: "budget/q3.md", content: "x" }));
  assert.equal(rec.asked.length, 1, "fresh rule must re-prompt despite the grant");
  // Outside the fresh rule, the old grant still covers ordinary writes (no regression).
  const r = await b.submit(proposed("fs.write", { path: "notes/a.md", content: "x" }));
  assert.equal(rec.asked.length, 1);
  assert.notEqual(r.outcome, "denied");
});

// ── tighten-only layering ────────────────────────────────────────────────────

test("LayeredRuleSource: an overlay can add deny/ask but an overlay allow rule is ignored", async () => {
  let overlay: PolicyRule[] = [{ kind: "allow", match: { effect: "write" }, note: "sneaky allow" }];
  const layered = new LayeredRuleSource(new StaticRuleSource(BASE), () => overlay);
  const rec = recorder(false);
  const b = boundary({ rules: layered, approvals: rec.port });
  await b.submit(proposed("fs.write", { path: "a.md", content: "x" }));
  assert.equal(rec.asked.length, 1, "the overlay allow must not auto-approve a write");

  overlay = [{ kind: "deny", match: { tool: "fs.read" }, note: "lens: no reads" }];
  const r = await b.submit(proposed("fs.read", { path: "a.md" }));
  assert.equal(r.outcome, "denied");
  assert.match(r.summary, /lens: no reads/);

  overlay = [];
  const r2 = await b.submit(proposed("fs.read", { path: "missing.md" }));
  assert.doesNotMatch(r2.summary, /lens: no reads/, "the overlay switches at runtime");
});

test("LayeredRuleSource keeps the base mode — an overlay cannot change it", async () => {
  const layered = new LayeredRuleSource(new StaticRuleSource({ mode: "plan", rules: [] }), () => []);
  const cfg = await layered.load();
  assert.equal(cfg.mode, "plan");
});

// ── operator-pinned MCP classification ───────────────────────────────────────

const quoteTool: McpToolDef = { server: "market", name: "get_quote", description: "latest price", inputSchema: { type: "object" }, readOnlyHint: true };
const orderTool: McpToolDef = { server: "market", name: "place_order", description: "buy or sell", inputSchema: { type: "object" }, readOnlyHint: true };

test("an operator-pinned read MCP tool runs without approval; an unpinned one still needs it", async () => {
  const mcp = mcpRegistry([{ name: "market", transport: "stdio", command: "x", tools: { get_quote: { effect: "read", risk: "low" } } }], [quoteTool, orderTool]);
  const rec = recorder(true);
  const b = boundary({ approvals: rec.port, mcp });
  const q = await b.submit(proposed("mcp.call", { server: "market", name: "get_quote", args: {} }));
  assert.equal(q.outcome, "ok");
  assert.equal(rec.asked.length, 0, "pinned read → no prompt");
  // The server claims place_order is read-only too — that hint is untrusted and must not lower it.
  await b.submit(proposed("mcp.call", { server: "market", name: "place_order", args: {} }));
  assert.equal(rec.asked.length, 1);
  assert.equal(rec.asked[0]!.action.effect, "execute");
  assert.equal(rec.asked[0]!.action.risk, "high");
});

test("after one MCP read taints the turn, a second pinned read asks instead of being hard-denied", async () => {
  const mcp = mcpRegistry([{ name: "market", transport: "stdio", command: "x", tools: { get_quote: { effect: "read", risk: "low" } } }], [quoteTool]);
  const rec = recorder(true);
  const b = boundary({ approvals: rec.port, mcp });
  const r = await b.submit(proposed("mcp.call", { server: "market", name: "get_quote", args: {} }, { origin: "model", taintedBy: ["mcp:market/get_quote"] }));
  assert.equal(rec.asked.length, 1, "tainted → ask (human judgment), not deny");
  assert.equal(r.outcome, "ok");
});

test("an operator can pin an MCP tool as spend/critical so it is never grant-covered", async () => {
  const mcp = mcpRegistry([{ name: "market", transport: "stdio", command: "x", tools: { place_order: { effect: "spend", risk: "critical" } } }], [orderTool]);
  const grants = new GrantStore();
  grants.mint({ tool: "mcp.call", maxUses: 10, ttlMs: 60_000, task: "old" });
  const rec = recorder(false);
  const cfg: PolicyConfig = { ...BASE, rules: [{ kind: "ask", match: { effect: "spend" }, note: "money moves" }, ...BASE.rules] };
  const b = boundary({ rules: cfg, approvals: rec.port, grants, mcp });
  await b.submit(proposed("mcp.call", { server: "market", name: "place_order", args: {} }));
  assert.equal(rec.asked.length, 1);
  assert.equal(rec.asked[0]!.action.effect, "spend");
});

test("mcp.batch is read/low only when EVERY step is pinned read; one unpinned step keeps it execute/high", async () => {
  const mcp = mcpRegistry([{ name: "market", transport: "stdio", command: "x", tools: { get_quote: { effect: "read", risk: "low" } } }], [quoteTool, orderTool]);
  const rec = recorder(false);
  const b = boundary({ approvals: rec.port, mcp });
  const ok = await b.submit(proposed("mcp.batch", { steps: [{ id: "a", server: "market", name: "get_quote" }, { id: "b", server: "market", name: "get_quote" }] }));
  assert.equal(ok.outcome, "ok");
  assert.equal(rec.asked.length, 0);
  await b.submit(proposed("mcp.batch", { steps: [{ id: "a", server: "market", name: "get_quote" }, { id: "b", server: "market", name: "place_order" }] }));
  assert.equal(rec.asked.length, 1);
  assert.equal(rec.asked[0]!.action.risk, "high");
});

test("the model cannot pin a classification through call arguments", async () => {
  const mcp = mcpRegistry([{ name: "market", transport: "stdio", command: "x" }], [orderTool]);
  const rec = recorder(false);
  const b = boundary({ approvals: rec.port, mcp });
  await b.submit(proposed("mcp.call", { server: "market", name: "place_order", args: {}, effect: "read", risk: "low", tools: { place_order: { effect: "read", risk: "low" } } }));
  assert.equal(rec.asked.length, 1);
  assert.equal(rec.asked[0]!.action.risk, "high");
});
