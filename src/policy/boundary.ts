import type { ActionSink, ProposedAction } from "../runtime/types.ts";
import type { ActionContract, ToolResult } from "../core/types.ts";
import type { RuleSource } from "./rules.ts";
import type { GuardHook } from "./hooks/types.ts";
import { classify } from "./classifier.ts";
import { evaluate } from "./engine.ts";
import { escalateForProvenance } from "./provenance-check.ts";
import { ask } from "./verdict.ts";
import type { ToolRegistry } from "../execution/tools/registry.ts";
import type { Executor } from "../execution/executor.ts";
import type { ApprovalPort } from "./approval/types.ts";
import type { GrantStore } from "./approval/grants.ts";
import { captureBinding, verifyBinding } from "./approval/binding.ts";

export interface BoundaryDeps {
  rules: RuleSource;
  tools: ToolRegistry;
  hooks: GuardHook[];
  executor: Executor;
  /** Optional. Absent ⇒ `ask` fails closed (deny). Present ⇒ HITL flow runs. */
  approvals?: ApprovalPort;
  /** Optional. Present with `approvals` ⇒ grants can cover an `ask` without re-prompting. */
  grants?: GrantStore;
}

/**
 * The policy boundary — the single enforcement point. Implements ActionSink so the brain
 * plugs in unchanged. Flow: classify → provenance-escalate → six-stage pipeline → act.
 * On `ask`: check grants → request approval → bind (TOCTOU) → execute.
 */
export class PolicyBoundary implements ActionSink {
  readonly #deps: BoundaryDeps;
  #seq = 0;

  constructor(deps: BoundaryDeps) {
    this.#deps = deps;
  }

  async submit(proposed: ProposedAction): Promise<ToolResult> {
    const { tools, hooks } = this.#deps;
    const config = await this.#deps.rules.load();

    // 1. Classify (unknown tool ⇒ forced ask).
    const { action, unknown } = classify(proposed.action, tools);

    // 2. Pipeline verdict, then 3. provenance escalation.
    const base = unknown ? ask("classifier", `unknown tool "${action.tool}"`) : evaluate(action, config, hooks);
    const verdict = escalateForProvenance(base, action);

    // 4. Act.
    if (verdict.decision === "allow") return this.#execute(action);

    if (verdict.decision === "deny") {
      return denied(action.id, `denied [${verdict.decidedBy}]: ${verdict.reason}`);
    }

    // ask / defer → HITL.
    return this.#requestAndAct(action, verdict.decidedBy, verdict.reason);
  }

  async #requestAndAct(action: ActionContract, decidedBy: string, reason: string): Promise<ToolResult> {
    const { approvals, grants } = this.#deps;

    // Fail-closed: no approval channel ⇒ deny.
    if (!approvals) {
      return denied(action.id, `approval required [${decidedBy}]: ${reason} (HITL not wired yet)`);
    }

    // A standing grant can cover this without prompting — but NOT for execute-effect or
    // high/critical-risk actions. Those (e.g. shell/rm) must be approved fresh every time; a
    // broad grant must never silently auto-approve a destructive command.
    const grantable = action.effect !== "execute" && action.risk !== "high" && action.risk !== "critical";
    if (grants && grantable) {
      const g = grants.match(action);
      if (g) {
        grants.consume(g.id);
        return this.#execute(action);
      }
    }

    // Prompt the operator. The binding freezes the action for a post-approval drift check.
    const binding = captureBinding(action);
    let decision;
    try {
      decision = await approvals.request({
        id: `apr_${++this.#seq}`,
        action,
        binding,
        presentedRisk: action.risk,
        reason,
      });
    } catch (err) {
      return denied(action.id, `approval error (fail-closed): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!decision.approved) {
      return denied(action.id, `declined by operator${decision.reason ? `: ${decision.reason}` : ""}`);
    }

    // Don't mint a standing grant for non-grantable actions (execute / high-risk) — it would
    // never be honored anyway, and shouldn't look like it grants future destructive commands.
    if (decision.scope && grants && grantable) grants.mint(decision.scope);

    // TOCTOU: the action must not have drifted since approval.
    if (!verifyBinding(binding, action)) {
      return denied(action.id, "action changed after approval (binding mismatch)");
    }

    return this.#execute(action);
  }

  async #execute(action: ActionContract): Promise<ToolResult> {
    const tool = this.#deps.tools.get(action.tool);
    if (!tool) return denied(action.id, `unknown tool "${action.tool}"`);
    return this.#deps.executor.execute(action, tool);
  }
}

function denied(actionId: string, summary: string): ToolResult {
  return { actionId, outcome: "denied", summary };
}
