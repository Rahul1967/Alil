/**
 * AuditLedger — the append-only decision/write log (DESIGN.md §02 gateway, PLAN.md §3).
 *
 * Every behavior-changing event (a distilled episode, a pinned canonical fact, a completed
 * turn) is recorded as one JSONL line with a monotonic seq. It is the forensic source of
 * truth: because memory writes change FUTURE behavior, they must be auditable after the
 * fact — this is what makes the "context manipulation" threat traceable rather than silent.
 *
 * Tamper-evident: each record carries `prevHash` (SHA-256 of the previous record's canonical
 * form) forming a hash chain. Truncating, reordering, or rewriting any line breaks the chain
 * from that point on, which `verify()` detects. Append-only and single-writer (the gateway
 * serializes turns), so ordering is stable. seq + the chain head survive restarts.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export interface AuditEvent {
  seq: number;
  at: string; // ISO
  evt: string; // "turn" | "memory.write" | "canonical.pin" | ...
  prevHash: string; // SHA-256 of the previous record's canonical form ("" for the first)
  [field: string]: unknown;
}

const GENESIS = "";

/** Canonical hash of a record: its JSON with keys in insertion order (as written to disk). */
function hashRecord(record: AuditEvent): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

export class AuditLedger {
  readonly #path: string;
  #seq: number;
  #head: string; // hash of the last record written (chain head)

  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
    const last = existsSync(path) ? lastRecord(path) : null;
    this.#seq = last ? last.seq : 0;
    this.#head = last ? hashRecord(last) : GENESIS;
  }

  /** Append one event; assigns seq + timestamp + prevHash, writes a JSONL line, returns it. */
  append(evt: string, fields: Record<string, unknown> = {}): AuditEvent {
    const record: AuditEvent = {
      seq: ++this.#seq,
      at: new Date().toISOString(),
      evt,
      prevHash: this.#head,
      ...fields,
    };
    appendFileSync(this.#path, JSON.stringify(record) + "\n");
    this.#head = hashRecord(record);
    return record;
  }

  /** The last n events (chronological). Empty if the ledger doesn't exist yet. */
  tail(n: number): AuditEvent[] {
    if (!existsSync(this.#path)) return [];
    const lines = readFileSync(this.#path, "utf8").split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => JSON.parse(l) as AuditEvent);
  }

  /**
   * Verify the hash chain end-to-end. Returns `{ ok: true }` when every record's `prevHash`
   * matches the hash of its predecessor and seqs are contiguous; otherwise the seq of the
   * first broken link. A break means the ledger was truncated, reordered, or rewritten.
   */
  verify(): { ok: true } | { ok: false; brokenAtSeq: number; reason: string } {
    if (!existsSync(this.#path)) return { ok: true };
    const lines = readFileSync(this.#path, "utf8").split("\n").filter(Boolean);
    let prev = GENESIS;
    let expectedSeq = 1;
    for (const line of lines) {
      let rec: AuditEvent;
      try {
        rec = JSON.parse(line) as AuditEvent;
      } catch {
        return { ok: false, brokenAtSeq: expectedSeq, reason: "unparseable record" };
      }
      if (rec.prevHash !== prev) {
        return { ok: false, brokenAtSeq: rec.seq, reason: "prevHash mismatch (record altered or removed)" };
      }
      if (rec.seq !== expectedSeq) {
        return { ok: false, brokenAtSeq: rec.seq, reason: `non-contiguous seq (expected ${expectedSeq})` };
      }
      prev = hashRecord(rec);
      expectedSeq++;
    }
    return { ok: true };
  }

  /** Highest seq written so far. */
  get seq(): number {
    return this.#seq;
  }
}

function lastRecord(path: string): AuditEvent | null {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const last = lines.at(-1);
  if (!last) return null;
  try {
    return JSON.parse(last) as AuditEvent;
  } catch {
    return null;
  }
}
