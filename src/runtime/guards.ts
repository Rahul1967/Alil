import type { GuardLimits, Clock } from "./types.ts";
import { systemClock } from "./types.ts";
import type { ModelSpec, ModelUsage } from "../providers/types.ts";
import { costOf } from "../providers/types.ts";
import type { TurnUsage } from "./types.ts";
import type { ToolResult } from "../core/types.ts";

export interface GuardCheck {
  halt: boolean;
  reason?: string;
}

/**
 * Loop guards (BEST_PRACTICES §1 fail-safe): iteration cap, wall-clock timeout,
 * cumulative token + cost ceilings, stall detection on repeated tool signatures, and
 * an error budget on consecutive no-progress rounds. Any trip is a clean halt, never a
 * crash. Fail-safe: check BEFORE each model call.
 */
export class Guards {
  readonly #limits: GuardLimits;
  readonly #clock: Clock;
  #startedAt: number;

  #iterations = 0;
  #tokens = 0;
  #costUsd = 0;
  readonly #usage: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelCalls: 0 };
  #failingRounds = 0;
  readonly #recentSignatures: string[] = [];

  constructor(limits: GuardLimits, clock: Clock = systemClock) {
    this.#limits = limits;
    this.#clock = clock;
    this.#startedAt = clock.now();
  }

  get iterations(): number {
    return this.#iterations;
  }

  /** Running totals for the turn — tokens by kind, cost, number of model calls recorded. */
  get usage(): TurnUsage {
    return { ...this.#usage };
  }

  /** Call once at the top of each loop iteration. Increments the iteration counter. */
  check(): GuardCheck {
    this.#iterations += 1;

    if (this.#iterations > this.#limits.maxIterations) {
      return { halt: true, reason: `iteration cap (${this.#limits.maxIterations})` };
    }
    const elapsed = this.#clock.now() - this.#startedAt;
    if (elapsed > this.#limits.maxWallClockMs) {
      return { halt: true, reason: `timeout (${this.#limits.maxWallClockMs}ms)` };
    }
    if (this.#tokens > this.#limits.maxTokens) {
      return { halt: true, reason: `token budget (${this.#limits.maxTokens})` };
    }
    if (this.#costUsd > this.#limits.maxCostUsd) {
      return { halt: true, reason: `cost budget ($${this.#limits.maxCostUsd})` };
    }
    if (this.#isStalled()) {
      return { halt: true, reason: `stall (${this.#limits.stallWindow} identical calls)` };
    }
    if (
      this.#limits.maxConsecutiveFailures > 0 &&
      this.#failingRounds >= this.#limits.maxConsecutiveFailures
    ) {
      return {
        halt: true,
        reason: `error budget (${this.#limits.maxConsecutiveFailures} rounds without progress)`,
      };
    }
    return { halt: false };
  }

  /** Exclude time spent waiting on the operator (an approval prompt) from the wall-clock budget. */
  excludeWait(ms: number): void {
    if (ms > 0) this.#startedAt += ms;
  }

  /** Record usage after a model call so token/cost guards can trip next iteration. */
  recordUsage(usage: ModelUsage, spec: ModelSpec): void {
    // Cache reads count toward the token budget too: they still occupy the context window.
    const cache = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    this.#tokens += usage.inputTokens + usage.outputTokens + cache;
    const cost = costOf(usage, spec.pricing);
    this.#costUsd += cost;
    const u = this.#usage;
    u.inputTokens += usage.inputTokens;
    u.outputTokens += usage.outputTokens;
    u.cacheReadTokens += usage.cacheReadTokens ?? 0;
    u.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    u.costUsd += cost;
    u.modelCalls += 1;
  }

  /**
   * Record the outcomes of a tool round so the error budget can trip next iteration.
   * A round that produced at least one `ok` counts as progress and resets the budget;
   * a round where every result failed (error/denied) advances it. This catches a model
   * that keeps failing against a goal with *varied* calls — which the identical-signature
   * stall detector would miss. Empty rounds (no tools run) are ignored.
   */
  recordResults(results: ToolResult[]): void {
    if (results.length === 0) return;
    const madeProgress = results.some((r) => r.outcome === "ok");
    this.#failingRounds = madeProgress ? 0 : this.#failingRounds + 1;
  }

  /** Record the tool signatures proposed this iteration, for stall detection. */
  recordToolSignatures(signatures: string[]): void {
    // Use a joined signature of the whole batch so repeated identical batches count.
    this.#recentSignatures.push(signatures.slice().sort().join("|"));
    const cap = this.#limits.stallWindow;
    while (this.#recentSignatures.length > cap) this.#recentSignatures.shift();
  }

  #isStalled(): boolean {
    const w = this.#limits.stallWindow;
    if (w <= 0) return false;
    if (this.#recentSignatures.length < w) return false;
    const last = this.#recentSignatures[this.#recentSignatures.length - 1];
    if (last === undefined || last === "") return false; // no-tool turns never stall
    return this.#recentSignatures.slice(-w).every((s) => s === last);
  }
}
