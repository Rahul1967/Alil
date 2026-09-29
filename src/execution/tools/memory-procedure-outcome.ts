import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface ProcedureOutcomeArgs {
  name: string;
  success: boolean;
}

/**
 * memory.procedure.outcome — record whether following a method actually worked (MEMORY.md §7a).
 * This is what ranking learns from: fetching a method is a use, not a success. A write (so it is
 * gated like any other), but low-risk and reversible in effect — only the method's track record
 * changes, never its steps — so a standing grant may cover it.
 */
export const memoryProcedureOutcome: ToolImpl<ProcedureOutcomeArgs> = {
  name: "memory.procedure.outcome",
  description:
    "After you followed a proven method (from memory.procedure.fetch), record whether it worked: `success: true` if the task succeeded, `false` if the method failed or needed a real fix. Methods that keep working rank higher; failing ones sink (and you should update or deprecate them).",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The method name you followed." },
      success: { type: "boolean", description: "Did following it work?" },
    },
    required: ["name", "success"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<ProcedureOutcomeArgs> {
    const name = args["name"];
    if (typeof name !== "string" || name.trim() === "") return { ok: false, error: "memory.procedure.outcome requires a non-empty `name`" };
    if (typeof args["success"] !== "boolean") return { ok: false, error: "memory.procedure.outcome requires a boolean `success`" };
    return { ok: true, value: { name: name.trim(), success: args["success"] } };
  },

  async run(args: ProcedureOutcomeArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.memory?.store;
    if (!store) throw new Error("memory is not available");
    const ok = await store.recordProcedureOutcome(args.name, args.success);
    return { summary: ok ? `recorded ${args.success ? "success" : "failure"} for '${args.name}'` : `no procedure named '${args.name}'` };
  },
};
