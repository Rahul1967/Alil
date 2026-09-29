import { test } from "node:test";
import assert from "node:assert/strict";

import { McpRegistry } from "../src/execution/mcp/registry.ts";
import { classifyMcpTool } from "../src/execution/mcp/types.ts";
import type { McpTransport, McpToolDef, McpCallResult, McpServerConfig, McpReliability } from "../src/execution/mcp/types.ts";
import { mcpSearch } from "../src/execution/tools/mcp-search.ts";
import { mcpInspect } from "../src/execution/tools/mcp-inspect.ts";
import { mcpCall } from "../src/execution/tools/mcp-call.ts";
import { mcpBatch } from "../src/execution/tools/mcp-batch.ts";

/** A scriptable in-memory MCP transport — no subprocess, so tests stay hermetic. */
class MockTransport implements McpTransport {
  readonly server: string;
  #connected = false;
  calls: { name: string; args: Record<string, unknown>; idempotencyKey?: string }[] = [];
  connectCount = 0;
  onListChanged: (() => void) | undefined;
  readonly #tools: McpToolDef[];
  readonly #handler: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>;
  constructor(cfg: McpServerConfig, tools: McpToolDef[], handler: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>, onListChanged?: () => void) {
    this.server = cfg.name;
    this.#tools = tools;
    this.#handler = handler;
    this.onListChanged = onListChanged;
  }
  connected() { return this.#connected; }
  async connect() { this.connectCount++; this.#connected = true; }
  async listTools() { return this.#tools; }
  async callTool(name: string, args: Record<string, unknown>, _timeoutMs: number, idempotencyKey?: string): Promise<McpCallResult> {
    this.calls.push({ name, args, ...(idempotencyKey ? { idempotencyKey } : {}) });
    return this.#handler(name, args);
  }
  async close() { this.#connected = false; }
}

function tool(server: string, name: string, description: string, readOnly?: boolean, destructive?: boolean): McpToolDef {
  return {
    server, name, description, inputSchema: { type: "object" },
    ...(readOnly !== undefined ? { readOnlyHint: readOnly } : {}),
    ...(destructive !== undefined ? { destructiveHint: destructive } : {}),
  };
}

function registryWith(tools: McpToolDef[], handler?: (n: string, a: Record<string, unknown>) => Promise<McpCallResult>, rel?: Partial<McpReliability>) {
  const byServer = new Map<string, McpToolDef[]>();
  for (const t of tools) (byServer.get(t.server) ?? byServer.set(t.server, []).get(t.server)!).push(t);
  const configs: McpServerConfig[] = [...byServer.keys()].map((name) => ({ name, transport: "stdio", command: "x" }));
  const transports = new Map<string, MockTransport>();
  const reg = new McpRegistry({
    configs,
    transportFactory: (cfg, onListChanged) => {
      const t = new MockTransport(cfg, byServer.get(cfg.name) ?? [], handler ?? (async () => ({ isError: false, text: "ok" })), onListChanged);
      transports.set(cfg.name, t);
      return t;
    },
    ...(rel ? { reliability: rel } : {}),
  });
  return { reg, transports };
}

// ── classification ───────────────────────────────────────────────────────────

test("classifyMcpTool: read-only hint → read/low; otherwise write; destructive → high", () => {
  assert.deepEqual(classifyMcpTool(tool("s", "get", "d", true)), { effect: "read", risk: "low", reversible: true });
  assert.deepEqual(classifyMcpTool(tool("s", "set", "d", false)), { effect: "write", risk: "medium", reversible: false });
  assert.deepEqual(classifyMcpTool(tool("s", "rm", "d", false, true)), { effect: "write", risk: "high", reversible: false });
  // Unknown (no hint) is treated as a write, conservatively.
  assert.deepEqual(classifyMcpTool(tool("s", "mystery", "d")), { effect: "write", risk: "medium", reversible: false });
  // minEffect can only RAISE: a read-only tool under minEffect:write is still a write.
  assert.equal(classifyMcpTool(tool("s", "get", "d", true), "write").effect, "write");
});

// ── on-demand discovery: search → inspect → call ─────────────────────────────

test("search ranks by intent and returns names+descriptions only (no schema)", async () => {
  const { reg } = registryWith([
    tool("fs", "read_file", "Read a file from disk", true),
    tool("fs", "write_file", "Write a file to disk", false),
    tool("web", "fetch_url", "Fetch a web page", true),
  ]);
  const hits = await reg.search("read a file");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.name, "read_file"); // best match first
  assert.ok(!("inputSchema" in hits[0]!), "search hits must not carry schemas");
});

test("inspect returns the full schema + effect classification for one tool", async () => {
  const { reg } = registryWith([tool("db", "query", "Run a read query", true)]);
  const def = await reg.inspect("db", "query");
  assert.equal(def.inputSchema && typeof def.inputSchema, "object");
  const cls = await reg.classify("db", "query");
  assert.deepEqual(cls, { effect: "read", risk: "low", reversible: true });
});

test("inspect on a missing tool gives a recoverable hint", async () => {
  const { reg } = registryWith([tool("db", "query_records", "d", true)]);
  await assert.rejects(() => reg.inspect("db", "query"), /no tool "query".*Did you mean: query_records/);
});

test("connection is lazy and memoized — connect happens once, on first use", async () => {
  const { reg, transports } = registryWith([tool("s", "t", "d", true)]);
  await reg.search("t");
  await reg.inspect("s", "t");
  await reg.call("s", "t", {});
  assert.equal(transports.get("s")!.connectCount, 1, "one connect despite multiple operations");
});

// ── call + provenance via the meta-tool ──────────────────────────────────────

test("mcp.call tags results as ingested (untrusted) and surfaces tool text", async () => {
  const { reg } = registryWith([tool("s", "echo", "d", true)], async (_n, a) => ({ isError: false, text: `echoed:${JSON.stringify(a)}` }));
  const out = await mcpCall.run({ server: "s", name: "echo", args: { x: 1 } }, { mcp: { registry: reg } } as never);
  assert.match(out.summary, /ok/);
  assert.equal(out.provenance?.origin, "ingested");
  assert.equal(out.provenance?.ingestedFrom, "mcp:s/echo");
  assert.match((out.data as { text: string }).text, /echoed/);
});

test("mcp.call is declared execute/high so the boundary always gates it", () => {
  assert.equal(mcpCall.effect, "execute");
  assert.equal(mcpCall.risk, "high");
});

test("mcp.call surfaces a tool-level isError as a non-throwing observation", async () => {
  const { reg } = registryWith([tool("s", "bad", "d", true)], async () => ({ isError: true, text: "invalid argument" }));
  const out = await mcpCall.run({ server: "s", name: "bad", args: {} }, { mcp: { registry: reg } } as never);
  assert.equal((out.data as { isError: boolean }).isError, true);
  assert.match((out.data as { text: string }).text, /invalid argument/);
  assert.equal(out.provenance?.origin, "ingested"); // still fenced
});

test("mcp.search returns empty when no MCP servers are configured", async () => {
  const out = await mcpSearch.run({ query: "anything" }, { mcp: {} } as never);
  assert.deepEqual(out.data, []);
});

// ── reliability: effect-aware retry, circuit breaker ─────────────────────────

test("read-only calls retry on transport failure; writes do NOT", async () => {
  // Read tool: fail twice then succeed → should retry and eventually succeed.
  let readAttempts = 0;
  const readReg = registryWith([tool("s", "get", "d", true)], async () => {
    readAttempts++;
    if (readAttempts < 3) throw new Error("transient");
    return { isError: false, text: "ok" };
  }, { maxRetries: 2, backoffBaseMs: 1 }).reg;
  const r = await readReg.call("s", "get", {});
  assert.equal(r.text, "ok");
  assert.equal(readAttempts, 3, "retried the read twice before success");

  // Write tool: fail once → must NOT retry (no duplicated side effect); throws after 1 attempt.
  let writeAttempts = 0;
  const writeReg = registryWith([tool("s", "set", "d", false)], async () => {
    writeAttempts++;
    throw new Error("transient");
  }, { maxRetries: 2, backoffBaseMs: 1 }).reg;
  await assert.rejects(() => writeReg.call("s", "set", {}));
  assert.equal(writeAttempts, 1, "a write is attempted exactly once — never auto-retried");
});

test("the circuit breaker opens after repeated failures and fails fast", async () => {
  let attempts = 0;
  const reg = registryWith([tool("s", "get", "d", true)], async () => { attempts++; throw new Error("down"); },
    { maxRetries: 0, backoffBaseMs: 1, circuitThreshold: 3 }).reg;
  // 3 failing calls trip the breaker (threshold 3, no retries).
  for (let i = 0; i < 3; i++) await assert.rejects(() => reg.call("s", "get", {}));
  const attemptsBeforeOpen = attempts;
  // Next call should fail fast WITHOUT invoking the transport again.
  await assert.rejects(() => reg.call("s", "get", {}), /circuit is open/);
  assert.equal(attempts, attemptsBeforeOpen, "open circuit must not reach the transport");
});

// ── Phase 2: idempotency keys, list_changed refresh ──────────────────────────

test("a WRITE call carries a stable idempotency key; a read does not", async () => {
  const { reg, transports } = registryWith([
    tool("s", "create", "d", false), // write
    tool("s", "get", "d", true),     // read
  ]);
  await reg.call("s", "create", { title: "x" });
  await reg.call("s", "get", { q: "y" });
  const calls = transports.get("s")!.calls;
  const write = calls.find((c) => c.name === "create")!;
  const read = calls.find((c) => c.name === "get")!;
  assert.ok(write.idempotencyKey, "write must carry an idempotency key");
  assert.equal(read.idempotencyKey, undefined, "read needs no idempotency key");

  // The SAME write args reuse the SAME key (so a retry/resume dedupes server-side).
  const { reg: reg2, transports: t2 } = registryWith([tool("s", "create", "d", false)]);
  await reg2.call("s", "create", { title: "x" });
  assert.equal(t2.get("s")!.calls[0]!.idempotencyKey, write.idempotencyKey, "key is deterministic from server+name+args");
});

test("a tools/list_changed notification invalidates the cached schemas", async () => {
  const { reg, transports } = registryWith([tool("s", "old_tool", "d", true)]);
  await reg.ensureTools("s"); // caches [old_tool]
  assert.deepEqual((await reg.search("tool")).map((h) => h.name), ["old_tool"]);
  // Server signals its toolset changed → registry drops the cache; next use re-lists.
  transports.get("s")!.onListChanged?.();
  const hits = await reg.search("tool"); // re-lists (mock returns the same set, but a re-list happened)
  assert.ok(hits.length >= 1);
});

test("refresh() drops the cache and forces a fresh list", async () => {
  const { reg } = registryWith([tool("s", "t", "d", true)]);
  await reg.ensureTools("s");
  reg.refresh("s"); // no throw; cache cleared
  const def = await reg.inspect("s", "t");
  assert.equal(def.name, "t");
});

// ── Phase 3: mcp.batch (host-side pipeline, safe code-mode substitute) ────────

test("mcp.batch runs steps sequentially and substitutes {{stepId}} references", async () => {
  const { reg } = registryWith([
    tool("s", "read", "d", true),
    tool("s", "write", "d", false),
  ], async (name, args) => {
    if (name === "read") return { isError: false, text: "CONTENT-42" };
    // The write should have received the read's result via {{r}} substitution.
    return { isError: false, text: `wrote:${(args as { body: string }).body}` };
  });
  const out = await mcpBatch.run({
    steps: [
      { id: "r", server: "s", name: "read", args: {} },
      { id: "w", server: "s", name: "write", args: { body: "value={{r}}" } },
    ],
  }, { mcp: { registry: reg } } as never);
  const res = out.data as { ok: boolean; completed: { id: string; ok: boolean; summary: string }[] };
  assert.equal(res.ok, true);
  assert.equal(res.completed.length, 2);
  assert.match(res.completed[1]!.summary, /wrote:value=CONTENT-42/, "the write saw the read's result via {{r}}");
  assert.equal(out.provenance?.origin, "ingested"); // batch output is untrusted
});

test("mcp.batch stops at the first failing step and reports progress", async () => {
  const { reg } = registryWith([tool("s", "a", "d", true), tool("s", "b", "d", true)],
    async (name) => (name === "b" ? { isError: true, text: "boom" } : { isError: false, text: "ok" }));
  const out = await mcpBatch.run({
    steps: [
      { id: "a", server: "s", name: "a" },
      { id: "b", server: "s", name: "b" },
      { id: "c", server: "s", name: "a" }, // should NOT run — batch stopped at b
    ],
  }, { mcp: { registry: reg } } as never);
  const res = out.data as { ok: boolean; stoppedAt: string; completed: unknown[] };
  assert.equal(res.ok, false);
  assert.equal(res.stoppedAt, "b");
  assert.equal(res.completed.length, 2, "step c never ran");
});

test("mcp.batch is execute/high (boundary-gated) and validates step shape", () => {
  assert.equal(mcpBatch.effect, "execute");
  assert.equal(mcpBatch.risk, "high");
  assert.equal(mcpBatch.validate({ steps: [] }).ok, false); // empty
  assert.equal(mcpBatch.validate({ steps: [{ id: "x", server: "s", name: "t" }, { id: "x", server: "s", name: "t" }] }).ok, false); // dup id
  assert.equal(mcpBatch.validate({ steps: [{ id: "x", server: "s", name: "t" }] }).ok, true);
});

// ── enable/disable: a disabled server is fully invisible + inaccessible to the model ──

/** Build a registry where a server can be pre-disabled via its config. */
function registryWithConfig(configs: McpServerConfig[], toolsByServer: Record<string, McpToolDef[]>) {
  const reg = new McpRegistry({
    configs,
    transportFactory: (cfg) => new MockTransport(cfg, toolsByServer[cfg.name] ?? [], async () => ({ isError: false, text: "ok" })),
  });
  return reg;
}

test("a disabled server is excluded from search (the model can't discover it)", async () => {
  const reg = registryWithConfig(
    [{ name: "on", transport: "stdio", command: "x" }, { name: "off", transport: "stdio", command: "x", enabled: false }],
    { on: [tool("on", "alpha", "does alpha", true)], off: [tool("off", "alpha", "does alpha", true)] },
  );
  const hits = await reg.search("alpha");
  assert.ok(hits.every((h) => h.server === "on"), "no hit from a disabled server");
  assert.ok(hits.some((h) => h.server === "on"));
});

test("a disabled server refuses inspect and call even by exact name", async () => {
  const reg = registryWithConfig(
    [{ name: "off", transport: "stdio", command: "x", enabled: false }],
    { off: [tool("off", "secret_tool", "d", true)] },
  );
  await assert.rejects(() => reg.inspect("off", "secret_tool"), /disabled/);
  await assert.rejects(() => reg.call("off", "secret_tool", {}), /disabled/);
});

test("setEnabled toggles visibility at runtime (disable hides, enable restores)", async () => {
  const reg = registryWithConfig(
    [{ name: "s", transport: "stdio", command: "x" }],
    { s: [tool("s", "thing", "does a thing", true)] },
  );
  // Enabled: discoverable + callable.
  assert.equal((await reg.search("thing")).length, 1);
  assert.equal((await reg.call("s", "thing", {})).isError, false);
  // Disable: gone from search, refused by call.
  assert.equal(reg.setEnabled("s", false), true);
  assert.equal((await reg.search("thing")).length, 0);
  await assert.rejects(() => reg.call("s", "thing", {}), /disabled/);
  assert.equal(reg.status().find((x) => x.server === "s")!.enabled, false);
  // Re-enable: back.
  reg.setEnabled("s", true);
  assert.equal((await reg.search("thing")).length, 1);
  // Unknown server toggle returns false.
  assert.equal(reg.setEnabled("nope", false), false);
});
