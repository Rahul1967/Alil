/**
 * Telegram channel transport (DESIGN §channels). A thin, dependency-free client over the Bot
 * API using long polling — the right choice for a local-first assistant with no public URL: it
 * pulls updates over an outbound connection and resumes cleanly after downtime (Telegram queues
 * updates ~24h). Pure transport only: no brain/memory here, so it unit-tests with a fake fetch.
 *
 * The 2026 "AI bot" features (guest bots, bot-to-bot, streaming rich messages) don't change the
 * core receive/reply loop; we use plain getUpdates + sendMessage. Streaming edits can come later.
 */
export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type?: string; // "private" | "group" | ...
}

export interface TelegramMessage {
  message_id: number;
  date: number; // unix seconds
  text?: string;
  chat: TelegramChat;
  from?: TelegramUser;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/** Telegram caps a message at 4096 chars — split long replies on line/word boundaries. */
export function splitMessage(text: string, max = 4096): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    // Prefer a newline, then a space, else a hard cut, all within the window.
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
  apiBase?: string; // override for tests
  fetchImpl?: typeof fetch; // inject for tests
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

  /** POST a Bot API method. Retries once on 429 honoring retry_after. */
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

  /** Verify the token; returns the bot's own user. */
  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe", {});
  }

  /** Long-poll for updates. `timeout` seconds holds the connection open server-side. */
  getUpdates(offset: number, timeout: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout, allowed_updates: ["message"] },
      // The held request can run up to `timeout`s; give it headroom over that.
      signal,
    );
  }

  /** Send text, split into ≤4096-char chunks. */
  async sendMessage(chatId: number, text: string): Promise<void> {
    for (const chunk of splitMessage(text)) {
      await this.call("sendMessage", { chat_id: chatId, text: chunk });
    }
  }

  /** Show a "typing…" indicator (lasts ~5s; re-send for longer turns). */
  async sendChatAction(chatId: number, action = "typing"): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action });
    } catch {
      /* cosmetic — never fail a turn because the typing hint didn't send */
    }
  }
}

export interface TelegramLoopDeps {
  client: TelegramClient;
  /** Only messages from this Telegram user id are handled; everyone else is ignored. */
  authorizedUserId: number;
  /** Handle one authorized text message (run the turn, reply). */
  onMessage: (msg: TelegramMessage) => Promise<void>;
  loadOffset: () => number;
  saveOffset: (offset: number) => void;
  signal?: AbortSignal; // abort to stop the loop
  pollTimeout?: number; // seconds, default 50
}

/**
 * The long-poll loop. Advances the offset (which ACKs prior updates to Telegram) and persists it
 * only AFTER the message is durably handled, so a crash re-delivers rather than drops. Backs off
 * exponentially on network errors. Single-user lock: non-authorized senders are silently skipped.
 */
export async function runTelegramLoop(deps: TelegramLoopDeps): Promise<void> {
  const timeout = deps.pollTimeout ?? 50;
  let offset = deps.loadOffset();
  let backoff = 1000;

  while (!deps.signal?.aborted) {
    let updates: TelegramUpdate[];
    try {
      updates = await deps.client.getUpdates(offset, timeout, deps.signal);
      backoff = 1000;
    } catch {
      if (deps.signal?.aborted) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1; // advance before the next getUpdates ACKs it
      const m = u.message;
      if (!m || !m.text || m.from?.id !== deps.authorizedUserId) {
        deps.saveOffset(offset); // ignored (or non-text) — still advance past it
        continue;
      }
      try {
        await deps.onMessage(m);
      } finally {
        deps.saveOffset(offset); // persist only after handling
      }
      if (deps.signal?.aborted) break;
    }
  }
}
