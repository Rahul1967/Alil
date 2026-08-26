import { Cron } from "croner";
import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import type { NewIntention, EventMatch, IntentionTrigger } from "../../memory/types.ts";

interface RemindCreateArgs {
  title: string;
  action: string;
  at?: string; // ISO 8601 absolute time → 'once'
  cron?: string; // 5-field cron → recurring
  event?: EventMatch; // predicate → 'event'
  expiresAt?: string; // ISO
  dedupKey?: string;
}

const EVENT_KEYS = new Set(["channel", "type", "from", "subject", "contains"]);

/**
 * remind.create — schedule a future intention (prospective memory). effect=write, so it goes
 * through the policy boundary: the user approves it, and a tainted turn can't silently schedule
 * a future action. When it fires, the action runs as a normal turn (the model decides then
 * whether to just notify you or do something), re-checking permissions at fire time.
 */
export const remindCreate: ToolImpl<RemindCreateArgs> = {
  name: "remind.create",
  description:
    "Schedule something to do later (a reminder, a recurring routine, or an event-triggered action). Give a short `title`, an `action` written as an instruction to your future self (e.g. \"Remind the user to call the dentist\"), and exactly ONE trigger: `at` (an absolute ISO 8601 time, for one-off), `cron` (a 5-field cron expression, for recurring), or `event` (a predicate like {from:\"landlord\", channel:\"email\"} to fire when a matching event arrives). Optionally `expiresAt` (ISO) and a `dedupKey` to avoid duplicates. Compute absolute times yourself from the current date. Requires the user's approval.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short label, e.g. \"call the dentist\"." },
      action: { type: "string", description: "Instruction to your future self, run as a turn when it fires." },
      at: { type: "string", description: "One-off fire time, ISO 8601 (e.g. \"2026-08-27T17:00:00+05:30\")." },
      cron: { type: "string", description: "Recurring schedule, 5-field cron (e.g. \"0 9 * * 1\" = Mondays 9am)." },
      event: {
        type: "object",
        description: "Fire when a matching event arrives.",
        properties: {
          channel: { type: "string" }, type: { type: "string" }, from: { type: "string" },
          subject: { type: "string" }, contains: { type: "string" },
        },
        additionalProperties: false,
      },
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
    const provided = [at !== undefined, cron !== undefined, event !== undefined].filter(Boolean).length;
    if (provided !== 1) return { ok: false, error: "remind.create needs exactly one of `at`, `cron`, or `event`" };

    const value: RemindCreateArgs = { title: title.trim(), action: action.trim() };

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
      if (keys.length === 0) return { ok: false, error: "`event` needs at least one field (channel/from/subject/contains/type)" };
      for (const k of keys) {
        if (!EVENT_KEYS.has(k)) return { ok: false, error: `unknown event field "${k}"` };
        if (typeof e[k] !== "string") return { ok: false, error: `event.${k} must be a string` };
      }
      value.event = e as EventMatch;
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

    const trigger: IntentionTrigger = args.at ? "once" : args.cron ? "cron" : "event";
    const n: NewIntention = {
      title: args.title,
      action: args.action,
      trigger,
      provenance: { origin: "operator" },
      ...(args.at ? { fireAt: Date.parse(args.at) } : {}),
      ...(args.cron ? { fireAt: new Cron(args.cron).nextRun()?.getTime() ?? null, cronExpr: args.cron } : {}),
      ...(args.event ? { eventMatch: args.event } : {}),
      ...(args.expiresAt ? { expiresAt: Date.parse(args.expiresAt) } : {}),
      ...(args.dedupKey ? { dedupKey: args.dedupKey } : {}),
    };
    const { intention, created } = store.create(n);
    if (!created) return { summary: `already scheduled (dedup): "${intention.title}"`, data: { id: intention.id, created: false } };

    const whenText =
      trigger === "once" ? `at ${new Date(intention.fireAt!).toISOString()}` :
      trigger === "cron" ? `on schedule "${args.cron}" (next ${intention.fireAt ? new Date(intention.fireAt).toISOString() : "?"})` :
      `when an event matches ${JSON.stringify(args.event)}`;
    return { summary: `scheduled "${intention.title}" ${whenText}`, data: { id: intention.id, trigger, created: true } };
  },
};
