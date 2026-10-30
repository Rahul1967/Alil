import { appendFileSync, mkdirSync, renameSync, statSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { TelemetryEvent, TelemetrySink } from "./types.ts";

/** Keeps events in memory — for tests and for an in-process view. */
export class MemorySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  readonly #max: number;
  constructor(max = 10_000) {
    this.#max = max;
  }
  write(e: TelemetryEvent): void {
    this.events.push(e);
    if (this.events.length > this.#max) this.events.shift();
  }
}

export class NullSink implements TelemetrySink {
  write(): void {}
}

/** Writes to several sinks; one failing sink never starves the others. */
export class FanoutSink implements TelemetrySink {
  readonly #sinks: TelemetrySink[];
  constructor(sinks: TelemetrySink[]) {
    this.#sinks = sinks;
  }
  write(e: TelemetryEvent): void {
    let failure: unknown;
    for (const s of this.#sinks) {
      try { s.write(e); } catch (err) { failure ??= err; }
    }
    if (failure) throw failure; // surfaced to Telemetry's drop counter
  }
  close(): void {
    for (const s of this.#sinks) { try { s.close?.(); } catch { /* best effort */ } }
  }
}

export interface JsonlFileSinkOptions {
  /** Rotate when the file would pass this size. Default 20 MB. */
  maxBytes?: number;
  /** Rotated files kept (`.1` newest … `.keep` oldest). Default 5. */
  keep?: number;
}

/**
 * Appends one JSON object per line. One file per process (the caller puts process name + pid in
 * the path), so two processes never interleave writes and no lock is needed. Each event is a
 * single appendFileSync — a crash can at worst leave one torn final line, which readers skip.
 */
export class JsonlFileSink implements TelemetrySink {
  readonly path: string;
  readonly #maxBytes: number;
  readonly #keep: number;
  #bytes: number;

  constructor(path: string, opts: JsonlFileSinkOptions = {}) {
    this.path = path;
    this.#maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
    this.#keep = Math.max(1, opts.keep ?? 5);
    mkdirSync(dirname(path), { recursive: true });
    this.#bytes = existsSync(path) ? statSync(path).size : 0;
  }

  write(e: TelemetryEvent): void {
    const line = JSON.stringify(e) + "\n";
    const size = Buffer.byteLength(line);
    if (this.#bytes > 0 && this.#bytes + size > this.#maxBytes) this.#rotate();
    appendFileSync(this.path, line);
    this.#bytes += size;
  }

  #rotate(): void {
    const oldest = `${this.path}.${this.#keep}`;
    if (existsSync(oldest)) rmSync(oldest);
    for (let i = this.#keep - 1; i >= 1; i--) {
      const from = `${this.path}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.path}.${i + 1}`);
    }
    renameSync(this.path, `${this.path}.1`);
    this.#bytes = 0;
  }
}
