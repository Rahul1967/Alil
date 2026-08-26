import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface RemindCancelArgs {
  id: string;
}

/**
 * remind.cancel — cancel a scheduled/triggered intention by id (from remind.list). effect=write
 * → requires the user's approval, like any change to durable state.
 */
export const remindCancel: ToolImpl<RemindCancelArgs> = {
  name: "remind.cancel",
  description:
    "Cancel a prospective-memory intention by its id (get ids from remind.list). Stops it from firing. Requires the user's approval.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The intention id to cancel." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "low",
  reversible: false,

  validate(args): ValidateResult<RemindCancelArgs> {
    const id = args["id"];
    if (typeof id !== "string" || id.trim() === "") return { ok: false, error: "remind.cancel requires a non-empty `id`" };
    return { ok: true, value: { id: id.trim() } };
  },

  async run(args: RemindCancelArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.prospective?.store;
    if (!store) throw new Error("prospective memory is not available");
    const ok = store.cancel(args.id);
    return { summary: ok ? `cancelled intention ${args.id}` : `no cancellable intention with id ${args.id}` };
  },
};
