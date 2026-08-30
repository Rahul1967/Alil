import type { BrainObserver, WorldPort, MemoryPort, BrainTurn } from "../runtime/types.ts";
import type { Fragment, Provenance } from "../core/types.ts";

/** Debug mode is on with `--debug` in argv, ALIL_DEBUG=1, or `npm run <ch> --debug` (npm_config_debug). */
export function debugEnabled(): boolean {
  return process.argv.includes("--debug") || process.env.ALIL_DEBUG === "1" || !!process.env["npm_config_debug"];
}

const useColor = !!process.stderr.isTTY && process.env.NO_COLOR === undefined;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c("2"), bold = c("1"), cyan = c("36"), green = c("32"), red = c("31"), amber = c("33"), blue = c("34"), mag = c("35");

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + dim("…") : s;
}
function pretty(data: unknown): string {
  if (data === undefined) return "";
  if (typeof data === "string") return clip(data.replace(/\n/g, "⏎"), 300);
  try { return clip(JSON.stringify(data), 400); } catch { return String(data); }
}
function tag(p: Provenance): string {
  const tainted = p.origin === "ingested" || (p.taintedBy?.length ?? 0) > 0;
  return tainted ? amber(p.origin + "⚠") : p.origin;
}

/**
 * DebugLogger — a clean, framed, real-time trace of everything a turn does: context recall, the
 * present-tense state it saw, each model round, every tool call with full args, the policy verdict
 * for it, the tool response (including memory reads/writes), guard halts, and ambient/plan events.
 * Writes to stderr so it never mixes into a channel's user-facing output. Implements BrainObserver
 * and is fed audit + recall + world taps by the core.
 */
export class DebugLogger implements BrainObserver {
  #t0 = 0;
  #open = false;

