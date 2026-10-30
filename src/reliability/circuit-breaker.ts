/**
 * A three-state circuit breaker (closed → open → half-open), reusable for any remote dependency.
 *
 * - closed: calls go through; `threshold` consecutive failures open it.
 * - open: calls are refused until `resetMs` has passed.
 * - half-open: exactly ONE probe is let through. Its failure re-opens at once (no fresh run of
 *   failures needed); its success closes and resets. Other callers are refused while it runs.
 *
 * The caller reports the outcome of each acquired call with `success()` / `failure()`, or
 * `release()` when it ended without a verdict on the dependency (e.g. a local validation error),
 * so a probe can never wedge the breaker half-open. Count logical calls, not retry attempts: a
 * call that fails all its retries is one failure.
 */
export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitTransition {
  from: CircuitState;
  to: CircuitState;
  /** Consecutive failures when the transition happened. */
  failures: number;
  at: number;
}

export interface CircuitBreakerOptions {
  threshold: number;
  resetMs: number;
  now?: () => number;
  onTransition?: (t: CircuitTransition) => void;
}

export class CircuitBreaker {
  readonly #threshold: number;
  readonly #resetMs: number;
  readonly #now: () => number;
  readonly #onTransition: ((t: CircuitTransition) => void) | undefined;
  #state: CircuitState = "closed";
  #failures = 0;
  #openedAt = 0;
  #probeInFlight = false;

  constructor(opts: CircuitBreakerOptions) {
    this.#threshold = Math.max(1, opts.threshold);
    this.#resetMs = opts.resetMs;
    this.#now = opts.now ?? (() => Date.now());
    this.#onTransition = opts.onTransition;
  }

  get state(): CircuitState {
    return this.#state;
  }

  get failures(): number {
    return this.#failures;
  }

  /** Would a call be refused right now? Pure — never consumes the half-open probe. */
  get refusing(): boolean {
    if (this.#state === "closed") return false;
    if (this.#state === "half_open") return this.#probeInFlight;
    return this.#now() - this.#openedAt < this.#resetMs;
  }

  /** Ask to make a call. True ⇒ go ahead and report its outcome; false ⇒ fail fast. */
  tryAcquire(): boolean {
    if (this.#state === "closed") return true;
    if (this.#state === "open") {
      if (this.#now() - this.#openedAt < this.#resetMs) return false;
      this.#move("half_open");
    }
    if (this.#probeInFlight) return false;
    this.#probeInFlight = true;
    return true;
  }

  success(): void {
    this.#probeInFlight = false;
    this.#failures = 0;
    if (this.#state !== "closed") this.#move("closed");
  }

  failure(): void {
    this.#probeInFlight = false;
    this.#failures += 1;
    if (this.#state === "half_open" || (this.#state === "closed" && this.#failures >= this.#threshold)) {
      this.#openedAt = this.#now();
      this.#move("open");
    }
  }

  /** End an acquired call with no verdict on the dependency (frees a half-open probe slot). */
  release(): void {
    this.#probeInFlight = false;
  }

  #move(to: CircuitState): void {
    const from = this.#state;
    this.#state = to;
    this.#onTransition?.({ from, to, failures: this.#failures, at: this.#now() });
  }
}
