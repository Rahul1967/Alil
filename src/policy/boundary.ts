import type { ActionSink, ProposedAction } from "../runtime/types.ts";
import type { ActionContract, ToolResult } from "../core/types.ts";
import type { RuleSource } from "./rules.ts";
import type { GuardHook } from "./hooks/types.ts";
import { classify } from "./classifier.ts";
import { evaluate } from "./engine.ts";
import { escalateForProvenance, isTainted } from "./provenance-check.ts";
import { ask } from "./verdict.ts";
import type { ToolRegistry } from "../execution/tools/registry.ts";
import type { Executor } from "../execution/executor.ts";
import type { ApprovalPort } from "./approval/types.ts";
import type { GrantStore } from "./approval/grants.ts";
import { captureBinding, verifyBinding } from "./approval/binding.ts";

/**
 * Where the boundary records its decisions. Structurally satisfied by the gateway's AuditLedger
 * (`append`), so the ledger can be passed straight in. Absent ⇒ decisions are not logged.
 */
export interface AuditSink {
  append(evt: string, fields?: Record<string, unknown>): unknown;
}

export interface BoundaryDeps {
  rules: RuleSource;
  tools: ToolRegistry;
  hooks: GuardHook[];
  executor: Executor;
  /** Optional. Absent ⇒ `ask` fails closed (deny). Present ⇒ HITL flow runs. */
  approvals?: ApprovalPort;
  /** Optional. Present with `approvals` ⇒ grants can cover an `ask` without re-prompting. */
  grants?: GrantStore;
  /** Optional. Records every policy decision (allow/ask/deny), its source, and how it resolved. */
  audit?: AuditSink;
  /**
   * Optional workspace root. When set, approval bindings hash the target file's content so a
   * file changed between approval and execution is caught as drift (TOCTOU). Absent ⇒ file-
   * content binding is skipped; args + cwd binding still apply.
   */
  workspaceRoot?: string;
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
    if (verdict.decision === "allow") {
      this.#record(action, "allow", verdict.decidedBy, verdict.reason, "executed");
      return this.#execute(action);
    }

    if (verdict.decision === "deny") {
      this.#record(action, "deny", verdict.decidedBy, verdict.reason, "denied");
      return denied(action.id, `denied [${verdict.decidedBy}]: ${verdict.reason}`);
    }

    // ask / defer → HITL.
    return this.#requestAndAct(action, verdict.decision, verdict.decidedBy, verdict.reason);
  }

  async #requestAndAct(action: ActionContract, decision: string, decidedBy: string, reason: string): Promise<ToolResult> {
    const { approvals, grants } = this.#deps;

    // Fail-closed: no approval channel ⇒ deny.
    if (!approvals) {
      this.#record(action, decision, decidedBy, reason, "denied:no-approval-channel");
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
        this.#record(action, decision, decidedBy, reason, "grant-covered", { grantId: g.id });
        return this.#execute(action);
      }
    }

    // Prompt the operator. The binding freezes the action for a post-approval drift check.
    const binding = captureBinding(action, this.#deps.workspaceRoot);
    let approvalDecision;
    try {
      approvalDecision = await approvals.request({
        id: `apr_${++this.#seq}`,
        action,
        binding,
        presentedRisk: action.risk,
        reason,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.#record(action, decision, decidedBy, reason, "denied:approval-error", { error: detail });
      return denied(action.id, `approval error (fail-closed): ${detail}`);
    }

    if (!approvalDecision.approved) {
      this.#record(action, decision, decidedBy, reason, "declined", { by: "operator" });
      return denied(action.id, `declined by operator${approvalDecision.reason ? `: ${approvalDecision.reason}` : ""}`);
    }

    // Don't mint a standing grant for non-grantable actions (execute / high-risk) — it would
    // never be honored anyway, and shouldn't look like it grants future destructive commands.
    if (approvalDecision.scope && grants && grantable) grants.mint(approvalDecision.scope);

    // TOCTOU: the action must not have drifted since approval.
    if (!verifyBinding(binding, action, this.#deps.workspaceRoot)) {
      this.#record(action, decision, decidedBy, reason, "denied:binding-mismatch");
      return denied(action.id, "action changed after approval (binding mismatch)");
    }

    this.#record(action, decision, decidedBy, reason, "approved", {
      ...(approvalDecision.scope && grants && grantable ? { grantMinted: true } : {}),
    });
    return this.#execute(action);
  }

  /** Emit one audit record for a policy decision and how it resolved. Never logs raw secrets:
   * args are truncated to a bounded preview (credential-shaped args are denied before here). */
  #record(action: ActionContract, decision: string, decidedBy: string, reason: string, resolution: string, extra: Record<string, unknown> = {}): void {
    const audit = this.#deps.audit;
    if (!audit) return;
    audit.append("policy", {
      tool: action.tool,
      effect: action.effect,
      risk: action.risk,
      decision,
      decidedBy,
      reason,
      resolution,
      tainted: isTainted(action),
      ...(action.provenance.taintedBy?.length ? { taintedBy: action.provenance.taintedBy } : {}),
      argsPreview: JSON.stringify(action.args).slice(0, 200),
      actionId: action.id,
      ...extra,
    });
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
