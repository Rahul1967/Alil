import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import type { DossierCreate, DossierType } from "../../dossier/types.ts";
import { KNOWN_DOSSIER_TYPES } from "../../dossier/types.ts";

/**
 * dossier.create — create a new dossier file recording something durable about the operator. Effect:
 * write, so the boundary gates it (the operator approves before commit; content ingested from
 * untrusted sources this turn is escalated and cannot silently commit). Give it a self-describing
 * `description` (how to read/update the file) and topical `tags` so it stays queryable.
 */
export const dossierCreate: ToolImpl<DossierCreate> = {
  name: "dossier.create",
  description:
    "Create a new operator-dossier file (a durable fact about the user). `type` is an OPEN vocabulary — reach first for a well-known type (identity, preferences, note, person, account, loan, document, event, index), but INVENT a new lowercase type (e.g. vehicle, subscription, project, pet) whenever the operator's life needs a kind that isn't listed. Provide `title`, topical `tags` (financial, health, family, future-plans, …), a `description` saying how to read/update it, and the markdown `body`. Use `fields` for type-specific frontmatter (institution, relation, when, …). Writing requires approval.",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", description: `What the file IS (a lowercase slug). Well-known: ${KNOWN_DOSSIER_TYPES.join(", ")} — or invent a new one.` },
      title: { type: "string", description: "Human title, e.g. 'Rahul's Bucket List'." },
      tags: { type: "array", items: { type: "string" }, description: "What it's ABOUT (query key)." },
      description: { type: "string", description: "Self-describing contract: how to read and update this file." },
      body: { type: "string", description: "Markdown content. Left empty, a per-type skeleton is seeded." },
      status: { type: "string", enum: ["active", "superseded", "archived"] },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      slug: { type: "string", description: "Optional explicit slug; derived from title otherwise." },
      fields: { type: "object", description: "Extra type-specific frontmatter (flat key/values).", additionalProperties: true },
    },
    required: ["type", "title"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "medium",
  reversible: false,

  validate(args): ValidateResult<DossierCreate> {
    const type = args["type"];
    if (typeof type !== "string" || !/^[a-z][a-z0-9-]*$/.test(type))
      return { ok: false, error: "dossier.create requires a `type` that is a lowercase slug (letters, digits, hyphens)" };
    const title = args["title"];
    if (typeof title !== "string" || title.length === 0) return { ok: false, error: "dossier.create requires a non-empty string `title`" };
    const value: DossierCreate = { type: type as DossierType, title };
    if (args["tags"] !== undefined) {
      if (!Array.isArray(args["tags"])) return { ok: false, error: "`tags` must be an array of strings" };
      value.tags = (args["tags"] as unknown[]).map(String);
    }
    for (const key of ["description", "body", "status", "confidence", "slug"] as const) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== "string") return { ok: false, error: `\`${key}\` must be a string` };
        (value as unknown as Record<string, unknown>)[key] = args[key];
      }
    }
    if (args["fields"] !== undefined) {
      if (typeof args["fields"] !== "object" || args["fields"] === null || Array.isArray(args["fields"]))
        return { ok: false, error: "`fields` must be an object" };
      value.fields = args["fields"] as Record<string, unknown>;
    }
    return { ok: true, value };
  },

  async run(args: DossierCreate, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.dossier?.store;
    if (!store) throw new Error("dossier is not available");
    const f = store.create(args, { origin: "model" });
    return { summary: `created dossier "${f.frontmatter.title}" (${f.relPath})`, data: { slug: f.frontmatter.slug, relPath: f.relPath } };
  },

  async verify(args: DossierCreate, ctx: ToolContext): Promise<string> {
    const store = ctx.dossier?.store;
    if (!store) return "VERIFICATION ERROR: dossier is not available";
    const f = store.list().find((x) => x.frontmatter.title === args.title);
    if (!f) return `VERIFICATION FAILED: no dossier file titled "${args.title}" exists after create`;
    return `verified: dossier file ${f.relPath} exists`;
  },
};
