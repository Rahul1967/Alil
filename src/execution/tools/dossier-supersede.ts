import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface DossierSupersedeArgs {
  slug: string;
  reason: string;
}

/**
 * dossier.supersede — mark a dossier file's content stale (status → superseded) with a dated reason,
 * WITHOUT destroying it, so the operator's trajectory stays reconstructable. Effect: write, gated by
 * the boundary. Use this when a fact changes (a move, a job change, a closed account) rather than
 * overwriting — the superseded file is history, and a new file records the current truth.
 */
export const dossierSupersede: ToolImpl<DossierSupersedeArgs> = {
  name: "dossier.supersede",
  description:
    "Retire a dossier file whose fact has CHANGED: flips its status to superseded and appends a dated reason, keeping the file as history. Use instead of deleting when a fact is no longer current (moved, changed jobs, closed an account). Writing requires approval.",
  parameters: {
    type: "object",
    properties: {
      slug: { type: "string", description: "The file to supersede." },
      reason: { type: "string", description: "Why it's no longer current (recorded with today's date)." },
    },
    required: ["slug", "reason"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "medium",
  reversible: false,

  validate(args): ValidateResult<DossierSupersedeArgs> {
    const slug = args["slug"];
    const reason = args["reason"];
    if (typeof slug !== "string" || slug.length === 0) return { ok: false, error: "dossier.supersede requires a non-empty string `slug`" };
    if (typeof reason !== "string" || reason.length === 0) return { ok: false, error: "dossier.supersede requires a non-empty string `reason`" };
    return { ok: true, value: { slug, reason } };
  },

  async run(args: DossierSupersedeArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.dossier?.store;
    if (!store) throw new Error("dossier is not available");
    const f = store.supersede(args.slug, args.reason, { origin: "model" });
    return { summary: `superseded dossier "${f.frontmatter.title}"`, data: { slug: f.frontmatter.slug, status: f.frontmatter.status } };
  },
};
