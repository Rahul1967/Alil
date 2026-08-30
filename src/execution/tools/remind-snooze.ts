import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface RemindSnoozeArgs {
  id: string;
  until: string; // ISO 8601 — the new fire time
}

/**
 * remind.snooze — defer a reminder to a later time ("remind me again in an hour"). Re-arms the
 * intention to fire at `until`. effect=write, so it crosses the policy boundary. Compute `until`
 * as an absolute ISO time from the current date.
 */
export const remindSnooze: ToolImpl<RemindSnoozeArgs> = {
  name: "remind.snooze",
  description:
    "Defer a reminder to a later time — re-arms it to fire again at `until` (absolute ISO 8601). Use when the user says 'remind me again later / in an hour / tomorrow'. Get the id from remind.list.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The intention id (from remind.list)." },
      until: { type: "string", description: "New fire time, ISO 8601 (e.g. \"2026-08-31T09:00:00+05:30\")." },
    },
    required: ["id", "until"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<RemindSnoozeArgs> {
    const id = args["id"];
    if (typeof id !== "string" || id.trim() === "") return { ok: false, error: "remind.snooze requires an `id`" };
    const until = args["until"];
    if (typeof until !== "string" || Number.isNaN(Date.parse(until))) return { ok: false, error: "`until` must be an ISO 8601 date-time" };
    return { ok: true, value: { id: id.trim(), until } };
  },

  async run(args: RemindSnoozeArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.prospective?.store;
    if (!store) throw new Error("prospective memory is not available");
    const ok = store.snooze(args.id, Date.parse(args.until));
    return ok
      ? { summary: `snoozed until ${new Date(args.until).toISOString()}`, data: { id: args.id, ok: true } }
      : { summary: `no snoozable intention with id ${args.id}`, data: { id: args.id, ok: false } };
  },
};
