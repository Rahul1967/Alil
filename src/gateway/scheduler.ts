/**
 * Scheduler — the firing mechanism for prospective memory (MEMORY.md §7b).
 *
 * The model only ever CREATES intentions; this owns the clock and the wake. A poll loop drains
 * time-triggered intentions that are due (catch-up drains any missed while the process was
 * down, since "due" is just fire_at ≤ now), and `fireEvent()` drains event-triggered ones when
 * a channel delivers an event. Each fire is a claim→deliver→settle handshake so a crash can't
 * double-fire. `deliver` is channel-supplied: it runs the intention's action as a normal turn,
 * so the policy boundary re-checks permissions at FIRE time (state may have changed since it
 * was scheduled).
 */
import { Cron } from "croner";
import type { ProspectiveStore } from "../memory/prospective.ts";
import type { Intention, IncomingEvent } from "../memory/types.ts";

export interface SchedulerDeps {
  store: ProspectiveStore;
  /** Runs the intention as a turn. `event` is set for event-triggered fires (carries taint). */
  deliver: (intention: Intention, event?: IncomingEvent) => Promise<void>;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Compute the next cron run after `after` (epoch ms), or null if none. */
  cronNext?: (expr: string, after: number) => number | null;
  /** Poll cadence (default 30s). */
  intervalMs?: number;
  /** A 'firing' row older than this is presumed crashed and reclaimed (default 5 min). */
  staleMs?: number;
}

function defaultCronNext(expr: string, after: number): number | null {
  try {
    return new Cron(expr).nextRun(new Date(after))?.getTime() ?? null;
  } catch {
    return null; // bad expression → treat as non-recurring
  }
}

export class Scheduler {
  readonly #store: ProspectiveStore;
  readonly #deliver: SchedulerDeps["deliver"];
  readonly #now: () => number;
  readonly #cronNext: (expr: string, after: number) => number | null;
  readonly #intervalMs: number;
  readonly #staleMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;

  constructor(deps: SchedulerDeps) {
    this.#store = deps.store;
    this.#deliver = deps.deliver;
    this.#now = deps.now ?? (() => Date.now());
    this.#cronNext = deps.cronNext ?? defaultCronNext;
    this.#intervalMs = deps.intervalMs ?? 30_000;
    this.#staleMs = deps.staleMs ?? 5 * 60_000;
  }

  /** Begin polling. Runs one immediate tick so anything already due (catch-up) fires at once. */
  start(): void {
    if (this.#timer) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    this.#timer.unref?.(); // don't keep the process alive just for the poll
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One pass: expire overdue, reclaim crashed fires, then fire everything due. */
  async tick(): Promise<void> {
    if (this.#ticking) return; // never overlap ticks
    this.#ticking = true;
    try {
      const now = this.#now();
      this.#store.expireOverdue(now);
      this.#store.recoverStale(now - this.#staleMs);
      for (const intention of this.#store.due(now)) {
        await this.#fire(intention);
      }
    } finally {
      this.#ticking = false;
    }
  }

  /** Evaluate pending event intentions against an incoming channel event and fire matches. */
  async fireEvent(event: IncomingEvent): Promise<void> {
    const now = this.#now();
    for (const intention of this.#store.matchEvent(event, now)) {
      await this.#fire(intention, event);
    }
  }

  async #fire(intention: Intention, event?: IncomingEvent): Promise<void> {
    const now = this.#now();
    if (!this.#store.claim(intention.id, now)) return; // lost the race / already handled
    try {
      await this.#deliver(intention, event);
    } catch {
      // Delivery failed: leave the row 'firing'; recoverStale re-arms it on a later tick.
      return;
    }
    // Settle: re-arm a recurring cron intention, else it's a one-shot.
    if (intention.trigger === "cron" && intention.cronExpr) {
      const next = this.#cronNext(intention.cronExpr, this.#now());
      if (next !== null && (intention.expiresAt === null || next <= intention.expiresAt)) {
        this.#store.reschedule(intention.id, next);
        return;
      }
    }
    this.#store.markDone(intention.id);
  }
}
