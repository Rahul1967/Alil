import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import type { DossierQuery, DossierType } from "../../dossier/types.ts";
import { KNOWN_DOSSIER_TYPES } from "../../dossier/types.ts";

/**
 * dossier.query — search the operator dossier by type, tags, status, date, or free text. Read-only,
 * so the boundary auto-allows it. Returns matching files (path, title, type, tags, snippet) without
 * their full bodies; follow up with dossier.read to open one. This is how you find what you already
 * know about the operator instead of asking them again.
 */
export const dossierQuery: ToolImpl<DossierQuery> = {
  name: "dossier.query",
  description:
    "Search your operator dossier (the durable model of the user). Filter by `type` (identity|preferences|note|person|account|loan|document|event|index), `tagsAny`/`tagsAll` (e.g. financial, health, family, future-plans), `status`, `text` (free-text over title/description/body), and `updatedAfter`/`updatedBefore` (YYYY-MM-DD). Returns matches without full bodies — use dossier.read to open one.",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", description: `Restrict to one file type (well-known: ${KNOWN_DOSSIER_TYPES.join(", ")}, or any Alil-invented type).` },
      tagsAny: { type: "array", items: { type: "string" }, description: "Match files having ANY of these tags." },
      tagsAll: { type: "array", items: { type: "string" }, description: "Match only files having ALL of these tags." },
      status: { type: "string", enum: ["active", "superseded", "archived"], description: "Restrict to a lifecycle status." },
      text: { type: "string", description: "Case-insensitive free-text match over title/description/body." },
      updatedAfter: { type: "string", description: "Only files updated on/after this date (YYYY-MM-DD)." },
      updatedBefore: { type: "string", description: "Only files updated on/before this date (YYYY-MM-DD)." },
      limit: { type: "number", description: "Max results (default all)." },
    },
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<DossierQuery> {
    const q: DossierQuery = {};
    if (args["type"] !== undefined) {
      if (typeof args["type"] !== "string") return { ok: false, error: "`type` must be a string" };
      q.type = args["type"] as DossierType;
    }
    for (const key of ["tagsAny", "tagsAll"] as const) {
      if (args[key] !== undefined) {
        if (!Array.isArray(args[key])) return { ok: false, error: `${key} must be an array of strings` };
        q[key] = (args[key] as unknown[]).map(String);
      }
    }
    for (const key of ["status", "text", "updatedAfter", "updatedBefore"] as const) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== "string") return { ok: false, error: `${key} must be a string` };
        (q as Record<string, unknown>)[key] = args[key];
      }
    }
    if (args["limit"] !== undefined) {
      if (typeof args["limit"] !== "number") return { ok: false, error: "limit must be a number" };
      q.limit = args["limit"];
    }
    return { ok: true, value: q };
  },

  async run(args: DossierQuery, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.dossier?.store;
    if (!store) throw new Error("dossier is not available");
    const hits = store.query(args).map((f) => ({
      slug: f.frontmatter.slug,
      type: f.frontmatter.type,
      title: f.frontmatter.title,
      tags: f.frontmatter.tags,
      status: f.frontmatter.status,
      updated: f.frontmatter.updated,
      snippet: f.body.replace(/\s+/g, " ").slice(0, 160),
    }));
    return { summary: `dossier: ${hits.length} match(es)`, data: hits };
  },
};
