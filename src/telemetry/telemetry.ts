import { TELEMETRY_SCHEMA_VERSION } from "./types.ts";
import type { TelemetryEvent, TelemetrySink, TelemetryKind } from "./types.ts";
import { currentTurn } from "./context.ts";
import { NullSink } from "./sinks.ts";

export interface TelemetryOptions {
  sink: TelemetrySink;
  /** Logical process name recorded on every event. */
  process: string;
  /** Capture content (message text, tool args, error bodies) — off by default. */
  content?: boolean;
  now?: () => Date;
  /** Called for every event after it is written (e.g. an invariant monitor). Never throws out. */
  onEvent?: (e: TelemetryEvent) => void;
}

/**
 * The emitter. Components call `emit(kind, fields, content?)`; the envelope and the current turn's
 * ids are added here. `fields` must be small and content-free (sizes, enums, durations, names);
 * anything that may carry user data goes in `content`, which is dropped unless enabled.
 *
 * Emitting never throws and never blocks on the network: a failing sink increments `dropped`.
 */
export class Telemetry {
  readonly process: string;
  readonly content: boolean;
  readonly #sink: TelemetrySink;
  readonly #now: () => Date;
  readonly #listeners: Array<(e: TelemetryEvent) => void> = [];
  #dropped = 0;

  constructor(opts: TelemetryOptions) {
    this.#sink = opts.sink;
    this.process = opts.process;
    this.content = opts.content === true;
    this.#now = opts.now ?? (() => new Date());
    if (opts.onEvent) this.#listeners.push(opts.onEvent);
  }

  /** A telemetry that records nothing. */
  static noop(process = "noop"): Telemetry {
    return new Telemetry({ sink: new NullSink(), process });
  }

  get dropped(): number {
    return this.#dropped;
  }

  /** Subscribe to every emitted event (in-process). Returns an unsubscribe function. */
  subscribe(fn: (e: TelemetryEvent) => void): () => void {
    this.#listeners.push(fn);
    return () => {
      const i = this.#listeners.indexOf(fn);
      if (i >= 0) this.#listeners.splice(i, 1);
    };
  }

  emit(kind: TelemetryKind | (string & {}), fields: Record<string, unknown> = {}, content?: Record<string, unknown>): void {
    const turn = currentTurn();
    const e: TelemetryEvent = {
      v: TELEMETRY_SCHEMA_VERSION,
      ts: this.#now().toISOString(),
      kind,
      process: this.process,
      pid: process.pid,
      ...(turn ? { turnId: turn.turnId, ...(turn.channel ? { channel: turn.channel } : {}), ...(turn.episodeId ? { episodeId: turn.episodeId } : {}) } : {}),
      ...fields,
      ...(this.content && content ? content : {}),
    };
    try {
      this.#sink.write(e);
    } catch {
      this.#dropped++;
    }
    for (const fn of this.#listeners) {
      try { fn(e); } catch { /* a listener must not break emission */ }
    }
  }

  /** Record a failure that is handled (swallowed) where it happens, so it is never silent. */
  error(where: string, err: unknown, fields: Record<string, unknown> = {}): void {
    const name = (err as { name?: string })?.name;
    const message = err instanceof Error ? err.message : String(err);
    this.emit("error", { where, ...(name ? { errorName: name } : {}), message: message.slice(0, 300), ...fields });
  }

  close(): void {
    try { this.#sink.close?.(); } catch { /* best effort */ }
  }
}

// ── process-wide default ───────────────────────────────────────────────────
// Components deep in the stack (scheduler, episode sweep, MCP search) report swallowed errors here
// rather than threading a Telemetry through every constructor. The app core installs the real one.
let global: Telemetry = Telemetry.noop();

export function installTelemetry(t: Telemetry): void {
  global = t;
}

export function telemetry(): Telemetry {
  return global;
}

/** Shorthand for `telemetry().error(...)` — use in every catch that would otherwise be silent. */
export function reportError(where: string, err: unknown, fields?: Record<string, unknown>): void {
  global.error(where, err, fields);
}
