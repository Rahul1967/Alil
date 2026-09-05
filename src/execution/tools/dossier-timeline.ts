import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface DossierTimelineArgs {
  limit?: number;
  domain?: string;
}

/**
 * dossier.timeline — read the operator's trajectory: recorded transitions (an account opened, a
 * fact superseded, a person added) newest-first. Read-only, so the boundary auto-allows it. This is
 * the cheap answer to "what changed recently?" — it reads the `event` files the store emits
 * automatically on dossier transitions, rather than re-deriving history from full documents.
 */
export const dossierTimeline: ToolImpl<DossierTimelineArgs> = {
  name: "dossier.timeline",
  description:
    "Read the operator's life-arc: recorded transitions over time (fact created, changed, or superseded), newest first. Use this to answer \"what changed recently?\" or to understand how the operator's situation has evolved, instead of re-reading every document. Optionally filter by `domain` (a tag like financial/family/work) and cap with `limit`.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, description: "Max transitions to return, newest first (default 20)." },
      domain: { type: "string", description: "Restrict to one domain (a tag like financial, family, work)." },
    },
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<DossierTimelineArgs> {
    const value: DossierTimelineArgs = {};
    if (args["limit"] !== undefined) {
      const l = args["limit"];
      if (typeof l !== "number" || !Number.isInteger(l) || l < 1) return { ok: false, error: "`limit` must be a positive integer" };
      value.limit = l;
    }
    if (args["domain"] !== undefined) {
      if (typeof args["domain"] !== "string") return { ok: false, error: "`domain` must be a string" };
      value.domain = args["domain"];
    }
    return { ok: true, value };
  },

  async run(args: DossierTimelineArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.dossier?.store;
    if (!store) throw new Error("dossier is not available");
    const limit = args.limit ?? 20;
    let events = store.timeline();
    if (args.domain) events = events.filter((e) => String(e.frontmatter["domain"] ?? "") === args.domain);
    const rows = events.slice(0, limit).map((e) => ({
      when: String(e.frontmatter["when"] ?? e.frontmatter.updated).slice(0, 10),
      what: e.frontmatter.title,
      domain: String(e.frontmatter["domain"] ?? ""),
      subject: String(e.frontmatter["subject"] ?? ""),
      slug: e.frontmatter.slug,
    }));
    return {
      summary: `timeline: ${rows.length} transition(s)${args.domain ? ` in ${args.domain}` : ""}`,
      data: rows,
    };
  },
};
