/**
 * Telegram channel — a remote window onto the SAME Brain + memory as the REPL and browser
 * (one continuous mind, MEMORY.md §1). Long-polls the Bot API for messages from a single
 * authorized user, runs each as a turn, and replies. Fired prospective-memory intentions are
 * pushed here too — so reminders reach your phone.
 *
 * Run:  TELEGRAM_BOT_TOKEN=… TELEGRAM_ALLOWED_USER_ID=… npm run telegram
 *
 * Like the browser channel, this has no interactive approval affordance, so write/high-risk
 * tools fail closed (denied with a note). Chat, recall, and reminder delivery work; scheduling
 * or writing memory from Telegram is refused until a Telegram approval flow is added.
 */
import { Brain } from "../src/runtime/loop.ts";
import type { BrainPorts } from "../src/runtime/loop.ts";
import { DEFAULT_GUARDS } from "../src/runtime/types.ts";
import type { BrainInput, MemoryPort, BrainObserver } from "../src/runtime/types.ts";
import type { TranscriptLine, Provenance } from "../src/core/types.ts";
import { ProviderRegistry, BedrockProvider } from "../src/providers/index.ts";
import { PromptAssembler, FilePersonaSource } from "../src/prompts/index.ts";
import { PolicyBoundary, YamlRuleSource, credentialBlock, GrantStore } from "../src/policy/index.ts";
import type { ApprovalPort, ApprovalRequest, ApprovalDecision } from "../src/policy/index.ts";
import { ToolRegistry, Executor, Sandbox, ReadTracker, RegistryToolCatalog, DEFAULT_TOOLS } from "../src/execution/index.ts";
import { openMemory, EpisodeManager, ExtractiveSummarizer, CanonicalKnowledge, seedMemoryInstructions } from "../src/memory/index.ts";
import type { MemorySystem } from "../src/memory/index.ts";
import type { Intention, IncomingEvent } from "../src/memory/types.ts";
import type { KnowledgeSource } from "../src/prompts/types.ts";
import { TurnQueue, AuditLedger, Scheduler } from "../src/gateway/index.ts";
import { TelegramClient, runTelegramLoop } from "../src/channels/telegram.ts";
import type { TelegramMessage } from "../src/channels/telegram.ts";

const CHANNEL = "telegram";
const modelId = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

// Accept token + user id from env vars OR positional args (env wins; args are the fallback).
const token = process.env.TELEGRAM_BOT_TOKEN ?? process.argv[2];
const allowedUserId = Number(process.env.TELEGRAM_ALLOWED_USER_ID ?? process.argv[3]);
if (!token || !Number.isInteger(allowedUserId)) {
  console.error(
    "Telegram channel needs a bot token and your numeric user id. Provide either:\n" +
      "  env:  TELEGRAM_BOT_TOKEN=… TELEGRAM_ALLOWED_USER_ID=… npm run telegram\n" +
      "  args: npm run telegram -- <BOT_TOKEN> <USER_ID>\n" +
      "Token from @BotFather; user id from @userinfobot. Only that user is answered.",
  );
  process.exit(1);
}

const client = new TelegramClient({ token });

// ── Brain + persistent memory (mirrors chat.ts / ui/server.ts) ──
const registry = new ProviderRegistry().register(new BedrockProvider());
const audit = new AuditLedger("workspace/logs/audit.jsonl");

let memory: MemorySystem | null = null;
let episodes: EpisodeManager | null = null;
let knowledge: KnowledgeSource | undefined;
const memoryPort: MemoryPort = { recall: async () => [] };
const memCtx: { store?: MemorySystem["store"] } = {};
const prospCtx: { store?: MemorySystem["prospective"] } = {};
try {
  memory = openMemory({ path: process.env.ALIL_DB ?? "workspace/memory.db" });
  await seedMemoryInstructions(memory.store);
  memCtx.store = memory.store;
  prospCtx.store = memory.prospective;
  knowledge = new CanonicalKnowledge(memory.store);
  episodes = new EpisodeManager({
    db: memory.db,
    timeline: memory.timeline,
    store: memory.store,
    summarizer: new ExtractiveSummarizer(),
    onMemoryWrite: (e) => audit.append("episode.distill", { episodeId: e.episodeId, lines: e.lines }),
  });
} catch (e) {
  console.warn(`memory disabled: ${(e as Error).message}`);
}

// No interactive approval on Telegram yet → fail closed on anything needing consent.
const approvals: ApprovalPort = {
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return { approved: false, reason: "Telegram channel can't ask for approval yet — do write actions from the terminal." };
  },
};

const sandboxRoot = process.env.ALIL_SANDBOX_ROOT ?? "workspace";
const boundary = new PolicyBoundary({
  rules: new YamlRuleSource("config/policy.yaml"),
  tools: new ToolRegistry(),
  hooks: [credentialBlock],
  executor: new Executor({ sandbox: new Sandbox(sandboxRoot), reads: new ReadTracker(), memory: memCtx, prospective: prospCtx }),
  approvals,
  grants: new GrantStore(),
});

