import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface RemindListArgs {
  limit: number;
}

const MAX = 100;
const DEFAULT = 50;

/**
 * remind.list — see your scheduled/triggered intentions (prospective memory). Read-only, so the
 * boundary auto-allows it. Use it before creating a reminder (to avoid duplicates) or to find
 * the id of one the user wants to cancel.
 */
export const remindList: ToolImpl<RemindListArgs> = {
  name: "remind.list",
  description:
    "List your prospective-memory intentions (reminders, recurring routines, event triggers) with their ids, status, and next fire time. Use before scheduling (avoid duplicates) or to get an id to cancel.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, description: `Max intentions to return (1–${MAX}, default ${DEFAULT}).` },
    },
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<RemindListArgs> {
    let limit = DEFAULT;
    if (args["limit"] !== undefined) {
      if (typeof args["limit"] !== "number" || !Number.isFinite(args["limit"])) {
        return { ok: false, error: "remind.list `limit` must be a number" };
      }
      limit = Math.max(1, Math.min(MAX, Math.floor(args["limit"])));
    }
    return { ok: true, value: { limit } };
  },

  async run(args: RemindListArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.prospective?.store;
    if (!store) throw new Error("prospective memory is not available");
    const items = store.list(args.limit);
    const data = items.map((i) => ({
      id: i.id,
      title: i.title,
      kind: i.kind,
      trigger: i.trigger,
      status: i.status,
      nextFire: i.fireAt ? new Date(i.fireAt).toISOString() : null,
      cron: i.cronExpr,
      event: i.eventMatch,
    }));
    const active = items.filter((i) => i.status === "pending").length;
    return { summary: `${items.length} intention(s), ${active} pending`, data };
  },
};
