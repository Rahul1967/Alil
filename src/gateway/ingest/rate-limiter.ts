/**
 * Sliding-window rate limiter. Bounds how often ambient triggers may wake the assistant, so a
 * chatty webhook can't DoS the operator with a flood of unprompted turns (and approvals).
 * `allow()` records a hit when it returns true.
 */
export class RateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #hits: number[] = [];

  constructor(maxPerWindow: number, windowMs: number, now: () => number = () => Date.now()) {
    this.#max = maxPerWindow;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  allow(): boolean {
    const now = this.#now();
    const cutoff = now - this.#windowMs;
    this.#hits = this.#hits.filter((t) => t > cutoff);
    if (this.#hits.length >= this.#max) return false;
    this.#hits.push(now);
    return true;
  }
}
