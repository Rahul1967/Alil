import {
  readFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync,
  renameSync, openSync, closeSync, fsyncSync, unlinkSync, writeSync,
} from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Provenance } from "../core/types.ts";
import type {
  DossierType, DossierFile, DossierFrontmatter, DossierQuery, DossierCreate, DossierPatch, DossierStatus,
} from "./types.ts";

export interface DossierStoreOptions {
  /** Root directory the dossier `.md` files live under. */
  root: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Max chars in the always-on operator preamble (~4 chars/token). Default 1600 (~400 tokens). */
  preambleMaxChars?: number;
  /**
   * Milliseconds to wait for the cross-process write lock before failing closed. Default 5000.
   * A single logical mutation is fast, so a caller blocked this long means another process is
   * genuinely writing (or a stale lock remains after a crash — see `.dossier.lock`).
   */
  lockTimeoutMs?: number;
}

/** One file to write in a commit: its vault-relative path and the exact bytes to land there. */
interface PlannedWrite {
  rel: string;
  data: string;
}

/** Which subdirectory a well-known type routes into. Singletons + indexes sit at the root. Unknown
 * (Alil-invented) types route into their own `<type>s/` folder — see #relPathFor. */
const TYPE_DIR: Record<string, string> = {
  identity: "", preferences: "", index: "",
  note: "notes", person: "people", account: "finance", loan: "finance",
  document: "documents", event: "events",
};

const DEFAULT_PREAMBLE_MAX = 1600;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const LOCK_FILE = ".dossier.lock";

/**
 * DossierStore — the single reader/writer for the operator dossier. Markdown files are the source
 * of truth; this class parses frontmatter+body, answers structured queries by scanning them, and
 * writes changes back as human-readable markdown. Every write stamps provenance and refreshes
 * `updated`; supersede marks content stale rather than destroying it. Model access is only ever
 * through the gated `dossier.*` tools (reads auto-allowed, writes approval-gated).
 */
export class DossierStore {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #preambleMax: number;
  readonly #lockTimeoutMs: number;

