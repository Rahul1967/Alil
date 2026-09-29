export type Decision = "allow" | "ask" | "defer" | "deny";

export interface Verdict {
  decision: Decision;
  reason: string;
  decidedBy: string; // e.g. "deny-rule", "hook:credential-block", "mode", "provenance"
  /** Set on an `ask` from a `fresh` rule: a standing grant must not cover it. */
  fresh?: boolean;
}

const RANK: Record<Decision, number> = { allow: 0, ask: 1, defer: 2, deny: 3 };

/** Returns the stricter of two verdicts (deny > defer > ask > allow). */
export function strictest(a: Verdict, b: Verdict): Verdict {
  return RANK[b.decision] > RANK[a.decision] ? b : a;
}

export const allow = (decidedBy: string, reason = ""): Verdict => ({ decision: "allow", reason, decidedBy });
export const ask = (decidedBy: string, reason = ""): Verdict => ({ decision: "ask", reason, decidedBy });
export const deny = (decidedBy: string, reason = ""): Verdict => ({ decision: "deny", reason, decidedBy });
