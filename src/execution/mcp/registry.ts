import type {
  McpTransport, McpServerConfig, McpToolDef, McpCallResult, McpReliability, McpSearchHit,
  McpBatchStep, McpBatchResult, McpBatchStepResult,
} from "./types.ts";
import { DEFAULT_MCP_RELIABILITY, classifyMcpTool, parsePinned } from "./types.ts";
import { createHash } from "node:crypto";
import type { Effect, Risk } from "../../core/types.ts";

/** Factory that builds a transport for a server config — the SDK adapter in prod, a mock in tests.
 * `onListChanged` lets a server's tools/list_changed notification invalidate the cached schemas. */
export type TransportFactory = (config: McpServerConfig, onListChanged?: () => void) => McpTransport;

interface CircuitState {
  failures: number;
  openedAt: number | null; // ms epoch when the circuit opened, or null if closed
}

/**
 * McpRegistry — the on-demand MCP layer. It holds server configs and lazily connects, lists, and
 * caches tool schemas host-side; it never injects schemas into the model. The three meta-tools
 * (mcp.search / mcp.inspect / mcp.call) drive it. Reliability lives here: effect-aware retry
 * (reads only), per-call timeout, and a per-server circuit breaker so a down server fails fast
 * instead of hanging every turn.
 */
export class McpRegistry {
  readonly #configs = new Map<string, McpServerConfig>();
  readonly #transports = new Map<string, McpTransport>();
  readonly #toolCache = new Map<string, McpToolDef[]>(); // server → its tools (memoized)
  readonly #circuits = new Map<string, CircuitState>();
  readonly #makeTransport: TransportFactory;
  readonly #rel: McpReliability;
  readonly #now: () => number;

  constructor(opts: {
    configs: McpServerConfig[];
    transportFactory: TransportFactory;
    reliability?: Partial<McpReliability>;
    now?: () => number;
  }) {
    for (const c of opts.configs) this.#configs.set(c.name, c);
    this.#makeTransport = opts.transportFactory;
    this.#rel = { ...DEFAULT_MCP_RELIABILITY, ...(opts.reliability ?? {}) };
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Configured server names (whether or not connected yet). */
  servers(): string[] {
    return [...this.#configs.keys()];
  }

  /**
   * A read-only snapshot for a status view: each configured server with its transport, whether it's
   * connected, whether its circuit is open, and how many tools are cached. Does NOT force a connect,
   * so calling it is cheap and side-effect-free (safe for a UI poll).
   */
  status(): { server: string; transport: string; enabled: boolean; connected: boolean; circuitOpen: boolean; toolCount: number }[] {
    return [...this.#configs.values()].map((cfg) => ({
      server: cfg.name,
      transport: cfg.transport,
      enabled: this.#enabled(cfg.name),
      connected: this.#transports.get(cfg.name)?.connected() ?? false,
      circuitOpen: this.#circuits.get(cfg.name)?.openedAt != null,
      toolCount: this.#toolCache.get(cfg.name)?.length ?? 0,
    }));
  }

