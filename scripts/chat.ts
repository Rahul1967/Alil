/**
 * Terminal channel — a thin adapter over the shared Alil core (src/app/core.ts). It supplies only
 * what is terminal-specific: readline I/O, an approval prompt, a trace observer, and how a
 * proactive message is printed. Everything else (brain, policy, memory, world-model, planner,
 * subagents, ambient ingestion) comes from createAlil, so this channel has the same capabilities
 * as the browser and telegram channels by construction.
 *
 * Run:  node --experimental-strip-types --env-file=.env scripts/chat.ts
 * Exit: Ctrl-C, or type /exit
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createAlil, debugEnabled } from "../src/app/index.ts";
import type { ChannelBinding } from "../src/app/index.ts";
import type { ApprovalPort, ApprovalRequest, ApprovalDecision } from "../src/policy/index.ts";
import type { BrainObserver } from "../src/runtime/types.ts";
import type { PlanNode } from "../src/runtime/index.ts";

const modelId = process.env.BEDROCK_MODEL_ID ?? "global.anthropic.claude-sonnet-5";
const rl = createInterface({ input: stdin, output: stdout });

// ── Terminal-specific channel bits ─────────────────────────────────────────────
const approvals: ApprovalPort = {
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const a = req.action;
    console.log(
      `\n  ⚠ approval needed: ${a.tool} (${a.effect}/${a.risk})\n` +
        `    args: ${JSON.stringify(a.args).slice(0, 200)}\n` +
        `    reason: ${req.reason}`,
    );
    let ans: string;
    try {
      ans = (await rl.question("    [y] once  [g] grant 10×/30m  [n] deny › ")).trim().toLowerCase();
    } catch {
      return { approved: false, reason: "no input" };
    }
    if (ans === "y") return { approved: true };
    if (ans === "g") return { approved: true, scope: { tool: a.tool, maxUses: 10, ttlMs: 30 * 60_000, task: "repl-session" } };
    return { approved: false, reason: "operator declined" };
  },
};

const OUTCOME = { ok: "✓", error: "✗", denied: "⛔" } as const;
const observer: BrainObserver = {
  onModelTurn(e) {
    if (e.toolCalls > 0) console.log(`  · thinking (turn ${e.iteration}) → ${e.toolCalls} tool call${e.toolCalls > 1 ? "s" : ""}`);
  },
  onToolCall(e) {
    const args = JSON.stringify(e.args);
    console.log(`  → ${e.tool} ${args.length > 120 ? args.slice(0, 120) + "…" : args}`);
  },
  onToolResult(e) {
    console.log(`    ${OUTCOME[e.outcome]} ${e.outcome}: ${e.summary}`);
  },
  onHalt(e) {
    console.log(`  ⏹ halted (${e.kind}): ${e.reason}`);
  },
};

const debug = debugEnabled();
const binding: ChannelBinding = {
  channel: "terminal",
  approvals,
  // In debug mode the richer debug trace replaces this display observer, so we don't print twice.
  ...(debug ? {} : { observer }),
  notify: async (text, meta) => {
    const tag = meta.source === "scheduled" ? `⏰ ${meta.label ?? ""}` : `🔔 (ambient · ${meta.label ?? ""})`;
    stdout.write(`\n${tag} › ${text}\n\nyou › `);
  },
};

const alil = createAlil({ modelId, debug }, binding);
alil.start();
console.log(`Alil terminal channel · model: ${modelId} · memory: ${alil.memoryOn ? "on" : "off"}${debug ? " · debug: on" : ""}`);

// ── REPL loop ───────────────────────────────────────────────────────────────
let current: AbortController | null = null;
process.on("SIGINT", () => {
  if (current) { current.abort(); current = null; console.log("\n  (cancelled)\n"); }
  else { console.log("\nbye"); alil.stop(); process.exit(0); }
});

async function runPlan(goal: string, dryRun: boolean): Promise<void> {
  const result = await alil.runPlan(goal, {
    dryRun,
    approvePlan: async (nodes: PlanNode[]): Promise<boolean> => {
      console.log(`\n  plan for: ${goal}`);
      for (const n of nodes) console.log(`    ${n.id}. ${n.description}${n.deps.length ? ` (after ${n.deps.join(", ")})` : ""}`);
      if (dryRun) return true;
      try {
        return (await rl.question("  approve this plan? [y] run  [n] cancel › ")).trim().toLowerCase() === "y";
      } catch {
        return false;
      }
    },
    observer: {
      onNodeStart: (n) => console.log(`  ▶ ${n.id}: ${n.description}`),
      onNodeDone: (n, ok) => console.log(`    ${ok ? "✓" : "✗"} ${n.summary ?? ""}`),
      onReplan: (f, attempt) => console.log(`  ↻ replanning (attempt ${attempt}) after: ${f.summary}`),
    },
  });
  if (result.status === "planned") console.log(`  (plan only — ${result.nodes.length} steps, not executed)\n`);
  else console.log(`  plan ${result.status}${result.reason ? `: ${result.reason}` : ""} (${result.replans} replan${result.replans === 1 ? "" : "s"})\n`);
}

for (;;) {
  let text: string;
  try {
    text = (await rl.question("you › ")).trim();
  } catch {
    break;
  }
  if (text === "/exit" || text === "/quit") break;
  if (text.length === 0) continue;

  const planMatch = text.match(/^\/plan(-dry)?\s+([\s\S]+)$/);
  if (planMatch) {
    await runPlan(planMatch[2]!.trim(), planMatch[1] === "-dry").catch((e) => console.log(`  [plan error] ${(e as Error).message}\n`));
    continue;
  }
  if (text.startsWith("/event ")) {
    try {
      await alil.ingestEvent(JSON.parse(text.slice(7)) as Record<string, unknown>);
      console.log(`  · event ingested\n`);
    } catch (e) {
      console.log(`  [event error] ${(e as Error).message}\n`);
    }
    continue;
  }

  current = new AbortController();
  try {
    const turn = await alil.runTurn(text, { origin: "operator" }, { signal: current.signal });
    if (turn.stopReason === "error") console.log(`alil › [error] ${turn.haltReason}\n`);
    else if (turn.stopReason === "aborted") console.log(`alil › [cancelled]\n`);
    else if (turn.stopReason === "guard_halt") console.log(`alil › [halted: ${turn.haltReason}] ${turn.assistantText ?? ""}\n`);
    else console.log(`alil › ${turn.assistantText ?? "(no text)"}\n      (iterations: ${turn.iterations})\n`);
  } catch (e) {
    console.log(`alil › [crash] ${(e as Error).message}\n`);
  } finally {
    current = null;
  }
}

alil.stop();
rl.close();
