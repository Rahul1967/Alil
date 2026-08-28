/**
 * Telegram channel — a thin adapter over the shared Alil core (src/app/core.ts). It supplies only
 * telegram-specific bits: the Bot API client, an inline-button approval flow, proactive delivery
 * (fired reminders + ambient wakes reach your phone), file delivery, and getUpdates offset
 * persistence. Brain, policy, memory, world-model, planner, subagents and ambient ingestion come
 * from createAlil, so this channel matches the terminal and browser channels by construction.
 *
 * Run:  TELEGRAM_BOT_TOKEN=… TELEGRAM_ALLOWED_USER_ID=… npm run telegram
 *   or: npm run telegram -- <BOT_TOKEN> <USER_ID>
 */
import { randomUUID } from "node:crypto";
import { createAlil } from "../src/app/index.ts";
import type { ChannelBinding } from "../src/app/index.ts";
import type { ApprovalPort, ApprovalRequest, ApprovalDecision } from "../src/policy/index.ts";
import { TelegramClient, runTelegramLoop } from "../src/channels/telegram.ts";
import type { TelegramMessage, TelegramCallbackQuery } from "../src/channels/telegram.ts";

const CHANNEL = "telegram";
const modelId = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

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

// ── HITL over Telegram: Approve/Reject buttons; the turn awaits the tap ────────────────────────
const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
let approvalSeq = 0;
const PROC = randomUUID().slice(0, 6); // per-process prefix so stale buttons can't match a live approval
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const approvals: ApprovalPort = {
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const a = req.action;
    const tok = `${PROC}${approvalSeq++}`;
    const text = `⚠️ Approval needed\n\n${a.tool}  (${a.effect}/${a.risk})\nargs: ${JSON.stringify(a.args).slice(0, 300)}\n\n${req.reason}`;
    const replyMarkup = { inline_keyboard: [[{ text: "✅ Approve", callback_data: `a:${tok}` }, { text: "❌ Reject", callback_data: `r:${tok}` }]] };
    let prompt: TelegramMessage;
    try {
      prompt = await client.sendMessage(allowedUserId, text, { replyMarkup });
    } catch {
      return { approved: false, reason: "couldn't reach Telegram to ask for approval" };
    }
    return await new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingApprovals.delete(tok)) {
          void client.editMessageText(allowedUserId, prompt.message_id, `${text}\n\n⏳ timed out — rejected`);
          resolve({ approved: false, reason: "approval timed out" });
        }
      }, APPROVAL_TIMEOUT_MS);
      pendingApprovals.set(tok, (decision) => {
        clearTimeout(timer);
        void client.editMessageText(allowedUserId, prompt.message_id, `${text}\n\n${decision.approved ? "✅ approved" : "❌ rejected"}`);
        resolve(decision);
      });
    });
  },
};

async function onCallback(cbq: TelegramCallbackQuery): Promise<void> {
  const [kind, tok] = (cbq.data ?? "").split(":");
  const resolver = tok ? pendingApprovals.get(tok) : undefined;
  if (resolver && tok) {
    pendingApprovals.delete(tok);
    resolver({ approved: kind === "a", ...(kind === "a" ? {} : { reason: "rejected via Telegram" }) });
    await client.answerCallbackQuery(cbq.id, kind === "a" ? "Approved ✅" : "Rejected ❌");
  } else {
    await client.answerCallbackQuery(cbq.id, "This approval expired — send the request again.");
  }
}

// ── The core, bound to this channel ─────────────────────────────────────────────
const binding: ChannelBinding = {
  channel: CHANNEL,
  approvals,
  notify: async (text, meta) => {
    const tag = meta.source === "scheduled" ? `⏰ ${meta.label ?? ""}` : `🔔 (${meta.label ?? ""})`;
    await client.sendMessage(allowedUserId, `${tag}\n\n${text}`);
  },
  sendFile: async (path, caption) => {
    try {
      await client.sendDocument(allowedUserId, path, caption);
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  },
};
const alil = createAlil({ modelId }, binding);

// getUpdates offset persisted in the memory DB so a restart never drops/replays messages.
function loadOffset(): number {
  const db = alil.memory?.db;
  if (!db) return 0;
  const row = db.prepare("SELECT value FROM kv WHERE key = 'tg_offset'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}
function saveOffset(offset: number): void {
  alil.memory?.db.prepare("INSERT INTO kv(key, value) VALUES ('tg_offset', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(offset));
}

async function onMessage(msg: TelegramMessage): Promise<void> {
  const provenance = { origin: "user_channel" as const, channel: CHANNEL, sender: String(msg.from?.id ?? "") };
  const text = (msg.text ?? "").trim();

  const planMatch = text.match(/^\/plan(-dry)?\s+([\s\S]+)$/);
  if (planMatch) {
    const dryRun = planMatch[1] === "-dry";
    try {
      const result = await alil.runPlan(planMatch[2]!.trim(), { dryRun, approvePlan: async () => true });
      const lines = result.nodes.map((n) => `• ${n.id}: ${n.description}${n.summary ? ` — ${n.summary}` : ""}`).join("\n");
      const head = dryRun ? `plan (${result.nodes.length} steps, not executed):` : `plan ${result.status} (${result.replans} replan${result.replans === 1 ? "" : "s"}):`;
      await client.sendMessage(msg.chat.id, `${head}\n${lines}`);
    } catch (e) {
      await client.sendMessage(msg.chat.id, `plan error: ${(e as Error).message}`);
    }
    return;
  }
  if (text.startsWith("/event ")) {
    try {
      await alil.ingestEvent(JSON.parse(text.slice(7)) as Record<string, unknown>);
      await client.sendMessage(msg.chat.id, "· event ingested");
    } catch (e) {
      await client.sendMessage(msg.chat.id, `event error: ${(e as Error).message}`);
    }
    return;
  }

  await client.sendChatAction(msg.chat.id);
  const turn = await alil.runTurn(msg.text ?? "", provenance, { label: "inbound" });
  await client.sendMessage(msg.chat.id, turn.assistantText ?? "(no reply)");
}

const controller = new AbortController();
process.on("SIGINT", () => { console.log("\nstopping…"); controller.abort(); });

async function verifyToken(): Promise<void> {
  for (let attempt = 1; attempt <= 5 && !controller.signal.aborted; attempt++) {
    try {
      const me = await client.getMe();
      console.log(`Alil on Telegram as @${me.username} — answering user ${allowedUserId} only. Ctrl-C to stop.`);
      return;
    } catch (e) {
      console.error(`[tg] getMe attempt ${attempt}/5 failed: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, Math.min(2000 * 2 ** (attempt - 1), 15_000)));
    }
  }
  console.error("[tg] couldn't confirm the token yet — starting the poll loop anyway; it keeps retrying.");
}

await verifyToken();
alil.start();
await runTelegramLoop({ client, authorizedUserId: allowedUserId, onMessage, onCallback, loadOffset, saveOffset, signal: controller.signal });
alil.stop();
console.log("stopped.");
