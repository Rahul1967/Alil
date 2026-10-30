import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TELEMETRY_SCHEMA_VERSION } from "./types.ts";
import type { TelemetryEvent } from "./types.ts";

/**
 * Reading telemetry back: load every process's files, then aggregate. Pure functions over events,
 * so the same code backs `npm run metrics`, a UI view, or a test.
 */

/** Load all `telemetry-*.jsonl[.N]` files in a directory, oldest rotation first; skip bad lines. */
export function readTelemetry(dir: string, opts: { since?: Date } = {}): TelemetryEvent[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^telemetry-.*\.jsonl(\.\d+)?$/.test(f))
    .sort((a, b) => rotation(b) - rotation(a) || a.localeCompare(b));
  const since = opts.since?.getTime();
  const out: TelemetryEvent[] = [];
  for (const f of files) {
    let raw: string;
    try { raw = readFileSync(join(dir, f), "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let e: TelemetryEvent;
      try { e = JSON.parse(line) as TelemetryEvent; } catch { continue; } // torn last line
      if (e?.v !== TELEMETRY_SCHEMA_VERSION || typeof e.kind !== "string" || typeof e.ts !== "string") continue;
      if (since !== undefined && Date.parse(e.ts) < since) continue;
      out.push(e);
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

function rotation(f: string): number {
  const m = /\.(\d+)$/.exec(f);
  return m ? Number(m[1]) : 0;
}

export interface Distribution {
  n: number;
  p50: number;
  p90: number;
  max: number;
  sum: number;
}

export function distribution(values: number[]): Distribution {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, p50: 0, p90: 0, max: 0, sum: 0 };
  const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))]!;
  return { n: v.length, p50: at(0.5), p90: at(0.9), max: v.at(-1)!, sum: v.reduce((s, x) => s + x, 0) };
}

export interface Summary {
  window: { from: string | null; to: string | null };
  turns: { count: number; byChannel: Record<string, number>; byStop: Record<string, number>; durationMs: Distribution; iterations: Distribution; queueWaitMs: Distribution };
  model: { calls: number; durationMs: Distribution; errors: Record<string, number>; byStopReason: Record<string, number>; retried: number };
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  cache: { hitRatio: number };
  cost: { totalUsd: number; perTurnUsd: Distribution };
  tools: { calls: number; byTool: Record<string, { calls: number; errors: number; denied: number; durationMs: Distribution; approvalWaitMs: number }> };
  mcp: { calls: number; byServer: Record<string, { calls: number; errors: number; refused: number; durationMs: Distribution }>; circuitOpens: number; toolChanges: number };
  recall: { calls: number; durationMs: Distribution; hits: Distribution };
  episodes: { distilled: number; fallbacks: number; durationMs: Distribution };
  errors: { count: number; byWhere: Record<string, number> };
  alerts: { count: number; byId: Record<string, number> };
  slowestTurns: Array<{ turnId: string; channel?: string; durationMs: number; stopReason?: string; ts: string }>;
}

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const bump = (m: Record<string, number>, k: unknown) => { const key = String(k ?? "unknown"); m[key] = (m[key] ?? 0) + 1; };

