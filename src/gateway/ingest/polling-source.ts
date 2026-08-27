import type { IncomingEvent } from "../../memory/types.ts";
import type { EventSource } from "./types.ts";

export interface PollingSourceOptions {
  name: string;
  intervalMs: number;
  /** Return the events observed since the last poll. Errors are swallowed (best-effort). */
  poll: () => Promise<IncomingEvent[]>;
}

/**
 * A source that polls a function on an interval and emits whatever it returns. Each emitted event
 * is stamped with ingested provenance tagged by this source's name. The timer is unref'd so it
 * never keeps the process alive on its own.
 */
export class PollingSource implements EventSource {
  readonly name: string;
  readonly #intervalMs: number;
  readonly #poll: () => Promise<IncomingEvent[]>;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PollingSourceOptions) {
    this.name = opts.name;
    this.#intervalMs = opts.intervalMs;
    this.#poll = opts.poll;
  }

  start(emit: (event: IncomingEvent) => void): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.pollOnce(emit), this.#intervalMs);
    this.#timer.unref?.();
  }

  /** One poll pass — exposed for tests and catch-up. */
  async pollOnce(emit: (event: IncomingEvent) => void): Promise<void> {
    let events: IncomingEvent[];
    try {
      events = await this.#poll();
    } catch {
      return; // best-effort; a flaky source shouldn't crash the loop
    }
    for (const e of events) {
      emit({ ...e, provenance: { ...e.provenance, origin: "ingested", taintedBy: [...(e.provenance?.taintedBy ?? []), `source:${this.name}`] } });
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
