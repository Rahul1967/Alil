import type { ActionContract } from "../../core/types.ts";
import type { Clock } from "../../runtime/types.ts";
import { systemClock } from "../../runtime/types.ts";
import { globMatch } from "../glob.ts";
import type { Grant, GrantScope } from "./types.ts";

/**
 * Holds standing grants minted when the operator chooses to grant (not just allow once).
 * Grants are scoped, use-limited, and expiring — a single one-time grant never becomes
 * open-ended authority (BEST_PRACTICES §7). Clock is injected for deterministic tests.
 */
export class GrantStore {
  readonly #clock: Clock;
  readonly #grants: Grant[] = [];
  #seq = 0;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  /** An active grant covering this action, or undefined. Does not consume. */
  match(action: ActionContract): Grant | undefined {
    const now = this.#clock.now();
    return this.#grants.find((g) => {
      if (g.scope.tool !== action.tool) return false;
      if (g.expiresAt <= now) return false;
      if (g.usesRemaining <= 0) return false;
      if (g.scope.pathGlob !== undefined) {
        const path = action.args["path"];
        if (typeof path !== "string" || !globMatch(g.scope.pathGlob, path)) return false;
      }
      return true;
    });
  }

  mint(scope: GrantScope): Grant {
    const now = this.#clock.now();
    const grant: Grant = {
      id: `grant_${++this.#seq}`,
      scope,
      expiresAt: now + scope.ttlMs,
      usesRemaining: scope.maxUses,
      approvedAt: now,
    };
    this.#grants.push(grant);
    return grant;
  }

  /** Decrement a grant's remaining uses (called when a grant covers an action). */
  consume(id: string): void {
    const g = this.#grants.find((x) => x.id === id);
    if (g) g.usesRemaining -= 1;
  }

  /** Active (unexpired, uses-remaining) grants — for a GRANTS.md projection later. */
  active(): Grant[] {
    const now = this.#clock.now();
    return this.#grants.filter((g) => g.expiresAt > now && g.usesRemaining > 0);
  }
}
