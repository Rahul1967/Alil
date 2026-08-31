import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface DossierReadArgs {
  slug: string;
}

/**
 * dossier.read — open one dossier file in full (frontmatter + body) by its slug. Read-only, so the
 * boundary auto-allows it. Use after dossier.query locates the file you want. The `description`
 * field on each file tells you how that file is meant to be read and updated.
 */
export const dossierRead: ToolImpl<DossierReadArgs> = {
  name: "dossier.read",
  description:
    "Open one operator-dossier file in full by its `slug` (from dossier.query). Returns the frontmatter (type, tags, description, dates) and the markdown body. The file's `description` says how to read and update it.",
  parameters: {
    type: "object",
    properties: { slug: { type: "string", description: "The file's stable slug id." } },
    required: ["slug"],
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<DossierReadArgs> {
    const slug = args["slug"];
    if (typeof slug !== "string" || slug.length === 0) return { ok: false, error: "dossier.read requires a non-empty string `slug`" };
    return { ok: true, value: { slug } };
  },

  async run(args: DossierReadArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.dossier?.store;
    if (!store) throw new Error("dossier is not available");
    const f = store.get(args.slug);
    if (!f) return { summary: `dossier: no file "${args.slug}"`, data: null };
    return { summary: `dossier: ${f.frontmatter.title}`, data: { frontmatter: f.frontmatter, body: f.body, relPath: f.relPath } };
  },
};
