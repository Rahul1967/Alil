import { Cron } from "croner";
import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import type { NewIntention, EventMatch, IntentionTrigger, IntentionKind } from "../../memory/types.ts";
import { INTENTION_KINDS } from "../../memory/types.ts";

interface RemindCreateArgs {
  title: string;
  action: string;
  kind?: IntentionKind; // what it IS; defaults to "reminder"
  at?: string; // ISO 8601 absolute time → 'once'
  cron?: string; // 5-field cron → recurring
  event?: EventMatch; // predicate → 'event'
  manual?: boolean; // no automatic trigger → 'manual' (someday / review-only)
  context?: string; // relevance phrase → 'context' (surface when the topic comes up)
  nag?: boolean; // re-fire daily until acknowledged (once triggers only)
  supersedes?: string; // id of an intention this replaces (cancels the old on create)
  expiresAt?: string; // ISO
  dedupKey?: string;
}

const EVENT_KEYS = new Set(["channel", "type", "from", "subject", "contains", "after", "before"]);
const EVENT_TIME_KEYS = new Set(["after", "before"]);

/**
 * remind.create — schedule a future intention (prospective memory). effect=write, so it goes
 * through the policy boundary: the user approves it, and a tainted turn can't silently schedule
 * a future action. When it fires, the action runs as a normal turn (the model decides then
 * whether to just notify you or do something), re-checking permissions at fire time.
 */
