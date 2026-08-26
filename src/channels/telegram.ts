/**
 * Telegram channel transport (DESIGN §channels). A thin, dependency-free client over the Bot
 * API using long polling — the right choice for a local-first assistant with no public URL: it
 * pulls updates over an outbound connection and resumes cleanly after downtime (Telegram queues
 * updates ~24h). Pure transport only: no brain/memory here, so it unit-tests with a fake fetch.
 *
 * The loop dispatches two update kinds: `message` (a turn — handled fire-and-forget so the poller
 * keeps running and can fetch the approval button-press mid-turn) and `callback_query` (an inline
 * button press — used for HITL approve/reject). Plain sendMessage + sendDocument cover replies and
 * files; the 2026 rich-message features can layer on later.
 */
export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  chat: TelegramChat;
  from?: TelegramUser;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string; // our callback_data, e.g. "a:7" | "r:7"
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** An inline keyboard, e.g. Approve / Reject buttons. */
export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/** Telegram caps a message at 4096 chars — split long replies on line/word boundaries. */
export function splitMessage(text: string, max = 4096): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface TelegramClientOptions {
  token: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(opts: TelegramClientOptions) {
    if (!opts.token) throw new Error("TelegramClient requires a bot token");
    const base = opts.apiBase ?? "https://api.telegram.org";
    this.#base = `${base}/bot${opts.token}`;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  /** POST a JSON Bot API method. Retries once on 429 honoring retry_after. */
  async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.#fetch(`${this.#base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(60_000),
    });
    const json = (await res.json()) as ApiResponse<T>;
    if (!json.ok) {
      if (res.status === 429 && json.parameters?.retry_after) {
        await sleep(json.parameters.retry_after * 1000);
        return this.call<T>(method, body, signal);
      }
      throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
    }
    return json.result as T;
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe", {});
  }

  getUpdates(offset: number, timeout: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout, allowed_updates: ["message", "callback_query"] },
      signal,
    );
  }

  /** Send text (split into ≤4096-char chunks). An inline keyboard attaches to the last chunk;
   * returns that last sent message (its message_id, for later edits). */
  async sendMessage(chatId: number, text: string, opts?: { replyMarkup?: InlineKeyboard }): Promise<TelegramMessage> {
    const chunks = splitMessage(text);
    let last!: TelegramMessage;
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = { chat_id: chatId, text: chunks[i] };
      if (opts?.replyMarkup && i === chunks.length - 1) body["reply_markup"] = opts.replyMarkup;
      last = await this.call<TelegramMessage>("sendMessage", body);
    }
    return last;
  }

  /** Replace a message's text (used to show an approval's outcome and clear its buttons). */
  editMessageText(chatId: number, messageId: number, text: string): Promise<unknown> {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } });
  }

  /** Acknowledge a button press (stops its spinner; optional toast). */
  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    try {
      await this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
    } catch {
      /* non-critical */
    }
  }

  async sendChatAction(chatId: number, action = "typing"): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action });
    } catch {
      /* cosmetic */
    }
  }

  /** Upload and send a local file as a document (multipart, not JSON). */
  async sendDocument(chatId: number, filePath: string, caption?: string): Promise<void> {
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption);
    form.append("document", new Blob([bytes]), basename(filePath));
    const res = await this.#fetch(`${this.#base}/sendDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const json = (await res.json()) as ApiResponse<unknown>;
    if (!json.ok) throw new Error(`telegram sendDocument failed: ${json.description ?? res.status}`);
  }
}

export interface TelegramLoopDeps {
  client: TelegramClient;
  authorizedUserId: number;
  /** Handle one authorized text message. Called fire-and-forget so the poller keeps running
   * (a turn may await an approval button press, which arrives as a later update). */
  onMessage: (msg: TelegramMessage) => Promise<void> | void;
  /** Handle an authorized inline-button press (HITL approve/reject). Awaited — it's fast. */
  onCallback?: (cbq: TelegramCallbackQuery) => Promise<void> | void;
  loadOffset: () => number;
  saveOffset: (offset: number) => void;
  signal?: AbortSignal;
  pollTimeout?: number; // seconds, default 50
}

/**
 * The long-poll loop. Advances the offset (ACKing prior updates) and persists it as each update
 * is dispatched. Messages are dispatched fire-and-forget so an in-progress turn awaiting approval
 * doesn't stall the poller. Single-user lock: only the authorized user's updates are handled.
 */
export async function runTelegramLoop(deps: TelegramLoopDeps): Promise<void> {
  const timeout = deps.pollTimeout ?? 50;
  let offset = deps.loadOffset();
  let backoff = 1000;

  while (!deps.signal?.aborted) {
    let updates: TelegramUpdate[];
    // Bound each long-poll a bit past the server timeout so a wedged connection can't stop the
    // poller forever (it would otherwise never receive the next callback/message).
    const deadline = AbortSignal.timeout((timeout + 15) * 1000);
    const pollSignal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline;
    try {
      updates = await deps.client.getUpdates(offset, timeout, pollSignal);
      backoff = 1000;
    } catch {
      if (deps.signal?.aborted) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const cbq = u.callback_query;
      const msg = u.message;
      if (cbq) {
        if (cbq.from.id === deps.authorizedUserId) {
          await deps.onCallback?.(cbq);
        } else {
          console.error(`[tg] ignored callback from unauthorized user ${cbq.from.id}`);
        }
      } else if (msg && msg.text) {
        if (msg.from?.id === deps.authorizedUserId) {
          // Fire-and-forget so the poller keeps running (a turn may await an approval tap).
          void Promise.resolve(deps.onMessage(msg)).catch((e) => console.error("[tg] turn error:", e));
        } else {
          console.error(`[tg] ignored message from unauthorized user ${msg.from?.id}`);
        }
      }
      deps.saveOffset(offset);
    }
  }
}
