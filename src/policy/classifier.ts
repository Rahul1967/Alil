import type { ActionContract } from "../core/types.ts";
import type { ToolRegistry } from "../execution/tools/registry.ts";
import type { ToolContext } from "../execution/tools/types.ts";

export interface Classification {
  action: ActionContract; // effect/risk/reversible filled from the tool; classified: true
  unknown: boolean; // true ⇒ tool not in registry (forces `ask`)
}

/**
 * Semantic classification: replace the brain's conservative placeholders with the tool's
 * declared effect/risk/reversibility. An unknown tool cannot be classified and is flagged
 * so the boundary forces human review — never a silent allow.
 */
export function classify(action: ActionContract, tools: ToolRegistry, ctx?: ToolContext): Classification {
  const tool = tools.get(action.tool);
  if (!tool) {
    return { action: { ...action, classified: false }, unknown: true };
  }
  // Per-call refinement from operator config (e.g. a pinned MCP tool). A throwing refine falls
  // back to the tool's declared (conservative) classification.
  let refined = null;
  if (tool.refine && ctx) {
    try { refined = tool.refine(action.args, ctx); } catch { refined = null; }
  }
  const cls = refined ?? { effect: tool.effect, risk: tool.risk, reversible: tool.reversible };
  return {
    action: { ...action, effect: cls.effect, risk: cls.risk, reversible: cls.reversible, classified: true },
    unknown: false,
  };
}
