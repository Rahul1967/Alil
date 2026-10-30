import type {
  McpTransport, McpServerConfig, McpToolDef, McpCallResult, McpReliability, McpSearchHit,
  McpBatchStep, McpBatchResult, McpBatchStepResult, McpObserver,
} from "./types.ts";
import { CircuitBreaker } from "../../reliability/index.ts";
import { reportError } from "../../telemetry/index.ts";
import { DEFAULT_MCP_RELIABILITY, classifyMcpTool, parsePinned } from "./types.ts";
import { createHash } from "node:crypto";
import { guardUrlArgs, type HostCheck } from "./url-guard.ts";
import type { Effect, Risk } from "../../core/types.ts";

/** Factory that builds a transport for a server config — the SDK adapter in prod, a mock in tests.
 * `onListChanged` lets a server's tools/list_changed notification invalidate the cached schemas. */
export type TransportFactory = (config: McpServerConfig, onListChanged?: () => void) => McpTransport;

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
  readonly #circuits = new Map<string, CircuitBreaker>();
  readonly #makeTransport: TransportFactory;
  readonly #rel: McpReliability;
  readonly #now: () => number;
  readonly #hostCheck: HostCheck | undefined;
  readonly #observer: McpObserver | undefined;

  constructor(opts: {
    configs: McpServerConfig[];
    transportFactory: TransportFactory;
    reliability?: Partial<McpReliability>;
    now?: () => number;
    /** Public-address check for `guardUrls` servers (default: web.fetch's DNS-resolving guard). */
    hostCheck?: HostCheck;
    /** Telemetry: per-call timing/outcome, connects, circuit transitions. */
    observer?: McpObserver;
  }) {
    for (const c of opts.configs) this.#configs.set(c.name, c);
    this.#makeTransport = opts.transportFactory;
    this.#rel = { ...DEFAULT_MCP_RELIABILITY, ...(opts.reliability ?? {}) };
    this.#now = opts.now ?? (() => Date.now());
    this.#hostCheck = opts.hostCheck;
    this.#observer = opts.observer;
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
      circuitOpen: (this.#circuits.get(cfg.name)?.state ?? "closed") !== "closed",
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
    try { this.#observer?.onToolsListed?.(server, tools); } catch { /* observer must not break listing */ }
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
      if (!this.#enabled(server) || this.#breaker(server).refusing) continue;
      try { await this.ensureTools(server); } catch (err) { reportError("mcp.search.list", err, { server }); /* a dead server shouldn't sink the search */ }
    }
    // Only rank tools from currently-enabled servers (a server disabled after caching is excluded).
    const terms = tokenize(query);
    const tools = this.#allCachedTools().filter((t) => this.#enabled(t.server));
    // IDF over the candidate corpus: a term in MANY tool descriptions (generic verbs like "search",
    // "get", "data") is weak/discriminative-less; a rare term is strong. Without this, a lone "search"
    // overlap surfaces unrelated tools (e.g. a travel query matching NSE's `search_symbols`).
    const idf = computeIdf(tools.map((t) => `${t.name} ${t.description}`));
    // A lens's servers rank first among matches (a boost on real matches — it never adds a
    // non-matching tool, and a disabled server stays invisible).
    const boost = new Set(opts.boostServers ?? []);
    const scored = tools.map((t) => {
      const base = bm25Idf(terms, `${t.name} ${t.description}`, idf);
      return { t, score: base > 0 && boost.has(t.server) ? base * 1.5 : base };
    });
    // Relevance floor: a match must clear a minimum IDF-weighted score, so a match on ONLY generic
    // terms (e.g. "search"/"get"/"data") is dropped — an off-domain query ("book a flight") against
    // domain tools (NSE stocks) returns nothing rather than a misleading near-miss. Real in-domain
    // queries clear it comfortably (empirically ~2.5–5 vs <1.3 for generic-only overlaps). Deep
    // semantic "is this query in this tool's domain?" is the embedding path (see DESIGN §12 Next).
    const MIN_SCORE = 1.5;
    return scored
      .filter((s) => s.score >= MIN_SCORE)
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
    if (this.#breaker(server).refusing) {
      this.#observer?.onCall?.({ server, tool: name, attempts: 0, durationMs: 0, outcome: "refused" });
      throw new Error(`mcp: server "${server}" circuit is open (recent repeated failures) — not calling; retry later`);
    }
    const cfg = this.#configs.get(server);
    if (!cfg) throw new Error(`mcp: unknown server "${server}"`);
    // A crawler server fetches for us outside web.fetch's guard: vet every URL before it sees one.
    if (cfg.guardUrls) await guardUrlArgs(args, this.#hostCheck);
    const def = await this.inspect(server, name);
    const retryable = def.readOnlyHint === true; // only reads are safe to auto-retry
    const timeoutMs = cfg.timeoutMs ?? this.#rel.defaultTimeoutMs;
    // A WRITE gets a stable idempotency key so a retry (or a resumed run) can't duplicate the side
    // effect on a server that honors it. Reads don't need one (they're naturally idempotent). The
    // key is derived from server+name+args so the SAME call reuses the SAME key across attempts.
    const key = retryable ? undefined : (idempotencyKey ?? idempotencyKeyFor(server, name, args));

    // The breaker is consulted once per LOGICAL call: all of its retries together are one success
    // or one failure. After the cool-down this acquire is the single half-open probe.
    const breaker = this.#breaker(server);
    if (!breaker.tryAcquire()) {
      this.#observer?.onCall?.({ server, tool: name, attempts: 0, durationMs: 0, outcome: "refused" });
      throw new Error(`mcp: server "${server}" circuit is open (recent repeated failures) — not calling; retry later`);
    }
    const started = this.#now();
    let lastErr: unknown;
    const attempts = retryable ? this.#rel.maxRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const t = await this.#connect(server);
        const res = await t.callTool(name, args, timeoutMs, key);
        breaker.success();
        this.#observer?.onCall?.({
          server, tool: name, attempts: attempt + 1, durationMs: this.#now() - started,
          outcome: res.isError ? "tool_error" : "ok", resultChars: res.text.length,
        });
        return res; // includes isError:true when the TOOL failed — a valid, non-retried outcome
      } catch (err) {
        lastErr = err;
        if (attempt < attempts - 1) await sleep(backoffWithJitter(this.#rel.backoffBaseMs, attempt));
      }
    }
    breaker.failure(); // transport/timeout failure on every attempt — one failed call
    const message = (lastErr as Error)?.message ?? String(lastErr);
    this.#observer?.onCall?.({ server, tool: name, attempts, durationMs: this.#now() - started, outcome: "error", error: message.slice(0, 300) });
    throw new Error(`mcp: call to ${server}/${name} failed after ${attempts} attempt(s): ${message}`);
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
    const started = this.#now();
    try {
      await t.connect();
    } catch (err) {
      this.#observer?.onConnect?.({ server, durationMs: this.#now() - started, ok: false, error: ((err as Error)?.message ?? String(err)).slice(0, 300) });
      throw err;
    }
    this.#observer?.onConnect?.({ server, durationMs: this.#now() - started, ok: true });
    this.#transports.set(server, t);
    return t;
  }

  #breaker(server: string): CircuitBreaker {
    let b = this.#circuits.get(server);
    if (!b) {
      b = new CircuitBreaker({
        threshold: this.#rel.circuitThreshold,
        resetMs: this.#rel.circuitResetMs,
        now: this.#now,
        onTransition: (t) => this.#observer?.onCircuit?.({ server, from: t.from, to: t.to, failures: t.failures }),
      });
      this.#circuits.set(server, b);
    }
    return b;
  }
}

