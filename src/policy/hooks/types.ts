import type { ActionContract } from "../../core/types.ts";
import type { Verdict } from "../verdict.ts";

/**
 * A guard hook runs on EVERY action before rule evaluation. It returns a Verdict to
 * short-circuit (a `deny` here is final and cannot be loosened by config or mode) or null
 * to abstain. Hooks are code-enforced guardrails, not declarative rules.
 */
export interface GuardHook {
  readonly name: string;
  check(action: ActionContract): Verdict | null;
}
