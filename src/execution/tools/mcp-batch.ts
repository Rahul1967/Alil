import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import type { McpBatchStep } from "../mcp/types.ts";

interface McpBatchArgs {
  steps: McpBatchStep[];
}

/**
 * mcp.batch — run a short pipeline of MCP calls host-side, so large intermediate results DON'T pass
 * through the model's context (the token-saving benefit of "code mode", without running any
 * model-authored code — no execution sandbox, no new risk). Each step is a normal MCP call; a
 * step's string args may reference an earlier step's result with `{{stepId}}`, and the host
 * substitutes it before calling. Only a compact per-step summary returns to the model.
 *
 * Declared execute/high so the boundary gates the whole pipeline once (every underlying call also
 * flows through the same retry/timeout/circuit-breaker/idempotency path). Results are untrusted
 * (ingested) and taint follow-on actions.
 */
export const mcpBatch: ToolImpl<McpBatchArgs> = {
  name: "mcp.batch",
  description:
    "Run a sequence of MCP tool calls in one pass, keeping large intermediate results out of your context — use when you'd otherwise chain several mcp.call steps and pass big outputs between them. Each step: {id, server, name, args?}. A later step's string arg can reference an earlier step's result text with `{{earlierStepId}}`. Only compact summaries return. Running external tools requires approval.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        description: "Ordered steps; each is a call whose string args may reference prior steps via {{id}}.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique step id (referenceable by later steps)." },
            server: { type: "string" },
            name: { type: "string" },
            args: { type: "object", additionalProperties: true },
          },
          required: ["id", "server", "name"],
          additionalProperties: false,
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
  effect: "execute",
  risk: "high",
  reversible: false,

  validate(args): ValidateResult<McpBatchArgs> {
    const steps = args["steps"];
    if (!Array.isArray(steps) || steps.length === 0) return { ok: false, error: "mcp.batch requires a non-empty `steps` array" };
    const ids = new Set<string>();
    const out: McpBatchStep[] = [];
    for (const [i, s] of steps.entries()) {
      if (typeof s !== "object" || s === null) return { ok: false, error: `step ${i} is not an object` };
      const o = s as Record<string, unknown>;
      if (typeof o["id"] !== "string" || o["id"].length === 0) return { ok: false, error: `step ${i} needs a string \`id\`` };
      if (ids.has(o["id"] as string)) return { ok: false, error: `duplicate step id "${o["id"] as string}"` };
      ids.add(o["id"] as string);
      if (typeof o["server"] !== "string" || o["server"].length === 0) return { ok: false, error: `step ${o["id"] as string} needs a string \`server\`` };
      if (typeof o["name"] !== "string" || o["name"].length === 0) return { ok: false, error: `step ${o["id"] as string} needs a string \`name\`` };
      if (o["args"] !== undefined && (typeof o["args"] !== "object" || o["args"] === null || Array.isArray(o["args"]))) {
        return { ok: false, error: `step ${o["id"] as string} \`args\` must be an object` };
      }
      out.push({
        id: o["id"] as string,
        server: o["server"] as string,
        name: o["name"] as string,
        ...(o["args"] !== undefined ? { args: o["args"] as Record<string, unknown> } : {}),
      });
    }
    return { ok: true, value: { steps: out } };
  },

  async run(args: McpBatchArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const registry = ctx.mcp?.registry;
    if (!registry) throw new Error("mcp: no external tool servers configured");
    const res = await registry.batch(args.steps);
    return {
      summary: `mcp.batch: ${res.completed.filter((s) => s.ok).length}/${args.steps.length} step(s) ok${res.ok ? "" : ` (stopped at ${res.stoppedAt})`}`,
      data: res,
      // The batch touched external tools; its output is untrusted and taints follow-on actions.
      provenance: { origin: "ingested", ingestedFrom: "mcp:batch" },
    };
  },
};
