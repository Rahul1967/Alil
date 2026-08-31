import type { Provenance } from "../core/types.ts";

/**
 * The operator dossier: a durable, evolving, MARKDOWN-NATIVE model of the user — who they are,
 * what they prefer, what they own, who's around them, and how they change over time. Each fact
 * lives in a plain `.md` file (YAML frontmatter = the queryable row, markdown body = the content
 * the assistant evolves) that the operator can read, hand-edit, and git-diff. The store is a thin
 * reader/writer over those files; any index is a rebuildable projection, never the source of truth.
 *
 * Distinct from the world-model (present-tense state), canonical memory (general standing facts),
 * and prospective memory (future intentions). Writes cross the policy boundary like any other.
 */

/** What a dossier file IS — the single authoritative discriminator (frontmatter `type`). */
export type DossierType =
  | "identity" // who the operator is (singleton, always-fed)
  | "preferences" // how they like things (singleton, always-fed)
  | "note" // open-ended list/doc (bucket list, etc.)
  | "person" // a person/org in their life
  | "account" // bank/subscription/asset account
  | "loan" // a debt/liability
  | "document" // a reference doc/record
  | "event" // a life-event (the trajectory spine)
  | "index"; // a curated catalog (e.g. timeline.md)

export const DOSSIER_TYPES: DossierType[] = [
  "identity", "preferences", "note", "person", "account", "loan", "document", "event", "index",
];

/** Lifecycle of a file's content. Supersede, don't hard-delete — the trajectory stays intact. */
export type DossierStatus = "active" | "superseded" | "archived";

/** Confidence in the frontmatter facts (not a substitute for provenance). */
export type DossierConfidence = "high" | "medium" | "low";

/**
 * A small controlled tag vocabulary anchors the model so it reuses tags instead of inventing
 * `finances`/`financial`/`money` as three non-joining tags. New tags are allowed; these are seeded.
 */
export const TAG_VOCABULARY = [
  "financial", "health", "family", "friends", "work", "future-plans",
  "documents", "facts", "admin", "personal", "legal", "travel",
] as const;

/** The queryable frontmatter row. Flat by design (no nested maps) so it stays trivially scannable. */
export interface DossierFrontmatter {
  type: DossierType;
  title: string;
  slug: string; // stable, filename-safe id
  description?: string; // self-describing contract: how to read & update this file
  tags: string[]; // what the file is ABOUT (query key)
  status: DossierStatus;
  confidence?: DossierConfidence;
  provenance?: Provenance["origin"]; // operator | model | ingested | …
  created: string; // YYYY-MM-DD
  updated: string; // YYYY-MM-DD
  /** Type-specific and operator-authored fields are preserved verbatim across edits. */
  [key: string]: unknown;
}

/** One parsed dossier file: its location, its frontmatter row, and its markdown body. */
export interface DossierFile {
  path: string; // absolute path
  relPath: string; // path relative to the dossier root (stable identity across machines)
  frontmatter: DossierFrontmatter;
  body: string; // markdown content below the frontmatter
}

/** Filter for dossier.query — every field is ANDed; omitted fields don't constrain. */
export interface DossierQuery {
  type?: DossierType;
  tagsAny?: string[]; // match if the file has ANY of these tags
  tagsAll?: string[]; // match only if the file has ALL of these tags
  status?: DossierStatus;
  text?: string; // free-text match over title/description/body (case-insensitive)
  updatedAfter?: string; // YYYY-MM-DD inclusive
  updatedBefore?: string; // YYYY-MM-DD inclusive
  limit?: number;
}

/** A create request. `slug` is derived from title when omitted; singletons (identity/preferences)
 * always use their type as slug. Extra type-specific fields land in the frontmatter verbatim. */
export interface DossierCreate {
  type: DossierType;
  title: string;
  tags?: string[];
  description?: string;
  body?: string;
  status?: DossierStatus;
  confidence?: DossierConfidence;
  slug?: string;
  fields?: Record<string, unknown>; // extra frontmatter (institution, relation, when, …)
}

/** A patch to an existing file: replace the body and/or merge frontmatter fields. */
export interface DossierPatch {
  body?: string;
  frontmatter?: Record<string, unknown>; // shallow-merged; `updated` is always refreshed
}