export function summarize(events: TelemetryEvent[]): Summary {
  const of = (k: string) => events.filter((e) => e.kind === k);
  const turnsEnd = of("turn.end");
  const modelCalls = of("model.call");
  const toolCalls = of("tool.call");
  const mcpCalls = of("mcp.call");

  const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let totalUsd = 0;
  const perTurnUsd: number[] = [];
  for (const t of turnsEnd) {
    const u = (t["usage"] ?? {}) as Record<string, unknown>;
    tokens.inputTokens += num(u["inputTokens"]);
    tokens.outputTokens += num(u["outputTokens"]);
    tokens.cacheReadTokens += num(u["cacheReadTokens"]);
    tokens.cacheWriteTokens += num(u["cacheWriteTokens"]);
    totalUsd += num(u["costUsd"]);
    perTurnUsd.push(num(u["costUsd"]));
  }
  const promptTokens = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;

  const byTool: Summary["tools"]["byTool"] = {};
  for (const [tool, list] of groupBy(toolCalls, (e) => String(e["tool"] ?? "unknown"))) {
    byTool[tool] = {
      calls: list.length,
      errors: list.filter((e) => e["outcome"] === "error").length,
      denied: list.filter((e) => e["outcome"] === "denied").length,
      durationMs: distribution(list.map((e) => num(e["durationMs"]) - num(e["approvalWaitMs"]))),
      approvalWaitMs: list.reduce((s, e) => s + num(e["approvalWaitMs"]), 0),
    };
  }
  const byServer: Summary["mcp"]["byServer"] = {};
  for (const [server, list] of groupBy(mcpCalls, (e) => String(e["server"] ?? "unknown"))) {
    byServer[server] = {
      calls: list.length,
      errors: list.filter((e) => e["outcome"] === "error").length,
      refused: list.filter((e) => e["outcome"] === "refused").length,
      durationMs: distribution(list.filter((e) => e["outcome"] !== "refused").map((e) => num(e["durationMs"]))),
    };
  }

  const modelErrors: Record<string, number> = {};
  const byStopReason: Record<string, number> = {};
  for (const m of modelCalls) {
    if (m["outcome"] === "error") bump(modelErrors, m["errorName"] ?? "error");
    else bump(byStopReason, m["rawStopReason"] ?? m["stopReason"]);
  }
  const byChannel: Record<string, number> = {};
  const byStop: Record<string, number> = {};
  for (const t of turnsEnd) { bump(byChannel, t.channel); bump(byStop, t["stopReason"]); }
  const errorsByWhere: Record<string, number> = {};
  for (const e of of("error")) bump(errorsByWhere, e["where"]);
  const alertsById: Record<string, number> = {};
  for (const a of of("alert")) if (a["state"] !== "resolved") bump(alertsById, a["id"]);
  const distills = of("episode.distill");

  return {
    window: { from: events[0]?.ts ?? null, to: events.at(-1)?.ts ?? null },
    turns: {
      count: turnsEnd.length, byChannel, byStop,
      durationMs: distribution(turnsEnd.map((t) => num(t["durationMs"]))),
      iterations: distribution(turnsEnd.map((t) => num(t["iterations"]))),
      queueWaitMs: distribution(of("turn.start").map((t) => num(t["queueWaitMs"]))),
    },
    model: {
      calls: modelCalls.length,
      durationMs: distribution(modelCalls.map((m) => num(m["durationMs"]))),
      errors: modelErrors, byStopReason,
      retried: modelCalls.filter((m) => num(m["attempt"]) > 1).length,
    },
    tokens,
    cache: { hitRatio: promptTokens > 0 ? tokens.cacheReadTokens / promptTokens : 0 },
    cost: { totalUsd, perTurnUsd: distribution(perTurnUsd) },
    tools: { calls: toolCalls.length, byTool },
    mcp: { calls: mcpCalls.length, byServer, circuitOpens: of("mcp.circuit").filter((e) => e["to"] === "open").length, toolChanges: of("mcp.tools_changed").length },
    recall: { calls: of("recall").length, durationMs: distribution(of("recall").map((e) => num(e["durationMs"]))), hits: distribution(of("recall").map((e) => num(e["hits"]))) },
    episodes: { distilled: distills.length, fallbacks: distills.filter((e) => e["via"] === "extractive-fallback").length, durationMs: distribution(distills.map((e) => num(e["durationMs"]))) },
    errors: { count: of("error").length, byWhere: errorsByWhere },
    alerts: { count: Object.values(alertsById).reduce((s, n) => s + n, 0), byId: alertsById },
    slowestTurns: [...turnsEnd]
      .sort((a, b) => num(b["durationMs"]) - num(a["durationMs"]))
      .slice(0, 5)
      .map((t) => ({ turnId: String(t.turnId ?? "?"), ...(t.channel ? { channel: t.channel } : {}), durationMs: num(t["durationMs"]), ...(t["stopReason"] ? { stopReason: String(t["stopReason"]) } : {}), ts: t.ts })),
  };
}

export interface TimelineRow {
  ts: string;
  offsetMs: number;
  kind: string;
  event: TelemetryEvent;
}

/** One turn's events in order, each with its offset from the turn's first event. */
export function turnTimeline(events: TelemetryEvent[], turnId: string): TimelineRow[] {
  const mine = events.filter((e) => e.turnId === turnId).sort((a, b) => a.ts.localeCompare(b.ts));
  const start = mine.length > 0 ? Date.parse(mine[0]!.ts) : 0;
  return mine.map((e) => ({ ts: e.ts, offsetMs: Date.parse(e.ts) - start, kind: e.kind, event: e }));
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x); else m.set(k, [x]);
  }
  return m;
}
