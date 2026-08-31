import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface RemindDoneArgs {
  id: string;
}

/**
 * remind.done — mark an intention acknowledged/complete (distinct from remind.cancel = "don't
 * want it"). effect=write, so it crosses the policy boundary. Use when the user has handled the
 * thing a reminder was about.
 */
export const remindDone: ToolImpl<RemindDoneArgs> = {
  name: "remind.done",
  description:
    "Mark a reminder/intention as done (acknowledged/completed). Different from remind.cancel, which drops something the user no longer wants. Get the id from remind.list.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The intention id (from remind.list)." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<RemindDoneArgs> {
    const id = args["id"];
    if (typeof id !== "string" || id.trim() === "") return { ok: false, error: "remind.done requires an `id`" };
    return { ok: true, value: { id: id.trim() } };
  },

  async run(args: RemindDoneArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.prospective?.store;
    if (!store) throw new Error("prospective memory is not available");
    const ok = store.done(args.id);
    // A context intention that's done should stop surfacing — drop its cue.
    if (ok) ctx.memory?.store?.removeContextCue(args.id);
    return ok
      ? { summary: `marked done`, data: { id: args.id, ok: true } }
      : { summary: `no live intention with id ${args.id}`, data: { id: args.id, ok: false } };
  },
};