  /** Whether a server is currently enabled (default true). A disabled server is fully invisible to
   * the model — excluded from search and refused by inspect/call — and is never connected. */
  #enabled(server: string): boolean {
    return this.#configs.get(server)?.enabled !== false;
  }

  /**
   * Enable/disable a server at runtime. Disabling immediately hides it from search and blocks
   * inspect/call, drops its cached schemas, and closes any open connection (so the subprocess/socket
   * goes away). Enabling restores discovery on next use. Returns false if the server is unknown.
   */
  setEnabled(server: string, enabled: boolean): boolean {
    const cfg = this.#configs.get(server);
    if (!cfg) return false;
    cfg.enabled = enabled;
    if (!enabled) {
      this.#toolCache.delete(server);
      const t = this.#transports.get(server);
      if (t) { void t.close().catch(() => {}); this.#transports.delete(server); }
    }
    return true;
  }

  /** Lazily connect to a server and list+cache its tools. Safe to call repeatedly (memoized). */
  async ensureTools(server: string): Promise<McpToolDef[]> {
    if (!this.#enabled(server)) throw new Error(`mcp: server "${server}" is disabled`);
    const cached = this.#toolCache.get(server);
    if (cached) return cached;
    const t = await this.#connect(server);
    const tools = await t.listTools();
    this.#toolCache.set(server, tools);
    return tools;
  }

  /** All cached tools across every server we've connected to so far. Does NOT force a connect. */
  #allCachedTools(): McpToolDef[] {
    return [...this.#toolCache.values()].flat();
  }

  /**
   * Search across ALL configured servers' tools, connecting lazily so search works before anything
   * is loaded. Deterministic BM25-lite scoring over each tool's name+description (local, no model).
   * Returns name + one-liner only — cheap by design (the schema is fetched later via inspect).
   */
  async search(query: string, limit = 8, opts: { boostServers?: string[] } = {}): Promise<McpSearchHit[]> {
    // Ensure every ENABLED, reachable server is listed at least once (skip disabled + open-circuit).
    for (const server of this.#configs.keys()) {
      if (!this.#enabled(server) || this.#circuitOpen(server)) continue;
      try { await this.ensureTools(server); } catch { /* a dead server shouldn't sink the search */ }
    }
    // Only rank tools from currently-enabled servers (a server disabled after caching is excluded).
    const terms = tokenize(query);
    const tools = this.#allCachedTools().filter((t) => this.#enabled(t.server));
    // A lens's servers rank first among matches (a boost on real matches — it never adds a
    // non-matching tool, and a disabled server stays invisible).
    const boost = new Set(opts.boostServers ?? []);
    const scored = tools.map((t) => {
      const base = bm25Lite(terms, `${t.name} ${t.description}`);
      return { t, score: base > 0 && boost.has(t.server) ? base * 1.5 : base };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ server: s.t.server, name: s.t.name, description: s.t.description, score: Math.round(s.score * 1000) / 1000 }));
  }

  /** Full schema for one tool (the inspect layer). Throws a recoverable error if not found. */
  async inspect(server: string, name: string): Promise<McpToolDef> {
    const tools = await this.ensureTools(server);
    const def = tools.find((t) => t.name === name);
    if (!def) {
      const near = tools.map((t) => t.name).filter((n) => n.includes(name) || name.includes(n)).slice(0, 5);
      throw new Error(`mcp: no tool "${name}" on server "${server}"${near.length ? `. Did you mean: ${near.join(", ")}?` : ""}`);
    }
    return def;
  }

  /**
   * The operator-pinned classification for a tool (config `tools`), or null. Synchronous and
   * config-only — no connect, no server input — so the boundary can consult it at classify time.
   */
  pinned(server: string, name: string): { effect: Effect; risk: Risk; reversible: boolean } | null {
    const cfg = this.#configs.get(server);
    if (!cfg || cfg.enabled === false || !cfg.tools || !Object.hasOwn(cfg.tools, name)) return null;
    return parsePinned(cfg.tools[name]);
  }

  /** Effect/risk classification for a tool, so mcp.call can build the ActionContract for the boundary. */
  async classify(server: string, name: string): Promise<{ effect: string; risk: string; reversible: boolean }> {
    const def = await this.inspect(server, name);
    return this.pinned(server, name) ?? classifyMcpTool(def, this.#configs.get(server)?.minEffect);
  }

  /**
   * Execute one tool with reliability: per-call timeout, effect-aware retry (ONLY read-only tools
   * are retried, with exponential backoff + jitter — a write is never auto-retried, to avoid
   * duplicating a side effect), and a per-server circuit breaker (fail fast when a server is down).
   * MCP's `isError: true` is a normal response, not a transport error — we surface it as a failed
   * result the model can react to, and do NOT retry it (the args were wrong, not the transport).
   */
  async call(server: string, name: string, args: Record<string, unknown>, idempotencyKey?: string): Promise<McpCallResult> {
    if (!this.#enabled(server)) throw new Error(`mcp: server "${server}" is disabled — not calling`);
    if (this.#circuitOpen(server)) {
      throw new Error(`mcp: server "${server}" circuit is open (recent repeated failures) — not calling; retry later`);
    }
    const cfg = this.#configs.get(server);
    if (!cfg) throw new Error(`mcp: unknown server "${server}"`);
    const def = await this.inspect(server, name);
    const retryable = def.readOnlyHint === true; // only reads are safe to auto-retry
    const timeoutMs = cfg.timeoutMs ?? this.#rel.defaultTimeoutMs;
    // A WRITE gets a stable idempotency key so a retry (or a resumed run) can't duplicate the side
    // effect on a server that honors it. Reads don't need one (they're naturally idempotent). The
    // key is derived from server+name+args so the SAME call reuses the SAME key across attempts.
    const key = retryable ? undefined : (idempotencyKey ?? idempotencyKeyFor(server, name, args));

    let lastErr: unknown;
    const attempts = retryable ? this.#rel.maxRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const t = await this.#connect(server);
        const res = await t.callTool(name, args, timeoutMs, key);
        this.#recordSuccess(server);
        return res; // includes isError:true when the TOOL failed — a valid, non-retried outcome
      } catch (err) {
        lastErr = err;
        this.#recordFailure(server); // transport/timeout failure — counts toward the circuit
        if (attempt < attempts - 1) await sleep(backoffWithJitter(this.#rel.backoffBaseMs, attempt));
      }
    }
    throw new Error(`mcp: call to ${server}/${name} failed after ${attempts} attempt(s): ${(lastErr as Error)?.message ?? String(lastErr)}`);
  }

  /** Drop the cached schemas for a server (or all), forcing a fresh tools/list on next use. Called
   * on a tools/list_changed notification, or manually. */
  refresh(server?: string): void {
    if (server) this.#toolCache.delete(server);
    else this.#toolCache.clear();
  }

  /**
   * Execute a declarative pipeline of MCP calls host-side, so large intermediate results DON'T pass
   * through the model's context — only a compact per-step summary returns. This is the safe subset
   * of "code mode": no model-authored code runs (no execution sandbox needed), just data-flow by
   * reference. A step may reference a prior step's textual result with `{{stepId}}` inside any
   * string arg; the host substitutes it before the call. Steps run sequentially (a later step can
   * depend on an earlier one). Every underlying call still flows through `call()` (retry, timeout,
   * circuit breaker, idempotency), and the whole batch is one boundary-gated mcp.batch action.
   * Stops at the first failing step and reports progress so the model can self-correct.
   */
  async batch(steps: McpBatchStep[]): Promise<McpBatchResult> {
    const results: McpBatchStepResult[] = [];
    const byId = new Map<string, string>(); // stepId → its result text (for substitution)
    for (const step of steps) {
      const resolvedArgs = substituteRefs(step.args ?? {}, byId);
      try {
        const res = await this.call(step.server, step.name, resolvedArgs);
        byId.set(step.id, res.text);
        results.push({ id: step.id, ok: !res.isError, summary: truncate(res.text, 500) });
        if (res.isError) return { completed: results, ok: false, stoppedAt: step.id };
      } catch (err) {
        results.push({ id: step.id, ok: false, summary: (err as Error).message });
        return { completed: results, ok: false, stoppedAt: step.id };
      }
    }
    return { completed: results, ok: true };
  }

  /** Close every open transport (e.g. on shutdown). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#transports.values()].map((t) => t.close().catch(() => {})));
    this.#transports.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  async #connect(server: string): Promise<McpTransport> {
    let t = this.#transports.get(server);
    if (t && t.connected()) return t;
    const cfg = this.#configs.get(server);
    if (!cfg) throw new Error(`mcp: unknown server "${server}"`);
    t = t ?? this.#makeTransport(cfg, () => this.#toolCache.delete(server)); // list_changed ⇒ drop cache
    await t.connect();
    this.#transports.set(server, t);
    return t;
  }

  #circuitOpen(server: string): boolean {
    const c = this.#circuits.get(server);
    if (!c || c.openedAt === null) return false;
    if (this.#now() - c.openedAt >= this.#rel.circuitResetMs) {
      // Half-open: allow one trial by closing; a fresh failure will re-open it.
      c.openedAt = null;
      c.failures = 0;
      return false;
    }
    return true;
  }

  #recordFailure(server: string): void {
    const c = this.#circuits.get(server) ?? { failures: 0, openedAt: null };
    c.failures += 1;
    if (c.failures >= this.#rel.circuitThreshold) c.openedAt = this.#now();
    this.#circuits.set(server, c);
  }

  #recordSuccess(server: string): void {
    this.#circuits.set(server, { failures: 0, openedAt: null });
  }
}

// ── search scoring (deterministic, local) ─────────────────────────────────────

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}

/**
 * A tiny BM25-flavored score: term frequency with saturation, favoring rarer/longer matches, over a
 * single short document (tool name+description). Deterministic and dependency-free — good enough to
 * rank a few dozen tool descriptions; a full FTS index is a later optimization if server counts grow.
 */
function bm25Lite(terms: string[], doc: string): number {
  const docTokens = tokenize(doc);
  if (docTokens.length === 0 || terms.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const w of docTokens) tf.set(w, (tf.get(w) ?? 0) + 1);
  const k1 = 1.5;
  let score = 0;
  for (const term of new Set(terms)) {
    const f = tf.get(term) ?? 0;
    if (f === 0) continue;
    // Saturating TF + a mild length-normalization; longer matching terms weigh a little more.
    score += ((f * (k1 + 1)) / (f + k1)) * (1 + term.length / 20);
  }
  return score;
}

function backoffWithJitter(base: number, attempt: number): number {
  const exp = base * 2 ** attempt;
  return exp + Math.floor(Math.random() * base); // full-ish jitter to avoid thundering herds
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Derive a stable idempotency key for a write call from (server, name, args). The SAME logical call
 * yields the SAME key across retries/resumes, so a server that honors it can dedupe and avoid a
 * duplicated side effect (the classic timeout→retry→double-invoice failure). Args are canonicalized
 * (sorted keys) so key stability doesn't depend on property order.
 */
function idempotencyKeyFor(server: string, name: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args, Object.keys(args).sort());
  return createHash("sha256").update(`${server}\u0000${name}\u0000${canonical}`).digest("hex").slice(0, 32);
}

/** Replace `{{stepId}}` references in string args with a prior step's result text (batch data-flow). */
function substituteRefs(args: Record<string, unknown>, byId: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string"
      ? v.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (m, id) => byId.get(id) ?? m)
      : v;
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
