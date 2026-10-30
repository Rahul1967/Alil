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

export interface ProvenanceOptions {
  /**
   * True when a taint source is a file the OPERATOR uploaded (verified by the caller: placed by
   * the ingestion store, recorded on an operator's message, content unchanged). A high-risk action
   * tainted only by such files is asked instead of denied — the operator chose to hand Alil that
   * file, and sees the exact command before it runs. Absent ⇒ no source is treated this way.
   */
  operatorUpload?: (source: string) => boolean;
}

export function escalateForProvenance(verdict: Verdict, action: ActionContract, opts: ProvenanceOptions = {}): Verdict {
  if (!isTainted(action)) return verdict;
  const note = (base: string) => `${base} (escalated: tainted provenance)`;

  if (verdict.decision === "allow") {
    return { decision: "ask", reason: note(verdict.reason), decidedBy: "provenance" };
  }
  if (verdict.decision === "ask") {
    // Only a dangerous tainted action is hard-denied; otherwise it stays a human decision.
    const dangerous = action.risk === "high" || action.risk === "critical";
    const uploads = onlyOperatorUploads(action, opts.operatorUpload);
    if (dangerous && action.risk === "high" && uploads) {
      // The one exception: every source is a file the operator sent. Ask fresh (no standing grant
      // may cover it) and say which file, so the operator judges the command against it.
      return {
        decision: "ask", decidedBy: "provenance", fresh: true,
        reason: `${verdict.reason} (after reading your uploaded file${uploads.length > 1 ? "s" : ""} ${uploads.map(baseName).join(", ")} — check the command before approving)`,
      };
    }
    if (dangerous) {
      return { decision: "deny", reason: note(verdict.reason), decidedBy: "provenance" };
    }
    return { decision: "ask", reason: note(verdict.reason), decidedBy: "provenance", ...(verdict.fresh ? { fresh: true } : {}) };
  }
  return verdict; // deny/defer unchanged
}

/** The taint sources if every one is an operator upload, else null. An ingested ORIGIN (the action
 * itself came from untrusted input, e.g. an ambient wake) never qualifies. */
function onlyOperatorUploads(action: ActionContract, isUpload?: (s: string) => boolean): string[] | null {
  if (!isUpload || action.provenance.origin === "ingested") return null;
  const sources = action.provenance.taintedBy ?? [];
  if (sources.length === 0) return null;
  for (const s of sources) {
    let ok = false;
    try { ok = isUpload(s); } catch { ok = false; }
    if (!ok) return null;
  }
  return sources;
}

function baseName(p: string): string {
  return p.split("/").pop() ?? p;
}
