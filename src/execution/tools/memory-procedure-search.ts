import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface ProcedureSearchArgs {
  task: string;
  k: number;
}

const MAX_K = 10;
const DEFAULT_K = 3;

/**
 * memory.procedure.search — before acting on a task, look for a proven method you've used
 * before (procedural memory, MEMORY.md §7a). Read-only, so the boundary auto-allows it.
 * Matches on each method's trigger and returns its abstract recipe inline. On a strong hit,
 * follow up with memory.procedure.fetch to get the exact steps, then implement.
 */
export const memoryProcedureSearch: ToolImpl<ProcedureSearchArgs> = {
  name: "memory.procedure.search",
  description:
    "Search your procedural memory for a proven method before doing a task. Give a short phrase describing the task; returns matching methods (name + when-to-use + an abstract recipe). If a result fits, call memory.procedure.fetch with its name for the exact steps and follow them. Returns nothing when you have no relevant proven method — then just proceed normally.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "The task you're about to do, e.g. 'deploy the app to staging'." },
      k: { type: "number", description: `How many methods to return (1–${MAX_K}, default ${DEFAULT_K}).` },
    },
    required: ["task"],
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<ProcedureSearchArgs> {
    const task = args["task"];
    if (typeof task !== "string" || task.trim() === "") {
      return { ok: false, error: "memory.procedure.search requires a non-empty `task`" };
    }
    let k = DEFAULT_K;
    if (args["k"] !== undefined) {
      if (typeof args["k"] !== "number" || !Number.isFinite(args["k"])) {
        return { ok: false, error: "memory.procedure.search `k` must be a number" };
      }
      k = Math.max(1, Math.min(MAX_K, Math.floor(args["k"])));
    }
    return { ok: true, value: { task: task.trim(), k } };
  },

  async run(args: ProcedureSearchArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.memory?.store;
    if (!store) throw new Error("memory is not available");
    const hits = await store.searchProcedures(args.task, args.k);
    const data = hits.map((h) => ({
      name: h.name,
      when: h.trigger,
      method: h.abstractMethod,
      tainted: h.provenance.origin === "ingested" || (h.provenance.taintedBy?.length ?? 0) > 0,
    }));
    return {
      summary: hits.length
        ? `found ${hits.length} proven method${hits.length === 1 ? "" : "s"} — fetch one to follow it`
        : "no proven method for this task yet",
      data,
    };
  },
};
