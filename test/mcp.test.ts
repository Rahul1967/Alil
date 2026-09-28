import { test } from "node:test";
import assert from "node:assert/strict";

import { McpRegistry } from "../src/execution/mcp/registry.ts";
import { classifyMcpTool } from "../src/execution/mcp/types.ts";
import type { McpTransport, McpToolDef, McpCallResult, McpServerConfig, McpReliability } from "../src/execution/mcp/types.ts";
import { mcpSearch } from "../src/execution/tools/mcp-search.ts";
import { mcpInspect } from "../src/execution/tools/mcp-inspect.ts";
import { mcpCall } from "../src/execution/tools/mcp-call.ts";

/** A scriptable in-memory MCP transport — no subprocess, so tests stay hermetic. */
class MockTransport implements McpTransport {
  readonly server: string;
  #connected = false;
  calls: { name: string; args: Record<string, unknown> }[] = [];
  connectCount = 0;
  readonly #tools: McpToolDef[];
  readonly #handler: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>;
  constructor(cfg: McpServerConfig, tools: McpToolDef[], handler: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>) {
    this.server = cfg.name;
    this.#tools = tools;
    this.#handler = handler;
  }
  connected() { return this.#connected; }
  async connect() { this.connectCount++; this.#connected = true; }
  async listTools() { return this.#tools; }
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    this.calls.push({ name, args });
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
    transportFactory: (cfg) => {
      const t = new MockTransport(cfg, byServer.get(cfg.name) ?? [], handler ?? (async () => ({ isError: false, text: "ok" })));
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