const observer: BrainObserver = {
  onToolResult(e) {
    if (e.tool.startsWith("memory.") && e.tool !== "memory.read") {
      audit.append("canonical.tool", { tool: e.tool, outcome: e.outcome, summary: e.summary, channel: CHANNEL });
    }
  },
};

const ports: BrainPorts = {
  memory: memoryPort,
  skills: { eligible: async () => [] },
  tools: new RegistryToolCatalog(DEFAULT_TOOLS),
  prompt: new PromptAssembler(new FilePersonaSource(), { env: { now: () => new Date() }, knowledge }),
  actions: boundary,
  observer,
};

const brain = new Brain({ modelId, guards: DEFAULT_GUARDS }, registry, ports);
const queue = new TurnQueue(); // one in-flight turn across inbound messages AND fired intentions

function loadHistory(): TranscriptLine[] {
  if (!memory) return [];
  return memory.timeline.workingSet(40).flatMap((l): TranscriptLine[] => {
    if (l.role === "user" && l.text !== undefined) {
      return [{ t: "user", at: l.at, channel: l.channel, provenanceId: l.provenance.origin, text: l.text }];
    }
    if (l.role === "assistant" && l.text !== undefined) return [{ t: "model", at: l.at, text: l.text }];
    return [];
  });
}

// getUpdates offset persisted in the memory DB so a restart never drops/replays messages.
function loadOffset(): number {
  if (!memory) return 0;
  const row = memory.db.prepare("SELECT value FROM kv WHERE key = 'tg_offset'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}
function saveOffset(offset: number): void {
  memory?.db
    .prepare("INSERT INTO kv(key, value) VALUES ('tg_offset', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(offset));
}

/** Run one turn on the shared queue and return the assistant text. */
function runTurn(text: string, provenance: Provenance, label: string): Promise<string> {
  return queue.submit(async (signal) => {
    const at = new Date().toISOString();
    const episodeId = episodes ? await episodes.beginTurn(at) : "ep_tg";
    const input: BrainInput = { sessionId: "telegram", message: { text, provenance }, history: loadHistory() };
    const turn = await brain.run(input, { signal });
    const reply = turn.assistantText ?? "(no reply)";
    if (turn.stopReason === "complete" && memory) {
      memory.timeline.append({ at, channel: CHANNEL, provenance, episodeId, role: "user", text });
      memory.timeline.append({ at, channel: CHANNEL, provenance: { origin: "model" }, episodeId, role: "assistant", text: reply });
      audit.append("turn", { channel: CHANNEL, episodeId, iterations: turn.iterations, label });
    }
    return reply;
  }, { label });
}

// Fired intentions run as a turn and get pushed to the owner's Telegram chat.
const scheduler = memory
  ? new Scheduler({
      store: memory.prospective,
      deliver: async (intention: Intention, event?: IncomingEvent) => {
        const tainted = !!event && (event.provenance.origin === "ingested" || (event.provenance.taintedBy?.length ?? 0) > 0);
        const provenance = tainted
          ? { origin: "system" as const, taintedBy: event!.provenance.taintedBy ?? [event!.channel] }
          : { origin: "system" as const };
        const banner = event ? `[event trigger fired: ${event.channel}] ` : "[scheduled reminder fired] ";
        const reply = await runTurn(`${banner}${intention.action}`, provenance, "intention");
        await client.sendMessage(allowedUserId, `⏰ ${intention.title}\n\n${reply}`);
      },
    })
  : null;

async function onMessage(msg: TelegramMessage): Promise<void> {
  const provenance = { origin: "user_channel" as const, channel: CHANNEL, sender: String(msg.from?.id ?? "") };
  // An inbound message is an event: fire any matching event-intentions (don't await — it queues
  // its own turn behind this one; awaiting inside a queued turn would deadlock the serializer).
  if (scheduler) {
    void scheduler.fireEvent({
      channel: CHANNEL,
      from: msg.from?.username ?? String(msg.from?.id ?? ""),
      text: msg.text,
      provenance,
    });
  }
  await client.sendChatAction(msg.chat.id);
  const reply = await runTurn(msg.text ?? "", provenance, "inbound");
  await client.sendMessage(msg.chat.id, reply);
}

const controller = new AbortController();
process.on("SIGINT", () => {
  console.log("\nstopping…");
  controller.abort();
});

const me = await client.getMe();
console.log(`Alil on Telegram as @${me.username} — answering user ${allowedUserId} only. Ctrl-C to stop.`);
scheduler?.start();

await runTelegramLoop({ client, authorizedUserId: allowedUserId, onMessage, loadOffset, saveOffset, signal: controller.signal });

scheduler?.stop();
memory?.close();
console.log("stopped.");
