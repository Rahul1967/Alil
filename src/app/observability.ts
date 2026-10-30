import { join } from "node:path";
import { readdirSync, rmSync, statSync, existsSync } from "node:fs";
import type { MemoryPort } from "../runtime/types.ts";
import type { Fragment } from "../core/types.ts";
import type { McpObserver } from "../execution/mcp/types.ts";
import { McpToolPins, filePinStore } from "../execution/mcp/pins.ts";
import type { AuditLedger } from "../gateway/index.ts";
import {
  Telemetry, JsonlFileSink, Heartbeats, InvariantMonitor, installTelemetry,
} from "../telemetry/index.ts";
import type { HeartbeatStore, Invariant, EventRule, Alert, TelemetryEvent } from "../telemetry/index.ts";

/**
 * Observability wiring for one Alil process: the telemetry emitter and its file, heartbeats shared
 * through memory.db, the audit → telemetry tap, the MCP observer (timings, circuit, tool pins), and
 * the invariant monitor's rules. Kept out of the core so the core only plugs these in.
 *
 * Telemetry goes to `<stateDir>/logs/telemetry-<process>-<pid>.jsonl` (one file per process, so the
 * Telegram bot and the UI server never contend), never into the hash-chained audit ledger.
 *
 * Environment: ALIL_TELEMETRY=0 turns it off; ALIL_TELEMETRY_CONTENT=1 also records message text,
 * tool args and error bodies; ALIL_TELEMETRY_RETAIN_DAYS (default 30) prunes old files at start.
 */
export interface ObservabilityOptions {
  process: string;
  stateDir: string;
  /** An injected emitter (tests); `false` disables. Default: built from the environment. */
  telemetry?: Telemetry | false;
}

export function buildTelemetry(opts: ObservabilityOptions): Telemetry {
  if (opts.telemetry instanceof Telemetry) return opts.telemetry;
  if (opts.telemetry === false || process.env.ALIL_TELEMETRY === "0") return Telemetry.noop(opts.process);
  const dir = telemetryDir(opts.stateDir);
  pruneTelemetry(dir, Number(process.env.ALIL_TELEMETRY_RETAIN_DAYS ?? 30));
  try {
    const sink = new JsonlFileSink(join(dir, `telemetry-${safe(opts.process)}-${process.pid}.jsonl`));
    return new Telemetry({ sink, process: opts.process, content: process.env.ALIL_TELEMETRY_CONTENT === "1" });
  } catch {
    return Telemetry.noop(opts.process); // unwritable logs dir: run without telemetry, never crash
  }
}

export function telemetryDir(stateDir: string): string {
  return join(stateDir, "logs");
}

/** Delete telemetry files not modified within `days` (0 or invalid ⇒ keep everything). */
export function pruneTelemetry(dir: string, days: number): void {
  if (!Number.isFinite(days) || days <= 0 || !existsSync(dir)) return;
  const cutoff = Date.now() - days * 86_400_000;
  try {
    for (const f of readdirSync(dir)) {
      if (!/^telemetry-.*\.jsonl(\.\d+)?$/.test(f)) continue;
      const p = join(dir, f);
      if (statSync(p).mtimeMs < cutoff) rmSync(p);
    }
  } catch { /* best effort */ }
}

export function install(t: Telemetry): void {
  installTelemetry(t);
}

/** Time every recall and record how many fragments came back from which sources. */
export function tapRecallTelemetry(inner: MemoryPort, t: Telemetry): MemoryPort {
  return {
    async recall(query: string): Promise<Fragment[]> {
      const started = Date.now();
      try {
        const frags = await inner.recall(query);
        const bySource: Record<string, number> = {};
        for (const f of frags) { const k = f.provenance.origin; bySource[k] = (bySource[k] ?? 0) + 1; }
        t.emit("recall", { durationMs: Date.now() - started, hits: frags.length, bySource, queryChars: query.length }, { query });
        return frags;
      } catch (err) {
        t.error("recall", err, { durationMs: Date.now() - started });
        throw err;
      }
    },
  };
}

/** Ledger events that matter for monitoring, mirrored into telemetry without args or reasons. */
const AUDIT_FIELDS = ["tool", "effect", "risk", "decision", "decidedBy", "resolution", "by", "tainted", "approvalWaitMs", "stopReason", "via", "lines"] as const;

export interface AuditSinkLike { append(evt: string, fields?: Record<string, unknown>): unknown }

export function tapAuditTelemetry(inner: AuditSinkLike, t: Telemetry): AuditSinkLike {
  return {
    append(evt: string, fields: Record<string, unknown> = {}) {
      const out = inner.append(evt, fields);
      try {
        const picked: Record<string, unknown> = { evt };
        for (const k of AUDIT_FIELDS) if (fields[k] !== undefined) picked[k] = fields[k];
        t.emit("audit", picked);
      } catch { /* telemetry never breaks the ledger */ }
      return out;
    },
  };
}

