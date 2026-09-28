import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface McpSearchArgs {
  query: string;
  limit?: number;
}

/**
 * mcp.search — find MCP tools by intent WITHOUT loading their schemas into context. This is the
 * "catalog" layer of on-demand discovery: it returns matching tool names + one-line descriptions
 * only, so hundreds of MCP tools cost ~nothing per turn (no "tools tax"). Read-only, so the
 * boundary auto-allows it. Follow up with mcp.inspect to load one tool's full schema, then mcp.call.
 */
export const mcpSearch: ToolImpl<McpSearchArgs> = {
  name: "mcp.search",
  description:
    "Search available MCP (external) tools by intent and get back matching tool names with one-line descriptions (no schemas). Use this FIRST when you need an external capability — it keeps context small. Then mcp.inspect a candidate for its full schema, and mcp.call to run it. Args: `query` (what you want to do), optional `limit`.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language description of the capability you need." },
      limit: { type: "integer", minimum: 1, description: "Max matches to return (default 8)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<McpSearchArgs> {
    const query = args["query"];
    if (typeof query !== "string" || query.trim().length === 0) {
      return { ok: false, error: "mcp.search requires a non-empty string `query`" };
    }
    const value: McpSearchArgs = { query };
    if (args["limit"] !== undefined) {
      const l = args["limit"];
      if (typeof l !== "number" || !Number.isInteger(l) || l < 1) return { ok: false, error: "`limit` must be a positive integer" };
      value.limit = l;
    }
    return { ok: true, value };
  },

  async run(args: McpSearchArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const registry = ctx.mcp?.registry;
    if (!registry) return { summary: "mcp: no external tool servers configured", data: [] };
    const hits = await registry.search(args.query, args.limit ?? 8);
    return {
      summary: `mcp.search "${args.query}" → ${hits.length} tool(s)`,
      data: hits.map((h) => ({ server: h.server, name: h.name, description: h.description })),
    };
  },
};