  constructor(opts: DossierStoreOptions) {
    this.#root = opts.root;
    this.#now = opts.now ?? (() => new Date());
    this.#preambleMax = opts.preambleMaxChars ?? DEFAULT_PREAMBLE_MAX;
    this.#lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  /** Every dossier file, parsed. Corrupt files are skipped rather than crashing a query. */
  list(): DossierFile[] {
    if (!existsSync(this.#root)) return [];
    const out: DossierFile[] = [];
    for (const abs of walkMarkdown(this.#root)) {
      const f = this.#parseFile(abs);
      if (f) out.push(f);
    }
    return out;
  }

  /** One file by slug (the stable id), or undefined. */
  get(slug: string): DossierFile | undefined {
    return this.list().find((f) => f.frontmatter.slug === slug);
  }

  /**
   * Slugs of existing files ranked by similarity to a target — used to turn a "no such slug" error
   * into a recoverable hint (the model guessed a slug instead of querying). Matches on shared
   * tokens first (so "account-hdfc-bank" surfaces "hdfc-bank-salary-account"), then substring, then
   * a light edit-distance fallback. Returns at most `limit` slugs, closest first.
   */
  suggestSlugs(target: string, limit = 5): string[] {
    const want = slugify(target);
    const wantTokens = new Set(want.split("-").filter(Boolean));
    const scored = this.list().map((f) => {
      const slug = f.frontmatter.slug;
      const tokens = slug.split("-").filter(Boolean);
      const shared = tokens.filter((t) => wantTokens.has(t)).length;
      const substr = slug.includes(want) || want.includes(slug) ? 1 : 0;
      // Higher is closer: token overlap dominates, substring is a tiebreaker, then -distance.
      const score = shared * 10 + substr * 3 - editDistance(want, slug) / 100;
      return { slug, score, shared, substr };
    });
    return scored
      .filter((s) => s.shared > 0 || s.substr > 0) // only real near-misses, not the whole file list
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.slug);
  }

  /** Structured query: filter by type/tags/status/date/text. All conditions are ANDed. */
  query(q: DossierQuery): DossierFile[] {
    let files = this.list();
    if (q.type) files = files.filter((f) => f.frontmatter.type === q.type);
    if (q.status) files = files.filter((f) => f.frontmatter.status === q.status);
    if (q.tagsAny?.length) files = files.filter((f) => q.tagsAny!.some((t) => f.frontmatter.tags.includes(t)));
    if (q.tagsAll?.length) files = files.filter((f) => q.tagsAll!.every((t) => f.frontmatter.tags.includes(t)));
    if (q.updatedAfter) files = files.filter((f) => f.frontmatter.updated >= q.updatedAfter!);
    if (q.updatedBefore) files = files.filter((f) => f.frontmatter.updated <= q.updatedBefore!);
    if (q.text) {
      const needle = q.text.toLowerCase();
      files = files.filter((f) =>
        f.frontmatter.title.toLowerCase().includes(needle) ||
        (f.frontmatter.description ?? "").toLowerCase().includes(needle) ||
        f.body.toLowerCase().includes(needle));
    }
    files.sort((a, b) => (a.frontmatter.updated < b.frontmatter.updated ? 1 : -1)); // newest first
    return q.limit && q.limit > 0 ? files.slice(0, q.limit) : files;
  }

  /** Create a new file. Returns the written file. Fails if the slug already exists. */
  create(input: DossierCreate, provenance: Provenance): DossierFile {
    const slug = input.slug ? slugify(input.slug) : isSingleton(input.type) ? input.type : slugify(input.title);
    if (this.get(slug)) throw new Error(`dossier: a file with slug "${slug}" already exists (use update)`);
    const today = this.#today();
    const fm: DossierFrontmatter = {
      type: input.type,
      title: input.title,
      slug,
      ...(input.description ? { description: input.description } : {}),
      tags: normalizeTags(input.tags ?? []),
      status: input.status ?? "active",
      ...(input.confidence ? { confidence: input.confidence } : {}),
      provenance: provenance.origin,
      created: today,
      updated: today,
      ...(input.fields ?? {}),
    };
    const body = ensureSkeleton(input.type, input.body ?? "");
    const rel = this.#relPathFor(input.type, slug);
    // Collect the subject write plus — for a substantive fact — the trajectory event and the
    // regenerated timeline into ONE atomic bundle. Starting to track a fact IS a transition, but
    // it must land all-or-nothing with the fact itself (no partial "subject written, event lost").
    // Skip the infrastructure/self types (event/index; identity/preferences) so the timeline stays
    // selective and never self-references.
    const writes: PlannedWrite[] = [{ rel, data: serialize(fm, body) }];
    if (isTransitionWorthy(input.type)) {
      writes.push(...this.#transitionWrites(fm, "began tracking", provenance));
    }
    this.#commit(writes);
    return this.#parseFile(join(this.#root, rel))!;
  }

  /** Patch an existing file's body and/or frontmatter. `updated` is always refreshed. */
  update(slug: string, patch: DossierPatch, provenance: Provenance): DossierFile {
    const f = this.get(slug);
    if (!f) throw new Error(this.#notFoundMessage(slug));
    const fm: DossierFrontmatter = {
      ...f.frontmatter,
      ...(patch.frontmatter ?? {}),
      slug: f.frontmatter.slug, // slug is immutable identity
      type: f.frontmatter.type,
      tags: normalizeTags((patch.frontmatter?.["tags"] as string[]) ?? f.frontmatter.tags),
      provenance: provenance.origin,
      updated: this.#today(),
    };
    const body = patch.body !== undefined ? ensureSkeleton(fm.type, patch.body) : f.body;
    // Trajectory layer: a status change (e.g. active → superseded) is a material transition worth
    // recording; ordinary field/body edits are not, keeping the timeline selective. Bundle the
    // subject write and any transition (event + timeline) into ONE atomic commit so they can never
    // diverge. `event` files never trigger this — no cascade.
    const statusBefore = f.frontmatter.status;
    const statusAfter = fm.status;
    const writes: PlannedWrite[] = [{ rel: f.relPath, data: serialize(fm, body) }];
    if (f.frontmatter.type !== "event" && statusAfter !== statusBefore) {
      writes.push(...this.#transitionWrites(fm, `status: ${statusBefore} → ${statusAfter}`, provenance));
    }
    this.#commit(writes);
    return this.#parseFile(f.path)!;
  }

  /** Mark a file superseded (status flip + a dated note appended). The fact is kept, not deleted. */
  supersede(slug: string, reason: string, provenance: Provenance): DossierFile {
    const f = this.get(slug);
    if (!f) throw new Error(this.#notFoundMessage(slug));
    const note = `\n\n> Superseded ${this.#today()}: ${reason}`;
    return this.update(slug, { body: f.body + note, frontmatter: { status: "superseded" as DossierStatus } }, provenance);
  }

  /** Hard-remove a file. High-risk; the boundary gates it. Returns whether a file was removed. */
  remove(slug: string): boolean {
    const f = this.get(slug);
    if (!f) return false;
    this.#withLock(() => rmSync(f.path));
    return true;
  }

  /**
   * The always-on operator profile: identity + high-confidence preferences, rendered as a compact
   * block injected every turn (like the world state block). Capped so it can't re-bloat context.
   * Returns null when neither singleton exists yet.
   */
  operatorPreamble(): string | null {
    const identity = this.get("identity");
    const prefs = this.get("preferences");
    if (!identity && !prefs) return null;
    const parts: string[] = [];
    if (identity) parts.push(bodyContent(identity.body));
    if (prefs && prefs.frontmatter.confidence !== "low") parts.push(bodyContent(prefs.body));
    let text = parts.filter(Boolean).join("\n").trim();
    if (!text) return null;
    if (text.length > this.#preambleMax) text = text.slice(0, this.#preambleMax).trimEnd() + " …";
    return text;
  }

  // ── Trajectory layer: event files + the timeline projection (DESIGN §09) ─────

  /**
   * Build the planned writes for a transition on `subject`: one immutable `event` file plus the
   * regenerated `timeline.md` projection that INCLUDES that new event. This returns writes rather
   * than performing them, so the caller can bundle them with the subject write into ONE atomic
   * commit — a fact changing and its event/timeline now land all-or-nothing (no more best-effort
   * "subject written, event lost"). Kept selective: only called for material transitions, and
   * never for `event`/`index`/self-singletons, so the timeline can't cascade or self-reference.
   */
  #transitionWrites(subject: DossierFrontmatter, what: string, provenance: Provenance, whenIso?: string, extraEvents: DossierFile[] = []): PlannedWrite[] {
    const when = whenIso ?? this.#now().toISOString();
    const day = when.slice(0, 10);
    const domain = primaryDomain(subject);
    // Unique, sortable, collision-proof slug: dated + subject + a short disambiguator. Also avoid
    // colliding with events staged earlier in the same batch (extraEvents), not just those on disk.
    const staged = new Set(extraEvents.map((e) => e.frontmatter.slug));
    const base = `${day}-${subject.slug}`;
    let slug = base;
    let n = 2;
    while (this.get(slug) || staged.has(slug)) slug = `${base}-${n++}`;

    const title = `${subject.title}: ${what}`;
    const eventFm: DossierFrontmatter = {
      type: "event",
      title,
      slug,
      tags: normalizeTags(subject.tags),
      status: "active",
      provenance: provenance.origin,
      created: day,
      updated: day,
      when,
      domain,
      subject: subject.slug,
    };
    const eventBody = `## What changed\n${what} — ${subject.title} (${subject.type}).\n`;
    const eventRel = this.#relPathFor("event", slug);
    const eventFile: DossierFile = {
      path: join(this.#root, eventRel),
      relPath: eventRel,
      frontmatter: eventFm,
      body: eventBody,
    };

    const writes: PlannedWrite[] = [{ rel: eventRel, data: serialize(eventFm, eventBody) }];
    // Timeline projection must reflect the event we're about to write (plus any events staged
    // earlier in the same batch), so seed it rather than re-reading from disk (which wouldn't yet
    // contain them within this atomic commit).
    const timeline = this.#timelineWrite([...this.timeline(), ...extraEvents, eventFile]);
    if (timeline) writes.push(timeline);
    return writes;
  }

  /**
   * One-time migration for a dossier populated BEFORE the trajectory layer existed: emit a
   * "began tracking" `event` for every substantive file that has no event yet, dated to that
   * file's own `created` date (faithful history, not "now"), then regenerate `timeline.md`. All
   * new events + the timeline land in ONE atomic commit. Idempotent: a subject that already has an
   * event is skipped, so re-running is a no-op. Returns the number of events created.
   */
  backfillTimeline(provenance: Provenance): number {
    // Subjects that already have at least one event — skip them (idempotent).
    const withEvent = new Set(
      this.list().filter((f) => f.frontmatter.type === "event").map((e) => String(e.frontmatter["subject"] ?? "")),
    );
    const subjects = this.list().filter(
      (f) => isTransitionWorthy(f.frontmatter.type) && !withEvent.has(f.frontmatter.slug),
    );
    if (subjects.length === 0) return 0;

    // Oldest-created first, so slugs and the timeline read in chronological order.
    subjects.sort((a, b) => (a.frontmatter.created < b.frontmatter.created ? -1 : 1));

    const writes: PlannedWrite[] = [];
    const stagedEvents: DossierFile[] = [];
    for (const subj of subjects) {
      const created = subj.frontmatter.created || this.#today();
      // Date the synthetic event to the file's creation day (midday UTC so the date is stable).
      const whenIso = `${created}T12:00:00.000Z`;
      const w = this.#transitionWrites(subj.frontmatter, "began tracking", provenance, whenIso, stagedEvents);
      // The last write in each call is the timeline projection; keep only the event writes here and
      // rebuild the timeline once at the end from all staged events.
      const eventWrite = w[0]!;
      writes.push(eventWrite);
      stagedEvents.push(this.#parsePlanned(eventWrite));
    }
    // Single timeline projection reflecting every backfilled event.
    const timeline = this.#timelineWrite([...this.timeline(), ...stagedEvents]);
    if (timeline) writes.push(timeline);

    this.#commit(writes);
    return stagedEvents.length;
  }

  /** Parse a just-built PlannedWrite (frontmatter+body) back into a DossierFile for projection. */
  #parsePlanned(w: PlannedWrite): DossierFile {
    const { frontmatter, body } = parse(w.data);
    return {
      path: join(this.#root, w.rel),
      relPath: w.rel,
      frontmatter: frontmatter as DossierFrontmatter,
      body,
    };
  }

  /** All `event` files, newest transition first (by `when`, falling back to `updated`). */
  timeline(limit?: number): DossierFile[] {
    const events = this.list().filter((f) => f.frontmatter.type === "event");
    events.sort((a, b) => (eventWhen(a) < eventWhen(b) ? 1 : -1));
    return limit && limit > 0 ? events.slice(0, limit) : events;
  }

  /**
   * Rebuild `timeline.md` as a pure projection of the `event` files: a human-readable life-arc
   * grouped by domain, newest first. Idempotent and rebuildable at any time — the event files are
   * the source of truth, this file is a derived view. A no-op when there are no events.
   */
  regenerateTimeline(): void {
    const write = this.#timelineWrite(this.timeline());
    if (write) this.#commit([write]);
  }

  /**
   * Compute the `timeline.md` projection for a set of events, as a PlannedWrite — pure (no I/O), so
   * it can be bundled into an atomic commit or applied on its own by `regenerateTimeline`. Returns
   * null when there are no events (nothing to project).
   */
  #timelineWrite(events: DossierFile[]): PlannedWrite | null {
    if (events.length === 0) return null;
    const sorted = [...events].sort((a, b) => (eventWhen(a) < eventWhen(b) ? 1 : -1));

    const fm: DossierFrontmatter = {
      type: "index",
      title: "Timeline",
      slug: "timeline",
      description: "Auto-generated life-arc: every recorded transition, newest first. Do not hand-edit — regenerated from the `event` files, which are the source of truth.",
      tags: [],
      status: "active",
      provenance: "model",
      created: this.#today(),
      updated: this.#today(),
    };

    // Group by domain, newest-first within each group.
    const byDomain = new Map<string, DossierFile[]>();
    for (const e of sorted) {
      const d = String(e.frontmatter["domain"] ?? "general");
      (byDomain.get(d) ?? byDomain.set(d, []).get(d)!).push(e);
    }
    const domains = [...byDomain.keys()].sort();
    const lines: string[] = [];
    for (const d of domains) {
      lines.push(`## ${d}`, "");
      for (const e of byDomain.get(d)!) {
        const date = String(e.frontmatter["when"] ?? e.frontmatter.updated).slice(0, 10);
        lines.push(`- **${date}** — ${e.frontmatter.title}  \`${e.frontmatter.slug}\``);
      }
      lines.push("");
    }
    return { rel: "timeline.md", data: serialize(fm, lines.join("\n").trimEnd() + "\n") };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #today(): string {
    return this.#now().toISOString().slice(0, 10);
  }

  #relPathFor(type: DossierType, slug: string): string {
    // Well-known types have a fixed home; an Alil-invented type gets its own `<type>s/` folder so
    // new document kinds stay organized without any hard-coded list.
    const dir = Object.hasOwn(TYPE_DIR, type) ? TYPE_DIR[type]! : `${slugify(type)}s`;
    const name = isSingleton(type) ? `${type}.md` : `${slug}.md`;
    return dir ? join(dir, name) : name;
  }

  #write(rel: string, fm: DossierFrontmatter, body: string): void {
    this.#commit([{ rel, data: serialize(fm, body) }]);
  }

  /**
   * Apply a set of file writes as ONE recoverable transaction under the cross-process lock.
   * Guarantees:
   *  - Atomic per file: each target is written to a temp file, fsync'd, then atomically renamed
   *    over the destination — a reader never sees a truncated/partial file, even on crash.
   *  - All-or-nothing across the bundle: any file being overwritten is first backed up; if a later
   *    rename fails, the already-committed renames are rolled back from those backups and remaining
   *    temps are cleaned up, so a coupled write (subject + event + timeline) can't half-apply.
   * A commit with no writes is a no-op (and does not take the lock).
   */
  #commit(writes: PlannedWrite[]): void {
    if (writes.length === 0) return;
    this.#withLock(() => {
      const staged: { abs: string; tmp: string; backup: string | null }[] = [];
      const committed: { abs: string; backup: string | null }[] = [];
      try {
        // Phase 1 — stage every write to a temp file next to its destination (nothing visible yet).
        for (const w of writes) {
          const abs = join(this.#root, w.rel);
          mkdirSync(dirname(abs), { recursive: true });
          const tmp = `${abs}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
          atomicPrepare(tmp, w.data);
          const backup = existsSync(abs) ? `${abs}.${process.pid}.${randomBytes(6).toString("hex")}.bak` : null;
          staged.push({ abs, tmp, backup });
        }
        // Phase 2 — commit: back up any file we're about to overwrite, then rename temp into place.
        for (const s of staged) {
          if (s.backup) renameSync(s.abs, s.backup); // preserve prior bytes for rollback
          renameSync(s.tmp, s.abs);
          committed.push({ abs: s.abs, backup: s.backup });
        }
        // Phase 3 — success: drop the backups.
        for (const c of committed) if (c.backup) safeUnlink(c.backup);
      } catch (err) {
        // Roll back the renames that already landed, restoring prior bytes (or removing a created
        // file), then clean up any un-committed temps. Leaves the vault as it was pre-commit.
        for (const c of committed.reverse()) {
          if (c.backup) { safeUnlink(c.abs); renameSync(c.backup, c.abs); }
          else safeUnlink(c.abs);
        }
        for (const s of staged) safeUnlink(s.tmp);
        throw err;
      }
    });
  }

  /**
   * Run `fn` while holding an exclusive, cross-process advisory lock on the dossier root, so a
   * browser turn, a Telegram turn, and an ambient wake sharing one workspace can't interleave
   * writes. The lock is an `wx`-created `.dossier.lock` file carrying the holder's pid + time.
   * Fails closed after `lockTimeoutMs` rather than corrupting state. A stale lock (holder crashed)
   * is reported with its recorded pid/time — it is NEVER auto-stolen; recovery is an explicit
   * operator action (delete the lockfile after confirming no writer is alive).
   */
  #withLock<T>(fn: () => T): T {
    mkdirSync(this.#root, { recursive: true });
    const lockPath = join(this.#root, LOCK_FILE);
    const deadline = Date.now() + this.#lockTimeoutMs;
    let fd: number | undefined;
    for (;;) {
      try {
        fd = openSync(lockPath, "wx"); // exclusive create — fails if the lock is held
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (Date.now() >= deadline) {
          const holder = readLockHolder(lockPath);
          throw new Error(
            `dossier: could not acquire write lock at ${lockPath} within ${this.#lockTimeoutMs}ms` +
            (holder ? ` (held by pid ${holder.pid} since ${holder.at})` : "") +
            `. If no writer is alive, remove the lockfile to recover.`,
          );
        }
        sleepSync(25); // brief spin; a logical mutation is fast, so contention clears quickly
      }
    }
    try {
      return fn();
    } finally {
      if (fd !== undefined) closeSync(fd);
      safeUnlink(lockPath);
    }
  }

  #parseFile(abs: string): DossierFile | null {
    try {
      const raw = readFileSync(abs, "utf8");
      const { frontmatter, body } = parse(raw);
      if (!frontmatter || typeof frontmatter.slug !== "string" || typeof frontmatter.type !== "string") return null;
      const fm: DossierFrontmatter = {
        ...frontmatter,
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [],
        status: (frontmatter.status as DossierStatus) ?? "active",
        created: String(frontmatter.created ?? ""),
        updated: String(frontmatter.updated ?? frontmatter.created ?? ""),
      } as DossierFrontmatter;
      return { path: abs, relPath: relative(this.#root, abs).split(sep).join("/"), frontmatter: fm, body };
    } catch {
      return null; // corrupt/partial file: skip rather than crash the whole query
    }
  }

  /**
   * Build a recoverable "no such slug" error: name the miss, then either point at the closest
   * existing slugs (so the model can retry with a real one) or, if there are no near-misses, tell
   * it to dossier.query / dossier.create. Turning the dead-end into a next-step keeps the model
   * from silently guessing (the trace where it invented "account-hdfc-bank" and fell through).
   */
  #notFoundMessage(slug: string): string {
    const near = this.suggestSlugs(slug);
    if (near.length > 0) {
      return `dossier: no file with slug "${slug}". Did you mean: ${near.map((s) => `"${s}"`).join(", ")}? ` +
        `Use dossier.query to confirm the exact slug, or dossier.create if it doesn't exist yet.`;
    }
    return `dossier: no file with slug "${slug}". No similar file exists — run dossier.query to list ` +
      `what's there, or dossier.create to add it.`;
  }
}

// ── module helpers ─────────────────────────────────────────────────────────

/**
 * Write `data` to `tmp` and flush it to disk (fsync), so a subsequent atomic rename lands fully
 * durable bytes. The caller renames `tmp` over the real destination; POSIX rename is atomic, so a
 * concurrent reader sees either the old file or the complete new one — never a partial write.
 */
function atomicPrepare(tmp: string, data: string): void {
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Remove a file, ignoring "already gone" — used for temps, backups, and lock cleanup. */
function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Read the pid/time recorded in a held lockfile, for a helpful stale-lock error. Best-effort. */
function readLockHolder(path: string): { pid: unknown; at: unknown } | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { pid: unknown; at: unknown };
    return { pid: j.pid, at: j.at };
  } catch {
    return null;
  }
}

/** Busy-wait `ms` milliseconds synchronously (the store's write path is intentionally sync). */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin briefly; contention on a fast mutation clears quickly */ }
}


/** Levenshtein edit distance (small strings only) — the last-resort ranker in suggestSlugs. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  let curr: number[] = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

function isSingleton(type: DossierType): boolean {
  return type === "identity" || type === "preferences";
}

/**
 * Which types warrant a trajectory `event` on create. Excludes infrastructure (event/index) so the
 * timeline never self-references, and the operator-self singletons (identity/preferences), which
 * describe who the operator IS rather than a change worth timelining.
 */
function isTransitionWorthy(type: DossierType): boolean {
  return type !== "event" && type !== "index" && !isSingleton(type);
}

/** The domain an event groups under in the timeline: first tag, else the subject's type. */
function primaryDomain(fm: DossierFrontmatter): string {
  return fm.tags[0] ?? fm.type;
}

/** An event's sort key: its resolved `when` timestamp, falling back to `updated`. */
function eventWhen(f: DossierFile): string {
  return String(f.frontmatter["when"] ?? f.frontmatter.updated ?? "");
}

/** Required body skeleton per type, so updates stay predictable and queryable. */
const SKELETON: Partial<Record<DossierType, string>> = {
  identity: "## Facts\n",
  preferences: "## Preferences\n",
  note: "## Items\n",
  person: "## Facts\n\n## Relations\n\n## Log\n",
  account: "## Facts\n",
  loan: "## Facts\n\n## Schedule\n",
  document: "## Summary\n",
  event: "## What changed\n",
};

/** If the body is empty, seed the type's skeleton; otherwise leave the model's content untouched. */
function ensureSkeleton(type: DossierType, body: string): string {
  if (body.trim().length > 0) return body;
  return SKELETON[type] ?? "";
}

/** Content of a body with a leading `# Title` heading stripped (already shown as the title). */
function bodyContent(body: string): string {
  return body.replace(/^\s*#\s+.*\n?/, "").trim();
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";
}

/** Canonicalize tags: lowercase, hyphenate, dedupe, and map a few common synonyms. */
const TAG_SYNONYMS: Record<string, string> = {
  finance: "financial", finances: "financial", money: "financial",
  familiy: "family", relatives: "family", future: "future-plans", goals: "future-plans",
  doc: "documents", docs: "documents", document: "documents",
};
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    let t = String(raw).toLowerCase().trim().replace(/\s+/g, "-");
    t = TAG_SYNONYMS[t] ?? t;
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/** Serialize frontmatter + body into a `---`-delimited markdown file. */
export function serialize(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  const trimmedBody = body.replace(/^\n+/, "").trimEnd();
  return `---\n${yaml}\n---\n\n${trimmedBody}\n`;
}

/** Parse a `---`-delimited markdown file into {frontmatter, body}. Missing frontmatter ⇒ null fm. */
export function parse(raw: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { frontmatter: null, body: raw };
  const fm = parseYaml(m[1]!) as Record<string, unknown> | null;
  const body = raw.slice(m[0].length).replace(/^\n+/, "");
  return { frontmatter: fm, body };
}

/** Recursively collect `.md` files under a directory (skips dotfiles/dot-dirs). */
function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walkMarkdown(abs));
    else if (entry.endsWith(".md")) out.push(abs);
  }
  return out;
}
