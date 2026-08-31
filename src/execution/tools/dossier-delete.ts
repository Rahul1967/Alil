import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface DossierDeleteArgs {
  slug: string;
}

/**
 * dossier.delete — permanently remove a dossier file. HIGH-risk (the boundary requires explicit
 * approval): prefer dossier.supersede for facts that merely changed, so history is preserved.
 * Reserve delete for files created in error or that the operator asks to erase.
 */
export const dossierDelete: ToolImpl<DossierDeleteArgs> = {
  name: "dossier.delete",
  description:
    "Permanently delete a dossier file by `slug`. High-risk and irreversible — prefer dossier.supersede for facts that changed. Use only for mistakes or when the operator explicitly asks to erase it. Requires approval.",
  parameters: {
    type: "object",
    properties: { slug: { type: "string", description: "The file to delete." } },
    required: ["slug"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "high",
  reversible: false,

  validate(args): ValidateResult<DossierDeleteArgs> {
    const slug = args["slug"];
    if (typeof slug !== "string" || slug.length === 0) return { ok: false, error: "dossier.delete requires a non-empty string `slug`" };
    return { ok: true, value: { slug } };
  },

  async run(args: DossierDeleteArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.dossier?.store;
    if (!store) throw new Error("dossier is not available");
    const removed = store.remove(args.slug);
    return { summary: removed ? `deleted dossier "${args.slug}"` : `dossier: no file "${args.slug}"`, data: { removed } };
  },
};
