import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import type { ProcedureUpdate, ProcedureStatus } from "../../memory/types.ts";
import { readTags, tagRegistry } from "./lens-context.ts";

interface ProcedureUpdateArgs {
  name: string;
  patch: ProcedureUpdate;
}

const FIELDS = ["trigger", "abstract_method", "verbatim_steps", "evidence"] as const;
const STATUSES: ProcedureStatus[] = ["active", "deprecated"];

/**
 * memory.procedure.update — revise an existing proven method when a new run taught you a better
 * or corrected way (MEMORY.md §7a). effect=write → requires the user's approval, and provenance
 * escalation blocks it if the turn was tainted. Bumps the method's version; re-indexes only if the
 * trigger or tags changed. `status: "deprecated"` retires a wrong method (search skips it).
 */
export const memoryProcedureUpdate: ToolImpl<ProcedureUpdateArgs> = {
  name: "memory.procedure.update",
  description:
    "Revise an existing method in your procedural memory when a new run improves or corrects it. Give the method `name` and only the fields to change (trigger, abstract_method, verbatim_steps, evidence, tags). Set `status` to 'deprecated' to retire a method that turned out wrong (search stops returning it), or 'active' to restore it. Requires the user's approval.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The method name to revise, e.g. 'deploy.staging'." },
      trigger: { type: "string", description: "New 'when to use this' line (optional)." },
      abstract_method: { type: "string", description: "New generalized recipe (optional)." },
      verbatim_steps: { type: "string", description: "New exact steps (optional)." },
      evidence: { type: "string", description: "New supporting evidence (optional)." },
      tags: { type: "array", items: { type: "string" }, description: "Replacement tag list (optional)." },
      status: { type: "string", enum: STATUSES, description: "'deprecated' retires the method; 'active' restores it (optional)." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  effect: "write",
  // High: a procedure is replayed as trusted how-to in later turns, so a poisoned one is a lasting
  // injection. High makes a tainted turn's write a hard deny and keeps it out of standing grants.
  risk: "high",
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
      if (f === "abstract_method") patch.abstractMethod = v.trim();
      else if (f === "verbatim_steps") patch.verbatimSteps = v.trim();
      else patch[f] = v.trim();
    }
    const tags = readTags(args["tags"], "memory.procedure.update");
    if (!tags.ok) return tags;
    if (tags.tags !== undefined) {
      if (tags.tags.length === 0) return { ok: false, error: "memory.procedure.update `tags` cannot be empty (a method keeps at least one tag)" };
      patch.tags = tags.tags;
    }
    const status = args["status"];
    if (status !== undefined) {
      if (!STATUSES.includes(status as ProcedureStatus)) return { ok: false, error: "memory.procedure.update `status` must be 'active' or 'deprecated'" };
      patch.status = status as ProcedureStatus;
    }
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: "memory.procedure.update needs at least one field to change" };
    }
    return { ok: true, value: { name: name.trim(), patch } };
  },

  async run(args: ProcedureUpdateArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.memory?.store;
    if (!store) throw new Error("memory is not available");
    const patch = args.patch.tags ? { ...args.patch, tags: tagRegistry(ctx).normalizeAll(args.patch.tags) } : args.patch;
    const ok = await store.updateProcedure(args.name, patch);
    return { summary: ok ? `updated procedure '${args.name}'${patch.status === "deprecated" ? " (deprecated — search will skip it)" : ""}` : `no procedure named '${args.name}'` };
  },
};