// ── search scoring (deterministic, local) ─────────────────────────────────────

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}

/**
 * Inverse document frequency across the tool corpus: idf(term) = ln(1 + N/df). A term appearing in
 * many tool descriptions (generic verbs — "search", "get", "data", "returns") gets a low weight; a
 * rare, discriminative term gets a high one. This is what stops a generic query word from surfacing
 * an unrelated tool. Recomputed per search over the current candidate set (cheap at this scale).
 */
function computeIdf(docs: string[]): Map<string, number> {
  const n = docs.length || 1;
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(tokenize(doc))) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [term, d] of df) idf.set(term, Math.log(1 + n / d));
  return idf;
}

/**
 * BM25-flavored score with IDF: saturating term frequency weighted by each term's IDF, so a match
 * on a rare/discriminative term dominates and a match on a generic term barely registers. A term the
 * corpus has never seen (not in `idf`) contributes nothing. Replaces the earlier IDF-less scorer
 * that let a lone "search" overlap pull in unrelated tools.
 */
function bm25Idf(terms: string[], doc: string, idf: Map<string, number>): number {
  const docTokens = tokenize(doc);
  if (docTokens.length === 0 || terms.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const w of docTokens) tf.set(w, (tf.get(w) ?? 0) + 1);
  const k1 = 1.5;
  let score = 0;
  for (const term of new Set(terms)) {
    const f = tf.get(term) ?? 0;
    if (f === 0) continue;
    const weight = idf.get(term) ?? 0; // unknown term ⇒ no contribution
    score += weight * ((f * (k1 + 1)) / (f + k1)) * (1 + term.length / 20);
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
