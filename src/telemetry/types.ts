/**
 * Telemetry event schema. Every record shares one envelope, versioned so a reader can skip lines
 * from a newer writer instead of misreading them. Bump the version only for incompatible changes;
 * adding a field to a kind is compatible.
 *
 * Telemetry records *how things went* (timings, sizes, outcomes). It is not the audit ledger, which
 * records *what was decided* and is hash-chained — telemetry is never written there.
 */
export const TELEMETRY_SCHEMA_VERSION = 1;

/** Known kinds. Readers must tolerate unknown kinds (forward compatibility). */
export type TelemetryKind =
  | "process.start"
  | "turn.start"
  | "turn.end"
  | "model.call"
  | "tool.call"
  | "mcp.call"
  | "mcp.connect"
  | "mcp.circuit"
  | "mcp.tools_changed"
  | "recall"
  | "episode.distill"
  | "audit"
  | "error"
  | "heartbeat"
  | "alert";

export interface TelemetryEnvelope {
  v: typeof TELEMETRY_SCHEMA_VERSION;
  /** ISO timestamp of emission. */
  ts: string;
  kind: TelemetryKind | (string & {});
  /** Logical process name (the channel that owns this process: telegram, browser, terminal). */
  process: string;
  pid: number;
  /** Present when emitted inside a turn (from the turn context). */
  turnId?: string;
  channel?: string;
  episodeId?: string;
}

export type TelemetryEvent = TelemetryEnvelope & Record<string, unknown>;

/** Where events go. Implementations may throw; the Telemetry front never lets that escape. */
export interface TelemetrySink {
  write(e: TelemetryEvent): void;
  close?(): void;
}
