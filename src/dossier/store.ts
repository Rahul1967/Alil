import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
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
}

/** Which subdirectory a well-known type routes into. Singletons + indexes sit at the root. Unknown
 * (Alil-invented) types route into their own `<type>s/` folder — see #relPathFor. */
const TYPE_DIR: Record<string, string> = {
  identity: "", preferences: "", index: "",
  note: "notes", person: "people", account: "finance", loan: "finance",
  document: "documents", event: "events",
};

const DEFAULT_PREAMBLE_MAX = 1600;

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

  constructor(opts: DossierStoreOptions) {
    this.#root = opts.root;
    this.#now = opts.now ?? (() => new Date());
    this.#preambleMax = opts.preambleMaxChars ?? DEFAULT_PREAMBLE_MAX;
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
    this.#write(rel, fm, body);
    const created = this.#parseFile(join(this.#root, rel))!;
    // Trajectory layer: starting to track a substantive fact is itself a transition. Skip the
    // infrastructure/self types (event/index/timeline; identity/preferences describe the operator,
    // not a change) so the timeline stays selective and never self-references.
    if (isTransitionWorthy(input.type)) {
      this.#recordTransition(created, "began tracking", provenance);
    }
    return created;
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
    this.#write(f.relPath, fm, body);
    const updated = this.#parseFile(f.path)!;
    // Trajectory layer: a status change (e.g. active → superseded) is a material transition worth
    // recording. Ordinary field/body edits are not logged, to keep the timeline selective (Chronos:
    // only real state transitions, not a firehose). `event` files never trigger this — no cascade.
    const statusBefore = f.frontmatter.status;
    const statusAfter = updated.frontmatter.status;
    if (f.frontmatter.type !== "event" && statusAfter !== statusBefore) {
      this.#recordTransition(updated, `status: ${statusBefore} → ${statusAfter}`, provenance);
    }
    return updated;
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
    rmSync(f.path);
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
   * Emit an `event` file recording a transition on `subject`, then re-project `timeline.md`. This
   * is the trajectory automation: a fact changing IS an event (event-sourcing), events are the
   * append-only log, and timeline.md is a pure projection regenerated from them (never hand-edited,
   * so it can't drift). Kept selective — only called for material transitions. Best-effort: a
   * failure here never breaks the underlying dossier write that triggered it.
   */
  #recordTransition(subject: DossierFile, what: string, provenance: Provenance): void {
    try {
      const when = this.#now().toISOString();
      const day = when.slice(0, 10);
      const domain = primaryDomain(subject.frontmatter);
      // Unique, sortable, collision-proof slug: dated + subject + a short disambiguator.
      const base = `${day}-${subject.frontmatter.slug}`;
      let slug = base;
      let n = 2;
      while (this.get(slug)) slug = `${base}-${n++}`;

      const title = `${subject.frontmatter.title}: ${what}`;
      const fm: DossierFrontmatter = {
        type: "event",
        title,
        slug,
        tags: normalizeTags(subject.frontmatter.tags),
        status: "active",
        provenance: provenance.origin,
        created: day,
        updated: day,
        when,
        domain,
        subject: subject.frontmatter.slug,
      };
      const body = `## What changed\n${what} — ${subject.frontmatter.title} (${subject.frontmatter.type}).\n`;
      const rel = this.#relPathFor("event", slug);
      this.#write(rel, fm, body);
      this.regenerateTimeline();
    } catch {
      // Trajectory logging is best-effort; the primary dossier write already succeeded.
    }
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
   * the source of truth, this file is a derived view. Writes nothing when there are no events.
   */
  regenerateTimeline(): void {
    const events = this.timeline();
    const rel = "timeline.md";
    if (events.length === 0) return;

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
    for (const e of events) {
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
    this.#write(rel, fm, lines.join("\n").trimEnd() + "\n");
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
    const abs = join(this.#root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, serialize(fm, body));
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
