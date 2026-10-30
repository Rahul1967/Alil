/**
 * A reusable circuit breaker with a real half-open state, and the MCP registry using it per
 * logical call: one call that fails every retry is ONE failure (not one per attempt), and after
 * the cool-down exactly one probe goes through — its failure re-opens at once, its success closes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "../src/reliability/index.ts";
import type { CircuitTransition } from "../src/reliability/index.ts";
import { McpRegistry } from "../src/execution/mcp/registry.ts";
import type { McpTransport, McpToolDef, McpCallResult } from "../src/execution/mcp/types.ts";

function breaker(threshold = 3, resetMs = 1000) {
  let now = 0;
  const transitions: CircuitTransition[] = [];
  const b = new CircuitBreaker({ threshold, resetMs, now: () => now, onTransition: (t) => transitions.push(t) });
  return { b, transitions, advance: (ms: number) => { now += ms; } };
}

test("closed until `threshold` consecutive failures, then open and refusing", () => {
  const { b, transitions } = breaker(3);
  for (let i = 0; i < 2; i++) { assert.ok(b.tryAcquire()); b.failure(); }
  assert.equal(b.state, "closed");
  assert.ok(b.tryAcquire()); b.failure();
  assert.equal(b.state, "open");
  assert.equal(b.tryAcquire(), false);
  assert.deepEqual(transitions.map((t) => `${t.from}→${t.to}`), ["closed→open"]);
});

test("a success resets the failure count", () => {
  const { b } = breaker(3);
  b.failure(); b.failure(); b.success(); b.failure(); b.failure();
  assert.equal(b.state, "closed");
});

test("after the cool-down exactly one probe is let through", () => {
  const { b, advance } = breaker(1, 1000);
  b.failure();
  advance(999);
  assert.equal(b.tryAcquire(), false, "still cooling down");
  advance(1);
  assert.equal(b.tryAcquire(), true, "the probe");
  assert.equal(b.state, "half_open");
  assert.equal(b.tryAcquire(), false, "a second caller waits for the probe's result");
});

test("a failed probe re-opens immediately (adversarial: no fresh threshold of failures)", () => {
  const { b, advance, transitions } = breaker(3, 1000);
  b.failure(); b.failure(); b.failure();
  advance(1000);
  assert.ok(b.tryAcquire());
  b.failure();
  assert.equal(b.state, "open");
  assert.equal(b.tryAcquire(), false);
  assert.deepEqual(transitions.map((t) => t.to), ["open", "half_open", "open"]);
});

test("a successful probe closes the circuit", () => {
  const { b, advance } = breaker(1, 1000);
  b.failure(); advance(1000);
  assert.ok(b.tryAcquire()); b.success();
  assert.equal(b.state, "closed");
  assert.ok(b.tryAcquire());
});

test("a probe that is released without a verdict does not wedge the breaker", () => {
  const { b, advance } = breaker(1, 1000);
  b.failure(); advance(1000);
  assert.ok(b.tryAcquire());
  b.release();
  assert.ok(b.tryAcquire(), "the next caller may probe");
});

// ── MCP registry integration ────────────────────────────────────────────────
function registry(callTool: () => Promise<McpCallResult>, reliability: Record<string, number>) {
  let now = 0;
  const def: McpToolDef = { server: "s", name: "get", description: "d", inputSchema: {}, readOnlyHint: true } as McpToolDef;
  const transport: McpTransport = {
    connect: async () => {}, connected: () => true, close: async () => {},
    listTools: async () => [def],
    callTool: callTool as McpTransport["callTool"],
  } as McpTransport;
  const reg = new McpRegistry({
    configs: [{ name: "s", transport: "stdio", command: "x" } as never],
    transportFactory: () => transport,
    reliability: { backoffBaseMs: 1, ...reliability },
    now: () => now,
  });
  return { reg, advance: (ms: number) => { now += ms; } };
}

test("MCP: one logical call that fails every retry counts as ONE failure", async () => {
  let attempts = 0;
  const { reg } = registry(async () => { attempts++; throw new Error("down"); }, { maxRetries: 2, circuitThreshold: 2 });
  await assert.rejects(() => reg.call("s", "get", {}));
  assert.equal(attempts, 3, "1 try + 2 retries");
  assert.equal(reg.status()[0]!.circuitOpen, false, "3 attempts but 1 failed call — below threshold 2");
  await assert.rejects(() => reg.call("s", "get", {}));
  assert.equal(reg.status()[0]!.circuitOpen, true);
});

test("MCP: after the cool-down one probe reaches the server; its failure re-opens", async () => {
  let attempts = 0;
  const { reg, advance } = registry(async () => { attempts++; throw new Error("down"); }, { maxRetries: 0, circuitThreshold: 1, circuitResetMs: 1000 });
  await assert.rejects(() => reg.call("s", "get", {}));
  await assert.rejects(() => reg.call("s", "get", {}), /circuit is open/);
  advance(1000);
  const before = attempts;
  await assert.rejects(() => reg.call("s", "get", {}), /down/);
  assert.equal(attempts, before + 1, "the probe went through");
  await assert.rejects(() => reg.call("s", "get", {}), /circuit is open/, "probe failure re-opened it");
});

test("MCP: circuit transitions are reported to an observer", async () => {
  const seen: string[] = [];
  let now = 0;
  const def = { server: "s", name: "get", description: "d", inputSchema: {}, readOnlyHint: true } as McpToolDef;
  const reg = new McpRegistry({
    configs: [{ name: "s", transport: "stdio", command: "x" } as never],
    transportFactory: () => ({ connect: async () => {}, connected: () => true, close: async () => {}, listTools: async () => [def], callTool: async () => { throw new Error("down"); } }) as unknown as McpTransport,
    reliability: { maxRetries: 0, backoffBaseMs: 1, circuitThreshold: 1 },
    now: () => now,
    observer: { onCircuit: (e) => seen.push(`${e.server}:${e.from}→${e.to}`) },
  });
  await assert.rejects(() => reg.call("s", "get", {}));
  assert.deepEqual(seen, ["s:closed→open"]);
});
