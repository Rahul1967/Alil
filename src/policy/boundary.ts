import type { ActionSink, ProposedAction } from "../runtime/types.ts";
import type { ToolResult } from "../core/types.ts";
import type { RuleSource } from "./rules.ts";
import type { GuardHook } from "./hooks/types.ts";
import { classify } from "./classifier.ts";
import { evaluate } from "./engine.ts";
import { escalateForProvenance } from "./provenance-check.ts";
import { ask } from "./verdict.ts";
import type { ToolRegistry } from "../execution/tools/registry.ts";
import type { Executor } from "../execution/executor.ts";

export interface BoundaryDeps {
  rules: RuleSource;
  tools: ToolRegistry;
  hooks: GuardHook[];
  executor: Executor;
}

/**
 * The policy boundary — the single enforcement point. Implements ActionSink so the brain
 * plugs into it unchanged. Flow: classify → provenance-escalate → six-stage pipeline →
 * act (execute | deny | stub-HITL).
 */
export class PolicyBoundary implements ActionSink {
  readonly #deps: BoundaryDeps;

  constructor(deps: BoundaryDeps) {
    this.#deps = deps;
  }

  async submit(proposed: ProposedAction): Promise<ToolResult> {
    const { tools, hooks, executor } = this.#deps;
    const config = await this.#deps.rules.load();

    // 1. Classify (unknown tool ⇒ forced ask).
    const { action, unknown } = classify(proposed.action, tools);

    // 2. Pipeline verdict, then 3. provenance escalation.
    const base = unknown
      ? ask("classifier", `unknown tool "${action.tool}"`)
      : evaluate(action, config, hooks);
    const verdict = escalateForProvenance(base, action);

    // 4. Act on the verdict.
    if (verdict.decision === "allow") {
      const tool = tools.get(action.tool);
      if (!tool) {
        return { actionId: action.id, outcome: "denied", summary: `unknown tool "${action.tool}"` };
      }
      return executor.execute(action, tool);
    }

    if (verdict.decision === "deny") {
      return { actionId: action.id, outcome: "denied", summary: `denied [${verdict.decidedBy}]: ${verdict.reason}` };
    }

    // ask / defer → HITL. Stubbed until the approvals section (auto-deny, fail-closed).
    return {
      actionId: action.id,
      outcome: "denied",
      summary: `approval required [${verdict.decidedBy}]: ${verdict.reason} (HITL not wired yet)`,
    };
  }
}
