import type { ActionContract } from "../core/types.ts";
import type { Verdict } from "./verdict.ts";

/**
 * Context-manipulation defense: if an action was influenced by untrusted/ingested content,
 * escalate its verdict one tier (allow→ask, ask→deny). The policy engine can't see intent;
 * this raises the bar whenever tainted provenance is present.
 */
export function isTainted(action: ActionContract): boolean {
  const p = action.provenance;
  return p.origin === "ingested" || (p.taintedBy?.length ?? 0) > 0;
}

export function escalateForProvenance(verdict: Verdict, action: ActionContract): Verdict {
  if (!isTainted(action)) return verdict;
  if (verdict.decision === "allow") {
    return { decision: "ask", reason: `${verdict.reason} (escalated: tainted provenance)`, decidedBy: "provenance" };
  }
  if (verdict.decision === "ask") {
    return { decision: "deny", reason: `${verdict.reason} (escalated: tainted provenance)`, decidedBy: "provenance" };
  }
  return verdict; // deny/defer unchanged
}
