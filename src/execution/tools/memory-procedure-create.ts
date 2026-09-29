import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import { activeLens, readTags, tagRegistry } from "./lens-context.ts";

interface ProcedureCreateArgs {
  name: string;
  trigger: string;
  abstract_method: string;
  verbatim_steps: string;
  evidence: string;
  tags: string[];
}

/**
 * memory.procedure.create — record a proven method into procedural memory (MEMORY.md §7a).
 * effect=write, so the policy boundary requires the user's approval — human approval is Alil's
 * success gate: a method enters the library only when the user confirms it worked (and
 * provenance escalation blocks it outright if the turn was influenced by untrusted content).
 * Dedupes on the trigger: a near-duplicate is refused with the existing name so you update it
 * instead of piling on a second entry.
 *
 * Tags (what the method is about) are required and shown in the approval prompt; the active lens
 * stamp (where it was learned) is applied here by the harness, never chosen by the model.
 */
export const memoryProcedureCreate: ToolImpl<ProcedureCreateArgs> = {
  name: "memory.procedure.create",
  description:
    "Save a proven, working method to your procedural memory so you can reuse it next time. Do this after a task succeeds and no existing method covered it. Provide: a stable `name`; a `trigger` (a short 'when to use this' line — this is what future searches match on); an `abstract_method` (the generalized recipe); the `verbatim_steps` (exactly what worked); `evidence` (the task it succeeded on); and `tags` — at least one domain tag saying what the method is about (reuse existing tags, e.g. the active lens's tags). Requires the user's approval. If a near-identical method already exists, update it instead.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Stable identifier, e.g. 'deploy.staging'." },
      trigger: { type: "string", description: "When to use this — the phrase future searches match, e.g. 'deploying the app to the staging environment'." },
      abstract_method: { type: "string", description: "The generalized recipe (transferable across similar tasks)." },
      verbatim_steps: { type: "string", description: "The exact steps that worked this time." },
      evidence: { type: "string", description: "The task this succeeded on / why it's trusted." },
      tags: { type: "array", items: { type: "string" }, minItems: 1, description: "What the method is about — at least one domain tag, e.g. ['work', 'deployment']." },
    },
    required: ["name", "trigger", "abstract_method", "verbatim_steps", "tags"],
    additionalProperties: false,
  },
  effect: "write",
  // High: a procedure is replayed as trusted how-to in later turns, so a poisoned one is a lasting
  // injection. High makes a tainted turn's write a hard deny and keeps it out of standing grants.
  risk: "high",
  reversible: false,

  validate(args): ValidateResult<ProcedureCreateArgs> {
    const req = ["name", "trigger", "abstract_method", "verbatim_steps"] as const;
    for (const f of req) {
      const v = args[f];
      if (typeof v !== "string" || v.trim() === "") {
        return { ok: false, error: `memory.procedure.create requires a non-empty \`${f}\`` };
      }
    }
    const evidence = args["evidence"];
    if (evidence !== undefined && typeof evidence !== "string") {
      return { ok: false, error: "memory.procedure.create `evidence` must be a string" };
    }
    const tags = readTags(args["tags"], "memory.procedure.create");
    if (!tags.ok) return tags;
    if (!tags.tags || tags.tags.length === 0) {
      return { ok: false, error: "memory.procedure.create requires `tags` — at least one domain tag saying what the method is about" };
    }
    return {
      ok: true,
      value: {
        name: (args["name"] as string).trim(),
        trigger: (args["trigger"] as string).trim(),
        abstract_method: (args["abstract_method"] as string).trim(),
        verbatim_steps: (args["verbatim_steps"] as string).trim(),
        evidence: typeof evidence === "string" ? evidence.trim() : "",
        tags: tags.tags,
      },
    };
  },

  async run(args: ProcedureCreateArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.memory?.store;
    if (!store) throw new Error("memory is not available");
    const tags = tagRegistry(ctx).normalizeAll(args.tags);
    const lens = activeLens(ctx);
    const res = await store.createProcedure({
      name: args.name,
      trigger: args.trigger,
      abstractMethod: args.abstract_method,
      verbatimSteps: args.verbatim_steps,
      evidence: args.evidence,
      provenance: { origin: "operator" },
      tags,
      lens: lens?.id ?? null,
    });
    if (!res.created) {
      return {
        summary: `not saved — '${res.duplicateOf}' already covers this (similarity ${res.similarity.toFixed(2)}); update it instead with memory.procedure.update`,
        data: { duplicateOf: res.duplicateOf, similarity: res.similarity },
      };
    }
    return { summary: `saved procedure '${res.name}' [${tags.join(", ")}]${lens ? ` (lens: ${lens.id})` : ""}` };
  },
};
