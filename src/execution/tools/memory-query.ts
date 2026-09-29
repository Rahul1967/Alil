import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import { lensFocus, readTags, tagRegistry } from "./lens-context.ts";

interface MemoryQueryArgs {
  query: string;
  k: number;
  tags?: string[];
}

const MAX_K = 20;
const DEFAULT_K = 5;

/**
 * memory.query — semantic search over your PAST conversations (episodic memory). Read-only,
 * so the boundary auto-allows it. Returns the most relevant closed-episode summaries for a
 * search phrase, each with its date. Recent conversation is already in your history; use this
 * to recall older context you no longer see.
 */
export const memoryQuery: ToolImpl<MemoryQueryArgs> = {
  name: "memory.query",
  description:
    "Search your own memory of past conversations. Give a short natural-language phrase describing what you're trying to recall; returns the most relevant summaries of earlier sessions (with dates). Use this when the user refers to something from before that isn't in your recent history or standing facts.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to recall, e.g. 'the postgres connection pool settings'." },
      k: { type: "number", description: `How many results (1–${MAX_K}, default ${DEFAULT_K}).` },
      tags: { type: "array", items: { type: "string" }, description: "Only return sessions tagged with at least one of these (optional)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<MemoryQueryArgs> {
    const query = args["query"];
    if (typeof query !== "string" || query.trim() === "") {
      return { ok: false, error: "memory.query requires a non-empty `query`" };
    }
    let k = DEFAULT_K;
    if (args["k"] !== undefined) {
      if (typeof args["k"] !== "number" || !Number.isFinite(args["k"])) {
        return { ok: false, error: "memory.query `k` must be a number" };
      }
      k = Math.max(1, Math.min(MAX_K, Math.floor(args["k"])));
    }
    const tags = readTags(args["tags"], "memory.query");
    if (!tags.ok) return tags;
    return { ok: true, value: { query: query.trim(), k, ...(tags.tags?.length ? { tags: tags.tags } : {}) } };
  },

  async run(args: MemoryQueryArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.memory?.store;
    if (!store) throw new Error("memory is not available");
    const hits = await store.searchEpisodes(args.query, args.k, {
      ...(args.tags ? { tags: tagRegistry(ctx).normalizeAll(args.tags) } : {}),
      lens: lensFocus(ctx, "episodes"),
    });
    const data = hits.map((h) => ({
      episodeId: h.episodeId,
      when: h.when,
      summary: h.text,
      ...(h.tags.length ? { tags: h.tags } : {}),
      tainted: h.provenance.origin === "ingested" || (h.provenance.taintedBy?.length ?? 0) > 0,
    }));
    return {
      summary: hits.length ? `recalled ${hits.length} past episode${hits.length === 1 ? "" : "s"}` : "no matching past conversations",
      data,
    };
  },
};