export const remindCreate: ToolImpl<RemindCreateArgs> = {
  name: "remind.create",
  description:
    "Save something for later (a reminder, a recurring routine, an event-triggered action, or a someday/bucket-list item). Give a short `title`, an `action` written as an instruction to your future self (e.g. \"Remind the user to call the dentist\"), and exactly ONE trigger: `at` (an absolute ISO 8601 time, for one-off), `cron` (a 5-field cron expression, for recurring), `event` (a predicate like {from:\"landlord\", channel:\"email\"} to fire when a matching event arrives), or `manual:true` (no automatic trigger — a someday item or a decision to revisit, kept in the list until it comes up). Optionally `kind`, `expiresAt` (ISO), and a `dedupKey` to avoid duplicates. Compute absolute times yourself from the current date. Requires the user's approval.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short label, e.g. \"call the dentist\"." },
      action: { type: "string", description: "Instruction to your future self, run as a turn when it fires." },
      kind: { type: "string", enum: [...INTENTION_KINDS], description: "What this IS: 'reminder' (default, tell/do at trigger), 'fact' (surface when relevant), 'decision' (a plan to resume), 'aspiration' (someday/bucket), 'watch' (guard a condition)." },
      at: { type: "string", description: "One-off fire time, ISO 8601 (e.g. \"2026-08-27T17:00:00+05:30\")." },
      cron: { type: "string", description: "Recurring schedule, 5-field cron (e.g. \"0 9 * * 1\" = Mondays 9am)." },
      event: {
        type: "object",
        description:
          "Fire when a matching event arrives (e.g. an inbound message, or an injected webhook). " +
          "Match on channel/type/from/subject/contains (case-insensitive substrings), and/or a time " +
          "window after/before (ISO 8601) that gates WHEN the predicate is live. Use the window for " +
          "\"remind me when we talk on Oct 5\": {after:\"2026-10-05T00:00:00+05:30\", before:\"2026-10-06T00:00:00+05:30\"} " +
          "— it fires on the first message that day and lapses if none comes. An inbound user message counts as an event.",
        properties: {
          channel: { type: "string" }, type: { type: "string" }, from: { type: "string" },
          subject: { type: "string" }, contains: { type: "string" },
          after: { type: "string", description: "ISO 8601 — predicate live at/after this instant." },
          before: { type: "string", description: "ISO 8601 — predicate live until this instant (auto-expires here)." },
        },
        additionalProperties: false,
      },
      manual: { type: "boolean", description: "Set true for a someday/review item with NO automatic trigger (bucket list, a decision to revisit) — it just lives in the list until you bring it up. Mutually exclusive with at/cron/event." },
      context: { type: "string", description: "A relevance phrase → surface this LATER when the topic comes up, e.g. context:\"booking travel\" with action \"prefers an aisle seat\". Best for facts-for-later and decisions to resume. Mutually exclusive with at/cron/event/manual." },
      nag: { type: "boolean", description: "Only with `at`: re-fire the reminder daily until the user marks it done (remind.done). For \"nag me until I book the flight\"." },
      supersedes: { type: "string", description: "Id of an existing intention this one replaces — the old one is cancelled on create. Use to revise a reminder instead of leaving a stale duplicate." },
      expiresAt: { type: "string", description: "Drop the intention if it hasn't fired by this ISO time." },
      dedupKey: { type: "string", description: "Stable key to prevent scheduling the same thing twice." },
    },
    required: ["title", "action"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "medium",
  reversible: true,

  validate(args): ValidateResult<RemindCreateArgs> {
    const title = args["title"];
    const action = args["action"];
    if (typeof title !== "string" || title.trim() === "") return { ok: false, error: "remind.create requires a non-empty `title`" };
    if (typeof action !== "string" || action.trim() === "") return { ok: false, error: "remind.create requires a non-empty `action`" };

    const at = args["at"];
    const cron = args["cron"];
    const event = args["event"];
    const manual = args["manual"] === true;
    if (args["manual"] !== undefined && typeof args["manual"] !== "boolean") return { ok: false, error: "`manual` must be a boolean" };
    const context = args["context"];
    if (context !== undefined && (typeof context !== "string" || context.trim() === "")) return { ok: false, error: "`context` must be a non-empty relevance phrase" };
    const provided = [at !== undefined, cron !== undefined, event !== undefined, manual, context !== undefined].filter(Boolean).length;
    if (provided !== 1) return { ok: false, error: "remind.create needs exactly one trigger: `at`, `cron`, `event`, `context` (surface when a topic comes up), or `manual:true`" };

    const value: RemindCreateArgs = { title: title.trim(), action: action.trim() };
    if (manual) value.manual = true;
    if (typeof context === "string") value.context = context.trim();

    if (args["nag"] !== undefined && typeof args["nag"] !== "boolean") return { ok: false, error: "`nag` must be a boolean" };
    if (args["nag"] === true) {
      if (at === undefined) return { ok: false, error: "`nag` requires a one-off `at` trigger (it re-fires that reminder until done)" };
      value.nag = true;
    }
    const supersedes = args["supersedes"];
    if (supersedes !== undefined) {
      if (typeof supersedes !== "string" || supersedes.trim() === "") return { ok: false, error: "`supersedes` must be a non-empty intention id" };
      value.supersedes = supersedes.trim();
    }

    const kind = args["kind"];
    if (kind !== undefined) {
      if (typeof kind !== "string" || !INTENTION_KINDS.includes(kind as IntentionKind)) {
        return { ok: false, error: `\`kind\` must be one of ${INTENTION_KINDS.join(", ")}` };
      }
      value.kind = kind as IntentionKind;
    }

    if (at !== undefined) {
      if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return { ok: false, error: "`at` must be an ISO 8601 date-time" };
      value.at = at;
    }
    if (cron !== undefined) {
      if (typeof cron !== "string") return { ok: false, error: "`cron` must be a string" };
      try { new Cron(cron); } catch { return { ok: false, error: `invalid cron expression: "${cron}"` }; }
      value.cron = cron;
    }
    if (event !== undefined) {
      if (typeof event !== "object" || event === null || Array.isArray(event)) return { ok: false, error: "`event` must be an object predicate" };
      const e = event as Record<string, unknown>;
      const keys = Object.keys(e);
      if (keys.length === 0) return { ok: false, error: "`event` needs at least one field (channel/from/subject/contains/type/after/before)" };
      const match: Record<string, unknown> = {};
      for (const k of keys) {
        if (!EVENT_KEYS.has(k)) return { ok: false, error: `unknown event field "${k}"` };
        if (EVENT_TIME_KEYS.has(k)) {
          // after/before come in as ISO strings and are stored as epoch ms (the match window).
          if (typeof e[k] !== "string" || Number.isNaN(Date.parse(e[k] as string))) return { ok: false, error: `event.${k} must be an ISO 8601 date-time` };
          match[k] = Date.parse(e[k] as string);
        } else {
          if (typeof e[k] !== "string") return { ok: false, error: `event.${k} must be a string` };
          match[k] = e[k];
        }
      }
      if (typeof match["after"] === "number" && typeof match["before"] === "number" && match["before"] <= match["after"]) {
        return { ok: false, error: "event.before must be later than event.after" };
      }
      value.event = match as EventMatch;
    }

    const expiresAt = args["expiresAt"];
    if (expiresAt !== undefined) {
      if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return { ok: false, error: "`expiresAt` must be an ISO 8601 date-time" };
      value.expiresAt = expiresAt;
    }
    const dedupKey = args["dedupKey"];
    if (dedupKey !== undefined) {
      if (typeof dedupKey !== "string" || dedupKey.trim() === "") return { ok: false, error: "`dedupKey` must be a non-empty string" };
      value.dedupKey = dedupKey.trim();
    }
    return { ok: true, value };
  },

  async run(args: RemindCreateArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.prospective?.store;
    if (!store) throw new Error("prospective memory is not available");

    const trigger: IntentionTrigger = args.at ? "once" : args.cron ? "cron" : args.event ? "event" : args.context ? "context" : "manual";
    const n: NewIntention = {
      title: args.title,
      action: args.action,
      trigger,
      ...(args.kind ? { kind: args.kind } : {}),
      provenance: { origin: "operator" },
      ...(args.at ? { fireAt: Date.parse(args.at) } : {}),
      ...(args.cron ? { fireAt: new Cron(args.cron).nextRun()?.getTime() ?? null, cronExpr: args.cron } : {}),
      ...(args.event ? { eventMatch: args.event } : {}),
      ...(args.context ? { contextCue: args.context } : {}),
      ...(args.nag ? { nag: true } : {}),
      // A windowed event trigger self-expires at `before`: if no matching event arrives in the
      // window (e.g. the user never chats on Oct 5), it lapses instead of lingering forever.
      ...(args.expiresAt ? { expiresAt: Date.parse(args.expiresAt) } : args.event?.before !== undefined ? { expiresAt: args.event.before } : {}),
      ...(args.dedupKey ? { dedupKey: args.dedupKey } : {}),
    };
    const { intention, created } = store.create(n);
    if (!created) return { summary: `already scheduled (dedup): "${intention.title}"`, data: { id: intention.id, created: false } };

    // Index a context cue so it can be matched against future turns (facts-for-later).
    if (trigger === "context" && args.context) {
      await ctx.memory?.store?.indexContextCue(intention.id, args.context, { origin: "operator" });
    }
    // Supersede: cancel the old intention this one replaces (and drop its context cue).
    if (args.supersedes) {
      store.cancel(args.supersedes);
      ctx.memory?.store?.removeContextCue(args.supersedes);
    }

    const whenText =
      trigger === "once" ? `at ${new Date(intention.fireAt!).toISOString()}` :
      trigger === "cron" ? `on schedule "${args.cron}" (next ${intention.fireAt ? new Date(intention.fireAt).toISOString() : "?"})` :
      trigger === "event" ? `when an event matches ${JSON.stringify(args.event)}` :
      trigger === "context" ? `when "${args.context}" comes up` :
      `with no automatic trigger (someday / review-only)`;
    return { summary: `saved "${intention.title}" ${whenText}`, data: { id: intention.id, trigger, created: true } };
  },
};
