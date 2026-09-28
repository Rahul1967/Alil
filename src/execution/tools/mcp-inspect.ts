import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface McpInspectArgs {
  server: string;
  name: string;
}

/**
 * mcp.inspect — load the FULL schema (arguments, description, effect classification) for ONE MCP
 * tool identified by mcp.search. This is the "inspect" layer of on-demand discovery: you pull only
 * the definition you actually need into context, not every server's whole catalog. Read-only, so
 * the boundary auto-allows it. Then call it with mcp.call.
 */
export const mcpInspect: ToolImpl<McpInspectArgs> = {
  name: "mcp.inspect",
  description:
    "Get the full definition of one MCP tool (its input schema and how risky it is), by `server` and `name` from mcp.search. Load a tool's schema only when you intend to use it. Then run it with mcp.call.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "The MCP server that exposes the tool (from mcp.search)." },
      name: { type: "string", description: "The tool name (from mcp.search)." },
    },
    required: ["server", "name"],
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<McpInspectArgs> {
    const server = args["server"];
    const name = args["name"];
    if (typeof server !== "string" || server.length === 0) return { ok: false, error: "mcp.inspect requires a non-empty string `server`" };
    if (typeof name !== "string" || name.length === 0) return { ok: false, error: "mcp.inspect requires a non-empty string `name`" };
    return { ok: true, value: { server, name } };
  },

  async run(args: McpInspectArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const registry = ctx.mcp?.registry;
    if (!registry) throw new Error("mcp: no external tool servers configured");
    const def = await registry.inspect(args.server, args.name);
    const cls = await registry.classify(args.server, args.name);
    return {
      summary: `mcp.inspect ${args.server}/${args.name} (${cls.effect}/${cls.risk})`,
      data: {
        server: def.server,
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        effect: cls.effect,
        risk: cls.risk,
        reversible: cls.reversible,
      },
    };
  },
};
