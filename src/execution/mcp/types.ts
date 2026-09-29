import type { Effect, Risk } from "../../core/types.ts";

/**
 * MCP integration types (Phase 1). The design goal is ON-DEMAND tool exposure: MCP tools are never
 * injected into the model's context as individual tools (avoiding the "tools tax" — 10k–130k tokens
 * per turn across multiple servers). Instead the model uses three native meta-tools —
 * mcp.search → mcp.inspect → mcp.call — so only the schemas it actually needs enter context, and the
 * advertised tool array stays stable (prompt-cache safe).
 *
 * Everything here is transport-agnostic: the concrete SDK/stdio wiring lives behind McpTransport, so
 * the registry, search, and reliability logic are unit-testable with a mock transport (no subprocess).
 */

/** A tool as advertised by an MCP server (from tools/list), cached host-side, never auto-injected. */
export interface McpToolDef {
  server: string; // which configured server exposes it
  name: string; // the tool name as the server knows it
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema for arguments
  /**
   * MCP tool annotations (2025-03-26+). `readOnlyHint` lets us classify effect/risk conservatively:
   * a read-only tool is `read`/low; anything else is treated as a `write` and gated accordingly.
   * Hints are advisory from an untrusted server, so we only ever use them to RAISE caution.
   */
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

/** The result of one tools/call: MCP returns content blocks and an isError flag (not a transport error). */
export interface McpCallResult {
  isError: boolean;
  /** Flattened text content of the result (we join text blocks; non-text blocks are summarized). */
  text: string;
}

/**
 * A live connection to one MCP server. Implemented by the SDK adapter (stdio/HTTP) in production and
 * by a mock in tests. Kept deliberately small — connect, list, call, close — so the SDK stays
 * isolated in one file and never leaks into the registry/tool logic.
 */
export interface McpTransport {
  readonly server: string;
  /** Establish the connection + initialize handshake. Idempotent: a no-op if already connected. */
  connect(): Promise<void>;
  /** List the server's tools (schemas). Callers memoize the result. */
  listTools(): Promise<McpToolDef[]>;
  /** Invoke one tool. Must resolve within `timeoutMs`, else reject (caller sends cancellation).
   * `idempotencyKey` (when provided) is passed to the server so a retried WRITE can be deduped. */
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number, idempotencyKey?: string): Promise<McpCallResult>;
  /** Tear down the connection (stdio: kill the subprocess). Idempotent. */
  close(): Promise<void>;
  connected(): boolean;
}

/** Configuration for one MCP server. stdio spawns a local process; http connects to a URL. */
export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  /**
   * Whether this server is active. Default true. When false, it is fully invisible to the model:
   * excluded from mcp.search, and mcp.inspect/mcp.call refuse it — so a disabled server can neither
   * be discovered nor reached, even if the model already knows a tool name. It is also never
   * connected. Toggle it back on to restore access (no restart needed if toggled via the registry).
   */
  enabled?: boolean;
  /** stdio: the command + args to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: the server URL. */
  url?: string;
  /** Per-call timeout (ms). Defaults: stdio 30m-ish is too long for an assistant; we use 30s. */
  timeoutMs?: number;
  /** Effect ceiling: even if a tool claims read-only, never classify below this. Optional hardening. */
  minEffect?: Effect;
}

/** Reliability knobs for mcp.call (effect-aware retry, backoff, circuit breaker). */
export interface McpReliability {
  /** Max retries for RETRYABLE (read-only) calls. Writes are never auto-retried. Default 2. */
  maxRetries: number;
  /** Base backoff (ms) for exponential backoff + jitter. Default 250. */
  backoffBaseMs: number;
  /** Consecutive failures before a server's circuit opens (fail fast). Default 4. */
  circuitThreshold: number;
  /** How long a tripped circuit stays open before a half-open trial (ms). Default 30000. */
  circuitResetMs: number;
  /** Default per-call timeout when a server config doesn't set one (ms). Default 30000. */
  defaultTimeoutMs: number;
}

export const DEFAULT_MCP_RELIABILITY: McpReliability = {
  maxRetries: 2,
  backoffBaseMs: 250,
  circuitThreshold: 4,
  circuitResetMs: 30_000,
  defaultTimeoutMs: 30_000,
};

/** A search hit returned by mcp.search — name + one-liner only (no schema), to stay cheap. */
export interface McpSearchHit {
  server: string;
  name: string;
  description: string;
  score: number;
}

/** One step of an mcp.batch pipeline: a call whose string args may reference prior steps via {{id}}. */
export interface McpBatchStep {
  id: string;
  server: string;
  name: string;
  args?: Record<string, unknown>;
}

/** Compact per-step outcome returned from a batch (the full text stays host-side). */
export interface McpBatchStepResult {
  id: string;
  ok: boolean;
  summary: string; // truncated result text, or the error message
}

export interface McpBatchResult {
  completed: McpBatchStepResult[];
  ok: boolean;
  stoppedAt?: string; // the step id where the batch stopped, if it failed
}

/**
 * Classify an MCP tool's effect/risk from its (untrusted, advisory) annotations. Conservative:
 * only a tool explicitly marked read-only is treated as a low-risk read; everything else is a
 * write. A destructive hint raises risk to high. Server config `minEffect` can only raise, never
 * lower. This feeds the ActionContract so the PolicyBoundary gates MCP calls like any native tool.
 */
export function classifyMcpTool(def: McpToolDef, minEffect?: Effect): { effect: Effect; risk: Risk; reversible: boolean } {
  const readOnly = def.readOnlyHint === true && minEffect !== "write" && minEffect !== "execute" && minEffect !== "spend";
  if (readOnly) return { effect: "read", risk: "low", reversible: true };
  const destructive = def.destructiveHint === true;
  return { effect: "write", risk: destructive ? "high" : "medium", reversible: false };
}
