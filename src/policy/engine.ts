import type { ActionContract } from "../core/types.ts";
import type { PolicyConfig, PermissionMode } from "./rules.ts";
import { ruleApplies } from "./rules.ts";
import type { GuardHook } from "./hooks/types.ts";
import type { Verdict, Decision } from "./verdict.ts";
import { allow, ask, deny } from "./verdict.ts";

/**
 * The six-stage permission pipeline, in fixed order:
 *   hooks → deny rules → ask rules → mode → allow rules → (human)
 * with `deny > defer > ask > allow` precedence. Anything unmatched falls through to `ask`
 * (human) — never a silent allow.
 */
export function evaluate(
  action: ActionContract,
  config: PolicyConfig,
  hooks: GuardHook[],
): Verdict {
  // 1. Guard hooks (a returned verdict short-circuits; deny here is final).
  for (const hook of hooks) {
    const v = hook.check(action);
    if (v) return v;
  }

  // 2. Deny rules.
  const denyRule = config.rules.find((r) => r.kind === "deny" && ruleApplies(r, action));
  if (denyRule) return deny("deny-rule", denyRule.note);

  // 4/5. Ask and allow rule matches (evaluated together for precedence below).
  const askRule = config.rules.find((r) => r.kind === "ask" && ruleApplies(r, action));
  const allowRule = config.rules.find((r) => r.kind === "allow" && ruleApplies(r, action));

  // 3. Mode posture for this effect.
  const modeDecision = fromMode(config.mode, action);
  if (modeDecision === "deny") return deny("mode", `mode "${config.mode}" blocks ${action.effect}`);

  // Precedence: ask (rule or mode) beats allow; allow beats nothing.
  if (askRule) return ask("ask-rule", askRule.note);
  if (modeDecision === "ask" && !allowRule) return ask("mode", `mode "${config.mode}" asks on ${action.effect}`);
  if (allowRule) return allow("allow-rule", allowRule.note);
  if (modeDecision === "allow") return allow("mode", `mode "${config.mode}" allows ${action.effect}`);

  // 6. Unmatched → defer to a human.
  return ask("fallthrough", "no rule matched; defer to human");
}

/** The default posture a permission mode gives an action's effect. */
function fromMode(mode: PermissionMode, action: ActionContract): Decision {
  const e = action.effect;
  switch (mode) {
    case "auto":
      return "allow"; // sandboxed environments — allow all
    case "plan":
      return e === "read" ? "allow" : "deny"; // no side effects
    case "trusted":
      return e === "read" ? "allow" : "ask"; // allowlist (allow rules) can override to allow
    case "default":
    default:
      return e === "read" ? "allow" : "ask"; // ask on write/execute/network/spend
  }
}
