/**
 * AuditLedger — the append-only decision/write log (DESIGN.md §02 gateway, PLAN.md §3).
 *
 * Every behavior-changing event (a distilled episode, a pinned canonical fact, a completed
 * turn) is recorded as one JSONL line with a monotonic seq. It is the forensic source of
 * truth: because memory writes change FUTURE behavior, they must be auditable after the
 * fact — this is what makes the "context manipulation" threat traceable rather than silent.
 *
 * Append-only and single-writer (the gateway serializes turns), so ordering is stable.
 * seq survives restarts (resumed from the last line on open).
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEvent {
  seq: number;
  at: string; // ISO
  evt: string; // "turn" | "memory.write" | "canonical.pin" | ...
  [field: string]: unknown;
}

export class AuditLedger {
  readonly #path: string;
  #seq: number;

  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.#seq = existsSync(path) ? lastSeq(path) : 0;
  }

  /** Append one event; assigns seq + timestamp, writes a JSONL line, returns the record. */
  append(evt: string, fields: Record<string, unknown> = {}): AuditEvent {
    const record: AuditEvent = { seq: ++this.#seq, at: new Date().toISOString(), evt, ...fields };
    appendFileSync(this.#path, JSON.stringify(record) + "\n");
    return record;
  }

  /** The last n events (chronological). Empty if the ledger doesn't exist yet. */
  tail(n: number): AuditEvent[] {
    if (!existsSync(this.#path)) return [];
    const lines = readFileSync(this.#path, "utf8").split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => JSON.parse(l) as AuditEvent);
  }

  /** Highest seq written so far. */
  get seq(): number {
    return this.#seq;
  }
}

function lastSeq(path: string): number {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const last = lines.at(-1);
  if (!last) return 0;
  try {
    return (JSON.parse(last) as { seq: number }).seq;
  } catch {
    return lines.length;
  }
}