  #line(s: string): void {
    process.stderr.write((this.#open ? dim("│ ") : "") + s + "\n");
  }

  turnStart(channel: string, kind: string, text: string, p: Provenance): void {
    this.#t0 = Date.now();
    this.#open = true;
    process.stderr.write(dim("╭─ ") + bold(kind) + dim(" ▸ ") + cyan(channel) + dim(" ▸ ") + tag(p) + "\n");
    this.#line(dim('  "') + clip(text.replace(/\n/g, " "), 160) + dim('"'));
  }

  recall(frags: Fragment[]): void {
    if (!this.#open) return;
    this.#line(mag("⟐ recall ") + dim(`${frags.length} fragment${frags.length === 1 ? "" : "s"}`));
    for (const f of frags.slice(0, 8)) {
      this.#line(dim("   · ") + tag(f.provenance) + (f.source ? dim(" " + f.source) : "") + "  " + dim(clip(f.text.replace(/\n/g, " "), 110)));
    }
  }

  worldState(block: string | null): void {
    if (!this.#open) return;
    if (!block) { this.#line(mag("⟐ world  ") + dim("(empty)")); return; }
    const head = block.split("\n").filter((l) => !l.startsWith("  ")).join(" · ");
    this.#line(mag("⟐ world  ") + dim(clip(head, 120)));
  }

  onModelTurn(e: { iteration: number; text?: string; toolCalls: number }): void {
    if (!this.#open) return;
    const calls = e.toolCalls > 0 ? blue(`→ ${e.toolCalls} tool call${e.toolCalls > 1 ? "s" : ""}`) : dim("(final)");
    this.#line(bold(`▸ model iter${e.iteration}  `) + calls + (e.text && e.toolCalls === 0 ? dim("  " + clip(e.text.replace(/\n/g, " "), 120)) : ""));
  }

  onToolCall(e: { tool: string; args: Record<string, unknown> }): void {
    if (!this.#open) return;
    this.#line(blue("   → ") + cyan(e.tool) + "  " + dim(pretty(e.args)));
  }

  onToolResult(e: { tool: string; outcome: string; summary: string; data?: unknown }): void {
    if (!this.#open) return;
    const mark = e.outcome === "ok" ? green("✓") : e.outcome === "denied" ? red("⛔") : red("✗");
    this.#line("   " + mark + " " + cyan(e.tool) + "  " + e.summary + (e.data !== undefined ? dim("  ⇢ " + pretty(e.data)) : ""));
  }

  onHalt(e: { reason: string; kind: string }): void {
    if (!this.#open) return;
    this.#line(red(`⏹ halt (${e.kind}) `) + dim(e.reason));
  }

  /** Fed from the audit sink — surfaces policy verdicts, ambient events, memory writes inline. */
  audit(evt: string, f: Record<string, unknown>): void {
    if (!this.#open && evt !== "ingest" && evt !== "wake" && evt !== "plan") return;
    if (evt === "turn") return; // covered by turnEnd
    if (evt === "policy") {
      const decision = String(f["decision"]);
      const color = decision === "deny" ? red : decision === "allow" ? green : amber;
      const taint = f["tainted"] ? amber(` ⚠tainted[${(f["taintedBy"] as string[] | undefined)?.join(",") ?? ""}]`) : "";
      this.#line(dim("     ⚖ policy  ") + color(decision) + dim(` [${f["decidedBy"]}] → `) + String(f["resolution"]) + taint);
      return;
    }
    if (evt === "ingest") { process.stderr.write(dim("· ingest ▸ ") + cyan(String(f["channel"])) + dim(` origin=${f["origin"]}${f["from"] ? " from=" + f["from"] : ""}`) + "\n"); return; }
    if (evt === "wake") { process.stderr.write(amber("· wake ▸ ") + dim(`rule=${f["rule"]} channel=${f["channel"]}`) + "\n"); return; }
    if (evt === "wake.throttled") { process.stderr.write(dim(`· wake throttled (rule=${f["rule"]})`) + "\n"); return; }
    if (evt === "plan") { this.#line(dim("  ⌘ plan  ") + `${f["status"]} · ${f["nodes"]} nodes · ${f["replans"]} replans`); return; }
    // episode.distill / canonical.tool and anything else
    this.#line(dim(`  · ${evt}  ${pretty(f)}`));
  }

  turnEnd(turn: BrainTurn): void {
    if (!this.#open) return;
    const ms = Date.now() - this.#t0;
    const dur = ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
    const ok = turn.stopReason === "complete";
    const status = ok ? green(turn.stopReason) : amber(turn.stopReason + (turn.haltReason ? ": " + turn.haltReason : ""));
    process.stderr.write(dim("╰─ ") + status + dim(` ▸ ${turn.iterations} iter${turn.iterations === 1 ? "" : "s"} ▸ ${dur}`) + "\n\n");
    this.#open = false;
  }
}

/** Combine two observers (channel trace + debug) — each optional method fires on both. */
export function composeObservers(a: BrainObserver | undefined, b: BrainObserver): BrainObserver {
  if (!a) return b;
  return {
    onModelTurn: (e) => { a.onModelTurn?.(e); b.onModelTurn?.(e); },
    onToolCall: (e) => { a.onToolCall?.(e); b.onToolCall?.(e); },
    onToolResult: (e) => { a.onToolResult?.(e); b.onToolResult?.(e); },
    onHalt: (e) => { a.onHalt?.(e); b.onHalt?.(e); },
  };
}

/** Wrap a MemoryPort so recall results are logged as they're fetched. */
export function tapRecall(inner: MemoryPort, log: DebugLogger): MemoryPort {
  return {
    async recall(query: string): Promise<Fragment[]> {
      const frags = await inner.recall(query);
      log.recall(frags);
      return frags;
    },
  };
}

/** Wrap a WorldPort so the injected present-tense state is logged each turn. */
export function tapWorld(inner: WorldPort, log: DebugLogger): WorldPort {
  return {
    stateBlock(): string | null {
      const block = inner.stateBlock();
      log.worldState(block);
      return block;
    },
  };
}

export interface AuditSink { append(evt: string, fields?: Record<string, unknown>): unknown }

/** Wrap an audit sink so every recorded event is also printed by the debug logger. */
export function tapAudit(inner: AuditSink, log: DebugLogger): AuditSink {
  return {
    append(evt: string, fields: Record<string, unknown> = {}) {
      log.audit(evt, fields);
      return inner.append(evt, fields);
    },
  };
}
