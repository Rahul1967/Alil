import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface ProcedureFetchArgs {
  name: string;
}

/**
 * memory.procedure.fetch — pull the full, exact steps + evidence for a proven method you found
 * via memory.procedure.search (MEMORY.md §7a). Read-only, auto-allowed. Fetching a method marks
 * it used (feeds ranking). Read the steps, understand them, then implement.
 */
export const memoryProcedureFetch: ToolImpl<ProcedureFetchArgs> = {
  name: "memory.procedure.fetch",
  description:
    "Fetch the full verbatim steps and supporting evidence for one proven method, by its name (as returned by memory.procedure.search). Use this once a searched method looks right, then follow the steps. Afterwards, record whether it worked with memory.procedure.outcome.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The method name, e.g. 'deploy.staging'." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<ProcedureFetchArgs> {
    const name = args["name"];
    if (typeof name !== "string" || name.trim() === "") {
      return { ok: false, error: "memory.procedure.fetch requires a non-empty `name`" };
    }
    return { ok: true, value: { name: name.trim() } };
  },

  async run(args: ProcedureFetchArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.memory?.store;
    if (!store) throw new Error("memory is not available");
    const p = await store.getProcedure(args.name);
    if (!p) return { summary: `no procedure named '${args.name}'` };
    return {
      summary: `fetched procedure '${p.name}' (v${p.version}, used ${p.uses}×)`,
      data: {
        name: p.name,
        when: p.trigger,
        method: p.abstractMethod,
        steps: p.verbatimSteps,
        evidence: p.evidence,
        tags: p.tags,
        ...(p.successes + p.failures > 0 ? { track: `${p.successes} worked / ${p.failures} failed` } : {}),
        ...(p.status === "deprecated" ? { deprecated: true } : {}),
        tainted: p.provenance.origin === "ingested" || (p.provenance.taintedBy?.length ?? 0) > 0,
      },
    };
  },
};
