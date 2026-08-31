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
    return this.#parseFile(join(this.#root, rel))!;
  }

  /** Patch an existing file's body and/or frontmatter. `updated` is always refreshed. */
  update(slug: string, patch: DossierPatch, provenance: Provenance): DossierFile {
    const f = this.get(slug);
    if (!f) throw new Error(`dossier: no file with slug "${slug}"`);
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
    return this.#parseFile(f.path)!;
  }

  /** Mark a file superseded (status flip + a dated note appended). The fact is kept, not deleted. */
  supersede(slug: string, reason: string, provenance: Provenance): DossierFile {
    const f = this.get(slug);
    if (!f) throw new Error(`dossier: no file with slug "${slug}"`);
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
}

// ── module helpers ─────────────────────────────────────────────────────────

function isSingleton(type: DossierType): boolean {
  return type === "identity" || type === "preferences";
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
