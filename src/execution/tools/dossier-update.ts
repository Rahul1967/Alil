import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import type { DossierPatch } from "../../dossier/types.ts";

interface DossierUpdateArgs {
  slug: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
}

/**
 * dossier.update — edit an existing dossier file's body and/or frontmatter. Effect: write, so the
 * boundary gates it. `updated` is refreshed automatically; `slug`/`type` are immutable. To replace
 * a fact that has CHANGED (not just add to it), prefer dossier.supersede so history is preserved.
 */
export const dossierUpdate: ToolImpl<DossierUpdateArgs> = {
  name: "dossier.update",
  description:
    "Edit an existing operator-dossier file by `slug`. Provide a new `body` (replaces the markdown content) and/or a `frontmatter` patch (shallow-merged; e.g. tags, description, confidence, status, type-specific fields). To retire a fact that changed, prefer dossier.supersede. Writing requires approval.",
  parameters: {
    type: "object",
    properties: {
      slug: { type: "string", description: "The file to edit (its stable slug)." },
      body: { type: "string", description: "New markdown body (replaces existing content)." },
      frontmatter: { type: "object", description: "Frontmatter fields to merge (flat key/values).", additionalProperties: true },
    },
    required: ["slug"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "medium",
  reversible: false,

  validate(args): ValidateResult<DossierUpdateArgs> {
    const slug = args["slug"];
    if (typeof slug !== "string" || slug.length === 0) return { ok: false, error: "dossier.update requires a non-empty string `slug`" };
    const value: DossierUpdateArgs = { slug };
    if (args["body"] !== undefined) {
      if (typeof args["body"] !== "string") return { ok: false, error: "`body` must be a string" };
      value.body = args["body"];
    }
    if (args["frontmatter"] !== undefined) {
      if (typeof args["frontmatter"] !== "object" || args["frontmatter"] === null || Array.isArray(args["frontmatter"]))
        return { ok: false, error: "`frontmatter` must be an object" };
      value.frontmatter = args["frontmatter"] as Record<string, unknown>;
    }
    if (value.body === undefined && value.frontmatter === undefined)
      return { ok: false, error: "dossier.update needs a `body` and/or `frontmatter` to change" };
    return { ok: true, value };
  },

  async run(args: DossierUpdateArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.dossier?.store;
    if (!store) throw new Error("dossier is not available");
    const patch: DossierPatch = {
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.frontmatter !== undefined ? { frontmatter: args.frontmatter } : {}),
    };
    const f = store.update(args.slug, patch, { origin: "model" });
    return { summary: `updated dossier "${f.frontmatter.title}"`, data: { slug: f.frontmatter.slug, updated: f.frontmatter.updated } };
  },
};
