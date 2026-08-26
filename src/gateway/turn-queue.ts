/**
 * TurnQueue — the gateway serializer (MEMORY.md §7 Phase 6, MEMORY.md §5).
 *
 * One mind, one timeline: two turns can't run coherently at once, so every inbound turn
 * (from any channel) funnels through here and executes strictly one at a time. This is what
 * keeps timeline appends totally ordered by seq across concurrent channels.
 *
 * Default is FIFO queueing. A turn submitted with { preempt: true } cancels the in-flight
 * turn via its AbortSignal and jumps to the front — the "STOP, urgent" path. The preempted
 * turn's runner observes the signal and settles normally (e.g. the brain returns an
 * "aborted" turn), so its result is never lost — it can still be recorded for audit.
 */
interface QueueItem {
  run: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  label: string;
}

export interface SubmitOptions {
  /** Cancel the in-flight turn and run this one next. */
  preempt?: boolean;
  /** Label for observability. */
  label?: string;
}

export class TurnQueue {
  #pending: QueueItem[] = [];
  #current: AbortController | null = null;
  #draining = false;

  /** Number of turns waiting behind the running one. */
  get depth(): number {
    return this.#pending.length;
  }

  /** Whether a turn is currently executing. */
  get busy(): boolean {
    return this.#current !== null;
  }

  /**
   * Submit a turn. Resolves with the runner's result once it executes (respecting
   * one-at-a-time ordering). `run` receives an AbortSignal it must honor for preemption.
   */
  submit<O>(run: (signal: AbortSignal) => Promise<O>, opts: SubmitOptions = {}): Promise<O> {
    return new Promise<O>((resolve, reject) => {
      const item: QueueItem = {
        run: run as (signal: AbortSignal) => Promise<unknown>,
        resolve: (value) => resolve(value as O),
        reject,
        label: opts.label ?? "turn",
      };
      if (opts.preempt && this.#current) {
        this.#pending.unshift(item); // jump the queue
        this.#current.abort(); // cancel the in-flight turn
      } else {
        this.#pending.push(item);
      }
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#pending.length > 0) {
        const item = this.#pending.shift()!;
        const controller = new AbortController();
        this.#current = controller;
        try {
          item.resolve(await item.run(controller.signal));
        } catch (err) {
          item.reject(err);
        } finally {
          this.#current = null;
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}
