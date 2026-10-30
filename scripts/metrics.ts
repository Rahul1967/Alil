/**
 * Telemetry report. Reads every process's `telemetry-*.jsonl` under the state dir's logs folder.
 *
 *   npm run metrics                 # last 24 h
 *   npm run metrics -- --since 7d   # or 12h, 30m, all
 *   npm run metrics -- turn <id>    # one turn's timeline
 *   npm run metrics -- --json       # the raw summary, for scripts
 *
 * Honors ALIL_STATE_DIR (default "workspace"), or --dir <logs folder>.
 */
import { join } from "node:path";
import { readTelemetry, summarize, turnTimeline } from "../src/telemetry/index.ts";
import type { Distribution, Summary } from "../src/telemetry/index.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dir = flag("--dir") ?? join(process.env.ALIL_STATE_DIR ?? "workspace", "logs");

function sinceDate(spec: string): Date | undefined {
  if (spec === "all") return undefined;
  const m = /^(\d+)(m|h|d)$/.exec(spec);
  if (!m) throw new Error(`--since: expected e.g. 30m, 12h, 7d or all — got "${spec}"`);
  const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return new Date(Date.now() - ms);
}

const secs = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const dist = (d: Distribution) => (d.n === 0 ? "—" : `p50 ${secs(d.p50)} · p90 ${secs(d.p90)} · max ${secs(d.max)} (n=${d.n})`);
const kv = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") || "—";
const usd = (x: number) => `$${x.toFixed(x < 1 ? 4 : 2)}`;

if (argv[0] === "turn") {
  const id = argv[1];
  if (!id) { console.error("usage: npm run metrics -- turn <turnId>"); process.exit(2); }
  const rows = turnTimeline(readTelemetry(dir), id);
  if (rows.length === 0) { console.error(`no telemetry for turn ${id} in ${dir}`); process.exit(1); }
  console.log(`turn ${id} — ${rows[0]!.ts}\n`);
  for (const r of rows) {
    const e = r.event;
    const bits = ["tool", "server", "outcome", "stopReason", "rawStopReason", "attempt", "errorName", "resolution", "by", "hits"]
      .filter((k) => e[k] !== undefined).map((k) => `${k}=${String(e[k])}`);
    const dur = typeof e["durationMs"] === "number" ? ` (${secs(e["durationMs"] as number)})` : "";
    const wait = typeof e["approvalWaitMs"] === "number" && (e["approvalWaitMs"] as number) > 0 ? ` [waited ${secs(e["approvalWaitMs"] as number)} for approval]` : "";
    console.log(`+${secs(r.offsetMs).padStart(6)}  ${r.kind.padEnd(16)} ${bits.join(" ")}${dur}${wait}`);
  }
  process.exit(0);
}

const sinceSpec = flag("--since") ?? "24h";
const events = readTelemetry(dir, { ...(sinceDate(sinceSpec) ? { since: sinceDate(sinceSpec)! } : {}) });
const s: Summary = summarize(events);
if (argv.includes("--json")) { console.log(JSON.stringify(s, null, 2)); process.exit(0); }

if (events.length === 0) {
  console.log(`No telemetry in ${dir} for --since ${sinceSpec}. (Telemetry starts recording once the channels run this version.)`);
  process.exit(0);
}

const modelMs = s.model.durationMs.sum;
const toolMs = Object.values(s.tools.byTool).reduce((a, t) => a + t.durationMs.sum, 0);
const waitMs = Object.values(s.tools.byTool).reduce((a, t) => a + t.approvalWaitMs, 0);
const total = s.turns.durationMs.sum || 1;
const pct = (x: number) => `${Math.round((100 * x) / total)}%`;

console.log(`Alil telemetry — ${s.window.from} → ${s.window.to}  (${events.length} events, --since ${sinceSpec})\n`);
console.log(`Turns       ${s.turns.count}  ·  ${kv(s.turns.byChannel)}`);
console.log(`  duration  ${dist(s.turns.durationMs)}`);
console.log(`  queued    ${dist(s.turns.queueWaitMs)}`);
console.log(`  ended     ${kv(s.turns.byStop)}`);
console.log(`  time      model ${pct(modelMs)} · tools ${pct(toolMs)} · waiting for you ${pct(waitMs)}`);
console.log(`Model       ${s.model.calls} calls · ${dist(s.model.durationMs)} · retried ${s.model.retried}`);
console.log(`  stopped   ${kv(s.model.byStopReason)}`);
console.log(`  errors    ${kv(s.model.errors)}`);
console.log(`Tokens      in ${s.tokens.inputTokens} · out ${s.tokens.outputTokens} · cache read ${s.tokens.cacheReadTokens} · cache write ${s.tokens.cacheWriteTokens}  (cache hit ${(s.cache.hitRatio * 100).toFixed(0)}%)`);
console.log(`Cost        ${usd(s.cost.totalUsd)} · per turn p50 ${usd(s.cost.perTurnUsd.p50)} · max ${usd(s.cost.perTurnUsd.max)}`);
console.log(`Tools       ${s.tools.calls} calls`);
for (const [tool, t] of Object.entries(s.tools.byTool).sort((a, b) => b[1].calls - a[1].calls)) {
  console.log(`  ${tool.padEnd(22)} ${String(t.calls).padStart(4)} · err ${t.errors} · denied ${t.denied} · run ${dist(t.durationMs)}${t.approvalWaitMs ? ` · waited ${secs(t.approvalWaitMs)}` : ""}`);
}
console.log(`MCP         ${s.mcp.calls} calls · circuit opened ${s.mcp.circuitOpens} · tool definitions changed ${s.mcp.toolChanges}`);
for (const [server, m] of Object.entries(s.mcp.byServer)) {
  console.log(`  ${server.padEnd(22)} ${String(m.calls).padStart(4)} · err ${m.errors} · refused ${m.refused} · ${dist(m.durationMs)}`);
}
console.log(`Recall      ${s.recall.calls} · ${dist(s.recall.durationMs)} · hits p50 ${s.recall.hits.p50}`);
console.log(`Episodes    distilled ${s.episodes.distilled} · fell back ${s.episodes.fallbacks} · ${dist(s.episodes.durationMs)}`);
console.log(`Errors      ${s.errors.count}  ·  ${kv(s.errors.byWhere)}`);
console.log(`Alerts      ${s.alerts.count}  ·  ${kv(s.alerts.byId)}`);
if (s.slowestTurns.length) {
  console.log(`\nSlowest turns (npm run metrics -- turn <id>):`);
  for (const t of s.slowestTurns) console.log(`  ${secs(t.durationMs).padStart(6)}  ${t.turnId}  ${t.channel ?? ""}  ${t.stopReason ?? ""}  ${t.ts}`);
}
