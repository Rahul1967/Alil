import type { ActionContract } from "../core/types.ts";
import type { ToolRegistry } from "../execution/tools/registry.ts";

export interface Classification {
  action: ActionContract; // effect/risk/reversible filled from the tool; classified: true
  unknown: boolean; // true ⇒ tool not in registry (forces `ask`)
}

/**
 * Semantic classification: replace the brain's conservative placeholders with the tool's
 * declared effect/risk/reversibility. An unknown tool cannot be classified and is flagged
 * so the boundary forces human review — never a silent allow.
 */
export function classify(action: ActionContract, tools: ToolRegistry): Classification {
  const tool = tools.get(action.tool);
  if (!tool) {
    return { action: { ...action, classified: false }, unknown: true };
  }
  return {
    action: {
      ...action,
      effect: tool.effect,
      risk: tool.risk,
      reversible: tool.reversible,
      classified: true,
    },
    unknown: false,
  };
}
