import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import type { ProcedureUpdate } from "../../memory/types.ts";

interface ProcedureUpdateArgs {
  name: string;
  patch: ProcedureUpdate;
}

const FIELDS = ["trigger", "abstract_method", "verbatim_steps", "evidence"] as const;

/**
 * memory.procedure.update — revise an existing proven method when a new run taught you a better
 * or corrected way (MEMORY.md §7a). effect=write → requires the user's approval, and provenance
 * escalation blocks it if the turn was tainted. Bumps the method's version; re-embeds only if
 * the trigger changed.
 */
export const memoryProcedureUpdate: ToolImpl<ProcedureUpdateArgs> = {
  name: "memory.procedure.update",
  description:
    "Revise an existing method in your procedural memory when a new run improves or corrects it. Give the method `name` and only the fields to change (trigger, abstract_method, verbatim_steps, and/or evidence). Requires the user's approval.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The method name to revise, e.g. 'deploy.staging'." },
      trigger: { type: "string", description: "New 'when to use this' line (optional)." },
      abstract_method: { type: "string", description: "New generalized recipe (optional)." },
      verbatim_steps: { type: "string", description: "New exact steps (optional)." },
      evidence: { type: "string", description: "New supporting evidence (optional)." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "medium",
  reversible: false,

  validate(args): ValidateResult<ProcedureUpdateArgs> {
    const name = args["name"];
    if (typeof name !== "string" || name.trim() === "") {
      return { ok: false, error: "memory.procedure.update requires a non-empty `name`" };
    }
    const patch: ProcedureUpdate = {};
    for (const f of FIELDS) {
      const v = args[f];
      if (v === undefined) continue;
      if (typeof v !== "string" || v.trim() === "") {
        return { ok: false, error: `memory.procedure.update \`${f}\` must be a non-empty string when given` };
      }
      const key = f === "abstract_method" ? "abstractMethod" : f === "verbatim_steps" ? "verbatimSteps" : f;
      patch[key as keyof ProcedureUpdate] = v.trim();
    }
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: "memory.procedure.update needs at least one field to change" };
    }
    return { ok: true, value: { name: name.trim(), patch } };
  },

  async run(args: ProcedureUpdateArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.memory?.store;
    if (!store) throw new Error("memory is not available");
    const ok = await store.updateProcedure(args.name, args.patch);
    return { summary: ok ? `updated procedure '${args.name}'` : `no procedure named '${args.name}'` };
  },
};
