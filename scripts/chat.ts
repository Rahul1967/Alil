/**
 * Interactive dev REPL for the brain. Wires the Bedrock provider, the real policy
 * boundary (fs.read/fs.write, credential blocks), and operator approval over the REPL.
 *
 * Run:  node --experimental-strip-types --env-file=.env scripts/chat.ts
 * Exit: Ctrl-C, or type /exit
 *
 * Reads under workspace/ run automatically; writes/high-risk actions prompt for approval
 * ([y] once, [g] grant a short reusable scope, [n] deny). Credential paths are blocked.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Brain } from "../src/runtime/loop.ts";
import type { BrainPorts } from "../src/runtime/loop.ts";
import { DEFAULT_GUARDS } from "../src/runtime/types.ts";
import { ProviderRegistry, BedrockProvider } from "../src/providers/index.ts";
import { PromptAssembler, FilePersonaSource } from "../src/prompts/index.ts";
import { PolicyBoundary, YamlRuleSource, credentialBlock, GrantStore } from "../src/policy/index.ts";
import type { ApprovalPort, ApprovalRequest, ApprovalDecision } from "../src/policy/index.ts";
import { ToolRegistry, Executor, Sandbox, ReadTracker, RegistryToolCatalog, DEFAULT_TOOLS } from "../src/execution/index.ts";
import { openMemory, EpisodeManager, ExtractiveSummarizer, CanonicalKnowledge, seedMemoryInstructions } from "../src/memory/index.ts";
import type { MemorySystem, MemoryStore } from "../src/memory/index.ts";
import type { KnowledgeSource } from "../src/prompts/types.ts";
import { AuditLedger } from "../src/gateway/index.ts";
import type { MemoryPort } from "../src/runtime/types.ts";
import type { BrainInput } from "../src/runtime/types.ts";
import type { TranscriptLine } from "../src/core/types.ts";

const modelId = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

const registry = new ProviderRegistry().register(new BedrockProvider());
const audit = new AuditLedger("workspace/logs/audit.jsonl");

const rl = createInterface({ input: stdin, output: stdout });

// Operator approval over the REPL. Fail-closed: unclear/empty answer ⇒ deny.
const approvals: ApprovalPort = {
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const a = req.action;
    const argsPreview = JSON.stringify(a.args).slice(0, 200);
    console.log(
      `\n  ⚠ approval needed: ${a.tool} (${a.effect}/${a.risk})\n` +
        `    args: ${argsPreview}\n` +
        `    reason: ${req.reason}`,
    );
    let ans: string;
    try {
      ans = (await rl.question("    [y] once  [g] grant 10×/30m  [n] deny › ")).trim().toLowerCase();
    } catch {
      return { approved: false, reason: "no input" };
    }
    if (ans === "y") return { approved: true };
    if (ans === "g") {
      return {
        approved: true,
        scope: { tool: a.tool, maxUses: 10, ttlMs: 30 * 60_000, task: "repl-session" },
      };
    }
    return { approved: false, reason: "operator declined" };
  },
};

// Sandbox root: defaults to workspace/, override with ALIL_SANDBOX_ROOT (e.g. /home/user).
const sandboxRoot = process.env.ALIL_SANDBOX_ROOT ?? "workspace";
const tools = new ToolRegistry();
// Mutable holder: memory opens after the boundary, so the memory.* tools get their store
// wired in below once it's available.
const memCtx: { store?: MemoryStore } = {};
const boundary = new PolicyBoundary({
  rules: new YamlRuleSource("config/policy.yaml"),
  tools,
  hooks: [credentialBlock],
  executor: new Executor({ sandbox: new Sandbox(sandboxRoot), reads: new ReadTracker(), memory: memCtx }),
  approvals,
  grants: new GrantStore(),
});

// Live trace of what happens inside a turn: model thinking, tool calls, and outcomes.
const OUTCOME_MARK = { ok: "✓", error: "✗", denied: "⛔" } as const;
const observer = {
  onModelTurn(e: { iteration: number; text?: string; toolCalls: number }) {
    if (e.toolCalls > 0) {
      console.log(`  · thinking (turn ${e.iteration}) → ${e.toolCalls} tool call${e.toolCalls > 1 ? "s" : ""}`);
    }
  },
  onToolCall(e: { tool: string; args: Record<string, unknown> }) {
    const args = JSON.stringify(e.args);
    console.log(`  → ${e.tool} ${args.length > 120 ? args.slice(0, 120) + "…" : args}`);
  },
  onToolResult(e: { tool: string; outcome: "ok" | "error" | "denied"; summary: string }) {
    console.log(`    ${OUTCOME_MARK[e.outcome]} ${e.outcome}: ${e.summary}`);
    // Audit model-driven canonical memory writes (memory.write / memory.forget).
    if (e.tool.startsWith("memory.") && e.tool !== "memory.read") {
      audit.append("canonical.tool", { tool: e.tool, outcome: e.outcome, summary: e.summary });
    }
  },
  onHalt(e: { reason: string; kind: "guard" | "error" }) {
    console.log(`  ⏹ halted (${e.kind}): ${e.reason}`);
  },
};

// Persistent memory: one portable SQLite file (ALIL_DB, default workspace/memory.db).
// Falls back to an ephemeral no-op if the native module can't load, so the REPL still runs.
let memory: MemorySystem | null = null;
let episodes: EpisodeManager | null = null;
let knowledge: KnowledgeSource | undefined;
// Phase 1 (agentic memory): the per-turn recall PUSH is off. Canonical is standing context
// in the system prompt; episodic/semantic are fetched by tools (phases 1.5 / 2). No-op port.
const memoryPort: MemoryPort = { recall: async () => [] };
try {
  memory = openMemory({ path: process.env.ALIL_DB ?? "workspace/memory.db" });
  await seedMemoryInstructions(memory.store);
  memCtx.store = memory.store; // wire the memory.* tools
  knowledge = new CanonicalKnowledge(memory.store);
  // Phase 1.5: canonical writes are model-driven and permissioned (memory.write tool), so
  // the silent auto-promoter is no longer wired in. Episode distillation still runs.
  episodes = new EpisodeManager({
    db: memory.db,
    timeline: memory.timeline,
    store: memory.store,
    summarizer: new ExtractiveSummarizer(),
    onMemoryWrite: (e) => {
      audit.append("episode.distill", { episodeId: e.episodeId, lines: e.lines });
      console.log(`  · episode ${e.episodeId} distilled → memory (${e.lines} lines)`);
    },
  });
  console.log(`memory: ${process.env.ALIL_DB ?? "workspace/memory.db"} (persistent · agentic tools on)`);
} catch (e) {
  console.log(`memory: disabled (${(e as Error).message}) — running without recall`);
}

const ports: BrainPorts = {
  memory: memoryPort,
  skills: { eligible: async () => [] },
  // Advertise the same tools the boundary governs.
  tools: new RegistryToolCatalog(DEFAULT_TOOLS),
  // Persona from workspace/SOUL.md (falls back to base-only if absent); inject the date;
  // standing canonical memory (preferences + memory instructions) live-rendered each turn.
  prompt: new PromptAssembler(new FilePersonaSource(), { env: { now: () => new Date() }, knowledge }),
  // Real policy boundary: reads run; writes/high-risk gated by approval; credentials blocked.
  actions: boundary,
  // Live trace of tool calls and outcomes.
  observer,
};

const brain = new Brain({ modelId, guards: DEFAULT_GUARDS }, registry, ports);

let closed = false;
rl.on("close", () => {
  closed = true;
});

// Ctrl-C cancels the running turn (not the process); pressing it while idle at the
// prompt exits. `current` is the in-flight turn's controller, or null when idle.
let current: AbortController | null = null;
rl.on("SIGINT", () => {
  if (current) {
    console.log("\n  ⏹ cancelling turn…");
    current.abort();
  } else {
    rl.close();
  }
});

console.log(
  `Alil dev REPL — model: ${modelId}\n` +
    `filesystem root: ${sandboxRoot}  (reads auto · writes need approval · credentials blocked)\n` +
    `Type a message (/exit to quit).\n`,
);

// The continuous timeline is the source of truth for prior context. Load the recent
// working set from persistent memory (spanning past sessions — one continuous mind).
const CHANNEL = "terminal";

function loadHistory(): TranscriptLine[] {
  if (!memory) return [];
  return memory.timeline.workingSet(40).flatMap((l): TranscriptLine[] => {
    if (l.role === "user" && l.text !== undefined) {
      return [{ t: "user", at: l.at, channel: l.channel, provenanceId: l.provenance.origin, text: l.text }];
    }
    if (l.role === "assistant" && l.text !== undefined) {
      return [{ t: "model", at: l.at, text: l.text }];
    }
    return [];
  });
}

for (;;) {
  let text: string;
  try {
    text = (await rl.question("you › ")).trim();
  } catch {
    break; // stdin closed (EOF / piped input ended)
  }
  if (closed || text === "/exit" || text === "/quit") break;
  if (text.length === 0) continue;

  // Roll the episode cursor (closes + distills any idle episode), then pass PRIOR turns as
  // history (from the persistent timeline). The current message is recorded after the turn.
  const episodeId = episodes ? await episodes.beginTurn(new Date().toISOString()) : "ep_repl";
  const input: BrainInput = {
    sessionId: "repl",
    message: { text, provenance: { origin: "operator" } },
    history: loadHistory(),
  };

  current = new AbortController();
  try {
    const turn = await brain.run(input, { signal: current.signal });
    if (turn.stopReason === "error") {
      console.log(`alil › [error] ${turn.haltReason}\n`);
    } else if (turn.stopReason === "aborted") {
      console.log(`alil › [cancelled]\n`);
    } else if (turn.stopReason === "guard_halt") {
      console.log(`alil › [halted: ${turn.haltReason}] ${turn.assistantText ?? ""}\n`);
    } else {
      console.log(`alil › ${turn.assistantText ?? "(no text)"}`);
      console.log(`      (iterations: ${turn.iterations})\n`);
    }
    // Only durably record the exchange when the turn produced a real answer.
    if (turn.stopReason === "complete" && memory) {
      const at = new Date().toISOString();
      memory.timeline.append({ at, channel: CHANNEL, provenance: { origin: "operator" }, episodeId, role: "user", text });
      if (turn.assistantText !== undefined) {
        memory.timeline.append({ at, channel: CHANNEL, provenance: { origin: "model" }, episodeId, role: "assistant", text: turn.assistantText });
      }
      audit.append("turn", { channel: CHANNEL, episodeId, iterations: turn.iterations });
    }
  } catch (e) {
    console.log(`alil › [crash] ${(e as Error).message}\n`);
  } finally {
    current = null;
  }
}

rl.close();
