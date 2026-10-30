/**
 * AuditLedger — the append-only decision/write log (DESIGN.md §02 gateway, §11 code map).
 *
 * Every behavior-changing event (a distilled episode, a pinned canonical fact, a completed
 * turn) is recorded as one JSONL line with a monotonic seq. It is the forensic source of
 * truth: because memory writes change FUTURE behavior, they must be auditable after the
 * fact — this is what makes the "context manipulation" threat traceable rather than silent.
 *
 * Tamper-evident: each record carries `prevHash` (SHA-256 of the previous record's canonical
 * form) forming a hash chain. Truncating, reordering, or rewriting any line breaks the chain
 * from that point on, which `verify()` detects.
 *
 * Multi-writer safe: the Telegram process and the UI server share one ledger. Each append takes a
 * cross-process lock (`<ledger>.lock`) and chains onto the LAST LINE ON DISK, never a cached head,
 * so two writers can't fork the chain or reuse a seq.
 *
 * History that broke before this (records that predate the chain, a fork from two writers) is never
 * edited. Instead `seal()` appends a `ledger.seal` record carrying a SHA-256 of every byte before it:
 * verification then checks that digest (so the sealed part is still frozen against edits) and runs
 * the strict chain from the seal on.
 */
import { openSync, closeSync, writeSync, fsyncSync, readSync, fstatSync, readFileSync, existsSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export interface AuditEvent {
  seq: number;
  at: string; // ISO
  evt: string; // "turn" | "memory.write" | "canonical.pin" | "ledger.seal" | ...
  prevHash: string; // SHA-256 of the previous line as written ("" for the first)
  [field: string]: unknown;
}

export interface AuditLedgerOptions {
  /** How long an append waits for another writer's lock before failing. Default 5000 ms. */
  lockTimeoutMs?: number;
}

export type VerifyResult =
  | { ok: true; sealed?: { atSeq: number; lines: number; breaks: number } }
  | { ok: false; brokenAtSeq: number; reason: string };

const GENESIS = "";
const SEAL = "ledger.seal";
/** A lock older than this is a crashed writer's leftover (an append takes milliseconds). */
const STALE_LOCK_MS = 10_000;

/** Hash of one record exactly as it sits on disk (the line, without its newline). */
function hashLine(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}

export class AuditLedger {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #lockTimeoutMs: number;

  constructor(path: string, opts: AuditLedgerOptions = {}) {
    this.#path = path;
    this.#lockPath = `${path}.lock`;
    this.#lockTimeoutMs = opts.lockTimeoutMs ?? 5000;
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Append one event; assigns seq + timestamp + prevHash from the ledger's current last line. */
  append(evt: string, fields: Record<string, unknown> = {}): AuditEvent {
    return this.#withLock(() => {
      const last = lastLine(this.#path);
      const lastSeq = last ? (parseSeq(last) ?? maxSeq(this.#path)) : 0;
      const record: AuditEvent = {
        seq: lastSeq + 1,
        at: new Date().toISOString(),
        evt,
        prevHash: last ? hashLine(last) : GENESIS,
        ...fields,
      };
      this.#write(record);
      return record;
    });
  }

  /**
   * Freeze a broken history: append a `ledger.seal` record holding a SHA-256 of everything before it,
   * how many lines and breaks it covers, and why. Never edits a byte that is already there. Refused
   * on an intact ledger, so a seal always marks a real, recorded break.
   */
  seal(reason: string): AuditEvent {
    return this.#withLock(() => {
      if (this.verify().ok) throw new Error("audit ledger is intact: nothing to seal");
      const raw = readFileSync(this.#path, "utf8");
      const prior = raw.endsWith("\n") ? raw : `${raw}\n`;
      const lines = prior.split("\n").filter(Boolean);
      const breaks = countBreaks(lines);
      const record: AuditEvent = {
        seq: maxSeqOf(lines) + 1,
        at: new Date().toISOString(),
        evt: SEAL,
        prevHash: hashLine(lines.at(-1)!),
        reason,
        priorLines: lines.length,
        priorBreaks: breaks.count,
        ...(breaks.firstAtSeq !== null ? { firstBreakSeq: breaks.firstAtSeq } : {}),
        priorDigest: createHash("sha256").update(prior).digest("hex"),
      };
      this.#write(record, raw.endsWith("\n") || raw.length === 0 ? "" : "\n");
      return record;
    });
  }

  /** The last n events (chronological). Empty if the ledger doesn't exist yet. */
  tail(n: number): AuditEvent[] {
    if (!existsSync(this.#path)) return [];
    const lines = readFileSync(this.#path, "utf8").split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => JSON.parse(l) as AuditEvent);
  }

  /**
   * Verify the ledger. With no seal: every record's `prevHash` is the hash of the line before it
   * and seqs run 1, 2, 3… With a seal: the bytes before the latest seal must match its digest, and
   * the strict chain runs from the seal on. Returns the seq of the first broken link otherwise.
   */
  verify(): VerifyResult {
    if (!existsSync(this.#path)) return { ok: true };
    const raw = readFileSync(this.#path, "utf8");
    const lines: { text: string; offset: number }[] = [];
    let offset = 0;
    for (const text of raw.split("\n")) {
      if (text) lines.push({ text, offset });
      offset += text.length + 1;
    }
    const parsed: (AuditEvent | null)[] = lines.map((l) => {
      try { return JSON.parse(l.text) as AuditEvent; } catch { return null; }
    });

    let from = 0;
    let sealed: { atSeq: number; lines: number; breaks: number } | undefined;
    let sealAt = -1;
    for (let i = parsed.length - 1; i >= 0 && sealAt < 0; i--) if (parsed[i]?.evt === SEAL) sealAt = i;
    if (sealAt >= 0) {
      const seal = parsed[sealAt]!;
      const prior = Buffer.from(raw, "utf8").subarray(0, Buffer.byteLength(raw.slice(0, lines[sealAt]!.offset), "utf8"));
      if (createHash("sha256").update(prior).digest("hex") !== seal["priorDigest"]) {
        return { ok: false, brokenAtSeq: seal.seq, reason: "sealed history altered (digest mismatch)" };
      }
      sealed = { atSeq: seal.seq, lines: Number(seal["priorLines"] ?? sealAt), breaks: Number(seal["priorBreaks"] ?? 0) };
      from = sealAt;
    }

    for (let i = from; i < lines.length; i++) {
      const rec = parsed[i];
      if (!rec) return { ok: false, brokenAtSeq: (parsed[i - 1]?.seq ?? 0) + 1, reason: "unparseable record" };
      const prevHash = i === 0 ? GENESIS : hashLine(lines[i - 1]!.text);
      if (rec.prevHash !== prevHash) {
        return { ok: false, brokenAtSeq: rec.seq, reason: "prevHash mismatch (record altered, removed, or forked)" };
      }
      if (i > from || i === 0) {
        const expected = i === 0 ? 1 : (parsed[i - 1]?.seq ?? 0) + 1;
        if (rec.seq !== expected) return { ok: false, brokenAtSeq: rec.seq, reason: `non-contiguous seq (expected ${expected})` };
      }
    }
    return sealed ? { ok: true, sealed } : { ok: true };
  }

  /** Highest seq on disk (the last record's). */
  get seq(): number {
    const last = existsSync(this.#path) ? lastLine(this.#path) : null;
    return last ? (parseSeq(last) ?? maxSeq(this.#path)) : 0;
  }

  /** One record as one write of one line (O_APPEND), flushed before the lock is released. */
  #write(record: AuditEvent, lead = ""): void {
    const fd = openSync(this.#path, "a");
    try {
      writeSync(fd, `${lead}${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  #withLock<T>(fn: () => T): T {
    const deadline = Date.now() + this.#lockTimeoutMs;
    let fd: number | undefined;
    for (;;) {
      try {
        fd = openSync(this.#lockPath, "wx"); // exclusive create: fails while another writer holds it
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (staleLock(this.#lockPath)) {
          try { unlinkSync(this.#lockPath); } catch { /* another writer broke it first */ }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`audit ledger: could not take the write lock ${this.#lockPath} within ${this.#lockTimeoutMs}ms`);
        }
        sleepSync(5);
      }
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try { unlinkSync(this.#lockPath); } catch { /* already gone */ }
    }
  }
}

/** The last non-empty line of the file, read from the end (the ledger only grows). */
function lastLine(path: string): string | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    for (let chunk = 64 * 1024; ; chunk *= 2) {
      const len = Math.min(size, chunk);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n").filter(Boolean);
      // A full line is guaranteed once the chunk holds a newline before the last line, or the whole file.
      if (lines.length >= 2 || len === size) return lines.at(-1) ?? null;
    }
  } finally {
    closeSync(fd);
  }
}

function parseSeq(line: string): number | null {
  try {
    const seq = (JSON.parse(line) as { seq?: unknown }).seq;
    return typeof seq === "number" ? seq : null;
  } catch {
    return null;
  }
}

function maxSeq(path: string): number {
  return maxSeqOf(readFileSync(path, "utf8").split("\n").filter(Boolean));
}

function maxSeqOf(lines: string[]): number {
  let max = 0;
  for (const l of lines) max = Math.max(max, parseSeq(l) ?? 0);
  return max;
}

/** Broken links in a stretch of ledger: an unchained or mis-chained record, or an out-of-order seq. */
function countBreaks(lines: string[]): { count: number; firstAtSeq: number | null } {
  let count = 0;
  let firstAtSeq: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    let rec: AuditEvent | null = null;
    try { rec = JSON.parse(lines[i]!) as AuditEvent; } catch { /* unparseable counts as a break */ }
    const prevSeq = i === 0 ? 0 : (parseSeq(lines[i - 1]!) ?? 0);
    const ok = rec !== null && rec.prevHash === (i === 0 ? GENESIS : hashLine(lines[i - 1]!)) && rec.seq === prevSeq + 1;
    if (!ok) {
      count++;
      firstAtSeq ??= rec?.seq ?? prevSeq + 1;
    }
  }
  return { count, firstAtSeq };
}

/** A lock whose holder is gone (dead pid) or that has outlived any real append. */
function staleLock(lockPath: string): boolean {
  try {
    const holder = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
    if (typeof holder.pid === "number" && holder.pid !== process.pid) {
      try { process.kill(holder.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return true; }
    }
    return Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false; // mid-write by its holder, or already removed: not ours to break
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
