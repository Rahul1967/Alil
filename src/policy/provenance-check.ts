import type { ActionContract } from "../core/types.ts";
import type { Verdict } from "./verdict.ts";

/**
 * Context-manipulation defense: if an action was influenced by untrusted/ingested content, raise
 * the bar. The policy engine can't see intent, so tainted provenance forces the decision toward a
 * human — but the mitigation is HUMAN JUDGMENT, not a blanket block. A hard `deny` removes the
 * operator from the loop, which is wrong for the common, benign case (read one web page, then run a
 * follow-up search). So:
 *
 *   • allow  → ask            (tainted actions never auto-execute; a human must see them)
 *   • ask    → ask            (already gated on the human; keep it there — low/medium risk)
 *   • ask    → deny  ONLY when the tainted action is HIGH/CRITICAL risk (genuinely dangerous:
 *                              a tainted delete/payment/destructive op is hard-blocked, not
 *                              offered for reflexive approval)
 *   • deny/defer → unchanged
 *
 * This preserves the injection defense (nothing tainted runs without the operator explicitly
 * approving it, and the prompt says WHY it was escalated) while not making legitimate multi-step
 * web research impossible.
 */
export function isTainted(action: ActionContract): boolean {
  const p = action.provenance;
  return p.origin === "ingested" || (p.taintedBy?.length ?? 0) > 0;
}

export function escalateForProvenance(verdict: Verdict, action: ActionContract): Verdict {
  if (!isTainted(action)) return verdict;
  const note = (base: string) => `${base} (escalated: tainted provenance)`;

  if (verdict.decision === "allow") {
    return { decision: "ask", reason: note(verdict.reason), decidedBy: "provenance" };
  }
  if (verdict.decision === "ask") {
    // Only a dangerous tainted action is hard-denied; otherwise it stays a human decision.
    const dangerous = action.risk === "high" || action.risk === "critical";
    if (dangerous) {
      return { decision: "deny", reason: note(verdict.reason), decidedBy: "provenance" };
    }
    return { decision: "ask", reason: note(verdict.reason), decidedBy: "provenance" };
  }
  return verdict; // deny/defer unchanged
}