/** Telemetry for MCP calls, connects and circuit transitions, plus tool-definition pinning. */
export function mcpTelemetry(t: Telemetry, pinsPath: string): McpObserver {
  const pins = new McpToolPins(filePinStore(pinsPath));
  return {
    onCall: (e) => { const { error, ...f } = e; t.emit("mcp.call", f, error ? { error } : undefined); },
    onConnect: (e) => { const { error, ...f } = e; t.emit("mcp.connect", f, error ? { error } : undefined); },
    onCircuit: (e) => t.emit("mcp.circuit", e),
    onToolsListed: (server, tools) => {
      const r = pins.check(server, tools);
      if (r.firstSeen || r.added.length + r.changed.length + r.removed.length === 0) return;
      t.emit("mcp.tools_changed", { server, added: r.added, changed: r.changed, removed: r.removed });
    },
  };
}

/** memory.db's kv table as the cross-process heartbeat store. */
export function kvHeartbeatStore(db: { prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } }): HeartbeatStore {
  const put = db.prepare("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const all = db.prepare("SELECT key, value FROM kv WHERE key LIKE 'heartbeat:%'");
  return {
    save: (k, v) => { put.run(k, v); },
    loadAll: () => (all.all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
  };
}

export function newHeartbeats(process: string, store?: HeartbeatStore): Heartbeats {
  return new Heartbeats({ process, ...(store ? { store } : {}) });
}

// ── invariants and rules ─────────────────────────────────────────────────────

export interface InvariantDeps {
  ledger: AuditLedger;
  memoryOn: boolean;
  heartbeats: Heartbeats;
  /** A loop of THIS process that has beaten before but not within this long is stale. */
  staleMs: number;
  /** Re-verify the whole ledger no more often than this. Default 10 min. */
  ledgerEveryMs?: number;
}

/** The invariants Alil alerts on. Each is a fact that must hold; none is a percentile. */
export function coreInvariants(d: InvariantDeps): Invariant[] {
  const every = d.ledgerEveryMs ?? 10 * 60_000;
  let lastLedger: { at: number; ok: boolean; detail?: string } | null = null;
  const inv: Invariant[] = [
    {
      id: "memory.on",
      describe: "memory is available (without it nothing is remembered between turns)",
      check: () => (d.memoryOn ? { ok: true } : { ok: false, detail: "memory.db could not be opened; running without persistence" }),
    },
    {
      id: "ledger.verify",
      describe: "the audit ledger's hash chain verifies",
      check: () => {
        if (!lastLedger || Date.now() - lastLedger.at >= every) {
          const v = d.ledger.verify() as { ok: boolean; brokenAtSeq?: number; reason?: string };
          lastLedger = v.ok ? { at: Date.now(), ok: true } : { at: Date.now(), ok: false, detail: `broken at seq ${v.brokenAtSeq ?? "?"}: ${v.reason ?? ""}` };
        }
        return lastLedger.ok ? { ok: true } : { ok: false, ...(lastLedger.detail ? { detail: lastLedger.detail } : {}) };
      },
    },
  ];
  inv.push({
    id: "heartbeats.fresh",
    describe: "this process's background loops (scheduler, poller, episode sweep) keep running",
    check: () => {
      // Only loops this process has started count: one that never beat is not stale, just absent.
      const stale = d.heartbeats.local().filter((b) => b.ageMs > d.staleMs);
      return stale.length === 0 ? { ok: true } : { ok: false, detail: stale.map((b) => `${b.name}: no beat for ${Math.round(b.ageMs / 1000)}s`).join("; ") };
    },
  });
  return inv;
}

/** Event rules: things that, when they happen at all, the operator should hear about. */
export function coreRules(): EventRule[] {
  const audit = (e: TelemetryEvent, ...resolutions: string[]) => e.kind === "audit" && resolutions.includes(String(e["resolution"]));
  return [
    {
      id: "approval.binding-mismatch",
      describe: "an approved action never changes between approval and execution",
      match: (e) => (audit(e, "denied:binding-mismatch") ? `${String(e["tool"])} changed after approval and was not run` : null),
      key: (e) => String(e["tool"]),
    },
    {
      id: "approval.channel",
      describe: "approval requests reach the operator",
      match: (e) => (audit(e, "denied:approval-error", "no-channel", "denied:no-approval-channel")
        ? `${String(e["tool"])} could not be put to you (${String(e["resolution"])}) and was not run` : null),
      key: (e) => String(e["resolution"]),
    },
    {
      id: "mcp.tools-changed",
      describe: "an MCP server's tool definitions don't change silently",
      match: (e) => (e.kind === "mcp.tools_changed"
        ? `${String(e["server"])}: changed [${(e["changed"] as string[]).join(", ")}] added [${(e["added"] as string[]).join(", ")}] removed [${(e["removed"] as string[]).join(", ")}]` : null),
      key: (e) => String(e["server"]),
    },
    {
      id: "reminder.delivery",
      describe: "a due reminder is delivered",
      match: (e) => (e.kind === "error" && e["where"] === "scheduler.deliver" ? `a reminder failed to deliver (${String(e["message"] ?? "")}); it will be retried` : null),
    },
  ];
}

export function buildMonitor(t: Telemetry, invariants: Invariant[], deliver?: (a: Alert) => Promise<void> | void): InvariantMonitor {
  return new InvariantMonitor({ telemetry: t, invariants, rules: coreRules(), ...(deliver ? { deliver } : {}) });
}

/** How an alert reads to the operator. */
export function alertText(a: Alert): string {
  return a.state === "resolved"
    ? `✅ Resolved: ${a.describe}`
    : `🚨 ${a.describe} — not true right now.${a.detail ? `\n${a.detail}` : ""}`;
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}
