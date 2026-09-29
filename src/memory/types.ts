/**
 * Memory domain types & ports (MEMORY.md §2, MEMORY.md §6).
 * Types only — implementations live in db/timeline/store/embedder.
 * Single-sourced here so every module and test imports the same contracts.
 */
import type { Provenance, Fragment } from "../core/types.ts";

/** Embedding dimension. Fixed at DB-create time (vec0 column width). */
export const DEFAULT_DIM = 256;

// ─── Timeline: one global append-only log, seq = total order across channels ───
export type TimelineRole = "user" | "assistant" | "tool";

export interface TimelineLine {
  seq: number;
  at: string; // ISO
  channel: string; // "terminal" | "telegram" | ...
  provenance: Provenance; // taint carries
  episodeId: string;
  role: TimelineRole;
  text?: string;
  toolCalls?: unknown;
  toolResults?: unknown;
  /** Active lens id when the line was written (absent = no lens). */
  lens?: string;
}

/** A line before the store assigns its seq. */
export type NewTimelineLine = Omit<TimelineLine, "seq">;

export interface Timeline {
  /** Append a line; returns the assigned monotonic seq. */
  append(line: NewTimelineLine): number;
  /** Last n lines across ALL channels, chronological (oldest→newest). */
  workingSet(n: number): TimelineLine[];
  /** All lines strictly after `seq`, chronological. */
  since(seq: number): TimelineLine[];
  /** Lines with fromSeq ≤ seq ≤ toSeq, chronological. */
  range(fromSeq: number, toSeq: number): TimelineLine[];
  /** Highest assigned seq, or 0 if the timeline is empty. */
  lastSeq(): number;
}

// ─── Episode: a time-bounded slice (housekeeping, not identity) ───
export interface Episode {
  id: string;
  startSeq: number;
  endSeq: number | null; // null while open
  startedAt: string;
  endedAt?: string;
  summary?: string;
  salientFacts?: string[];
  /** Keyword-derived tags (a rebuildable projection — see MemoryStore.retagEpisodes). */
  tags?: string[];
  /** Lens ids active during the episode. */
  lenses?: string[];
}

// ─── AgentState: the single live cursor ───
export interface AgentState {
  activeEpisodeId: string;
  lastActiveAt: string;
  tokenBudget: { spent: number; ceiling: number };
  activeGrants: string[];
}

// ─── Embedder: text → vector. Swap point for offline vs hosted embeddings. ───
export interface Embedder {
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export type ChunkKind = "turn" | "episode" | "canonical" | "procedure" | "intention";

/**
 * The active lens as a search input (DESIGN §10b). Built by the lens layer; memory never knows
 * what a lens is about. `weight` is the lens's per-tier surface weight (0 = no boost). A lens adds
 * a second candidate stream (same query, restricted to lens-relevant items, widened by keywords)
 * and boosts lens-relevant items in the merged ranking. It never hides anything.
 */
export interface LensFocus {
  id: string;
  tags: string[];
  keywords: string[];
  weight: number;
}

/** Optional search controls shared by the episodic and procedural searches. */
export interface MemorySearchOptions {
  /** Explicit tags ⇒ HARD filter: only items carrying at least one of them. */
  tags?: string[];
  /** Active lens ⇒ extra candidate stream + boost. Absent/null ⇒ exactly the lens-free ranking. */
  lens?: LensFocus | null;
  /** Procedures only: include deprecated methods (default false). */
  includeDeprecated?: boolean;
}

/** Derives tags from free text (the lens keyword matcher). Pure, so its output is rebuildable. */
export type Tagger = (text: string) => string[];

// ─── EpisodeHit: a semantic-search result over past conversations (memory.query) ───
export interface EpisodeHit {
  episodeId: string;
  when: string | null; // episode ended_at (or started_at) — situates the memory in time
  text: string; // the episode summary
  provenance: Provenance; // rides along so a tainted episode surfaces as tainted
  tags: string[];
  lenses: string[];
  /** True when the active lens ranked this hit up (lens-stamped or tag overlap). */
  lensMatch?: boolean;
}

// ─── Canonical is typed: each kind renders as its own system-prompt section ───
// Procedural methods are NOT canonical — they are a pulled tier (see Procedure below, §7a).
export type CanonicalKind = "preference" | "memory_instruction" | "rule";

// ─── Fact: a durable, keyed canonical fact (name, timezone, preference…) ───
export interface Fact {
  /** Stable dedup key so a new value replaces the old, e.g. "user.name". */
  key: string;
  /** Category — drives which system-prompt section it renders into. Default "preference". */
  kind?: CanonicalKind;
  text: string; // human-readable, e.g. "The user's name is Rahul"
  provenance: Provenance;
  source?: string;
  /** Tagged facts render in standing context only while a lens with an overlapping tag is active. */
  tags?: string[];
  /** Lens stamp: the lens active when the fact was written. */
  lens?: string | null;
}

// ─── FactExtractor: pulls durable facts out of turns (heuristic or LLM). ───
export interface FactExtractor {
  extract(lines: TimelineLine[]): Promise<Fact[]>;
}

// ─── Procedural memory (MEMORY.md §7a): proven how-to methods, a PULLED tier ───
// Two granularities (Memp, arXiv 2508.06433): the abstraction generalizes, the verbatim steps
// carry the detail. Only `trigger` is embedded for search.
export interface Procedure {
  id: string;
  name: string; // stable identity, e.g. "deploy.staging"
  trigger: string; // "when to use this" — the ONLY field embedded for search
  abstractMethod: string; // generalized recipe (returned inline by search)
  verbatimSteps: string; // exact steps that worked (fetched on demand)
  evidence: string; // the task it succeeded on / why it's trusted
  uses: number;
  score: number;
  lastUsedAt: string | null;
  version: number;
  provenance: Provenance;
  createdAt: string;
  updatedAt: string;
  tags: string[]; // what it is about (approved with the write)
  lens: string | null; // lens stamp: where it was learned (harness-applied)
  status: ProcedureStatus;
  successes: number; // recorded outcomes — distinct from `uses` (fetches)
  failures: number;
}

export type ProcedureStatus = "active" | "deprecated";

/** A procedure record before storage assigns id/stats. */
export interface NewProcedure {
  name: string;
  trigger: string;
  abstractMethod: string;
  verbatimSteps: string;
  evidence: string;
  provenance: Provenance;
  tags?: string[];
  lens?: string | null;
}

/** Partial revision of an existing procedure (only provided fields change). */
export interface ProcedureUpdate {
  trigger?: string;
  abstractMethod?: string;
  verbatimSteps?: string;
  evidence?: string;
  tags?: string[];
  status?: ProcedureStatus;
}

/** A search hit — abstraction inline, verbatim fetched separately. */
export interface ProcedureHit {
  name: string;
  trigger: string;
  abstractMethod: string;
  provenance: Provenance;
  tags: string[];
  lens: string | null;
  status: ProcedureStatus;
  successes: number;
  failures: number;
  /** True when the active lens ranked this hit up (lens-stamped or tag overlap). */
  lensMatch?: boolean;
}

/** Outcome of createProcedure: created, or blocked by a near-duplicate (route to update). */
export type ProcedureCreateResult =
  | { created: true; name: string }
  | { created: false; duplicateOf: string; similarity: number };

// ─── MemoryStore: the retrieval layer (MEMORY.md §3) ───
export interface MemoryStore {
  /** Durable pinned facts (always-in-context tier). */
  canonical(): Promise<Fragment[]>;
  /** Write a canonical fact — gated + audited (behavior-changing). */
  writeCanonical(fact: Fragment): Promise<void>;
  /** Upsert a keyed canonical fact — replaces any existing fact with the same key. */
  upsertFact(fact: Fact): Promise<void>;
  /** Whether a canonical fact with this key already exists (idempotent seeding). */
  factExists(key: string): Promise<boolean>;
  /** All canonical facts as {key, kind, text} (for the memory.read tool). */
  canonicalList(): Promise<{ key: string | null; kind: CanonicalKind; text: string; tags?: string[] }[]>;
  /** Delete a canonical fact (and its recall index) by key. Returns whether it existed. */
  forgetFact(key: string): Promise<boolean>;
  /** Canonical facts grouped by kind (for the typed standing-context sections). */
  canonicalByKind(): Promise<Map<CanonicalKind, Fragment[]>>;
  /** Recent closed-episode summaries (episodic tier), newest first. */
  recentEpisodes(limit: number): Promise<Episode[]>;
  /** Semantic + lexical recall over the full history (on-demand tier). */
  recall(query: string, k: number): Promise<Fragment[]>;
  /** Semantic search restricted to past episodes (for the memory.query tool). */
  searchEpisodes(query: string, k: number, opts?: MemorySearchOptions): Promise<EpisodeHit[]>;
  /** Recompute every episode's keyword-derived tags (after a lens is created or its keywords
   * change). Returns how many episodes changed. */
  retagEpisodes(tagger: Tagger): Promise<number>;
  /** Index a closed episode's summary + turns for future recall. */
  index(episode: Episode, lines: TimelineLine[]): Promise<void>;

  // ─── Context-triggered intentions (facts-for-later, §D) ───
  /** Index a context intention's cue so it can be matched against future turns. */
  indexContextCue(id: string, cue: string, provenance: Provenance): Promise<void>;
  /** Cues relevant to the current turn (keyword-anchored). The caller filters to live intentions. */
  searchContextCues(query: string, k: number): Promise<ContextHit[]>;
  /** Remove a context intention's cue from the index (on cancel/done/expire). */
  removeContextCue(id: string): void;

  // ─── Procedural tier (§7a) ───
  /** Search proven methods for the current task (embeds `trigger`); abstraction returned inline. */
  searchProcedures(query: string, k: number, opts?: MemorySearchOptions): Promise<ProcedureHit[]>;
  /** Record whether following a method worked. Returns whether it existed. */
  recordProcedureOutcome(name: string, success: boolean): Promise<boolean>;
  /** Fetch one method in full (verbatim steps + evidence); bumps its use stats. Null if absent. */
  getProcedure(name: string): Promise<Procedure | null>;
  /** Record a proven method. Semantically dedupes on `trigger` before inserting. */
  createProcedure(p: NewProcedure): Promise<ProcedureCreateResult>;
  /** Revise an existing method on new findings (bumps version). Returns whether it existed. */
  updateProcedure(name: string, patch: ProcedureUpdate): Promise<boolean>;
  /** All procedures, newest-updated first (for the dashboard). */
  procedureList(): Promise<Procedure[]>;
}

// ─── Prospective memory: future-directed intentions (remember to act later) ───
// Externalized to durable storage because LLMs hold future intentions unreliably (PM-Bench,
// TriggerBench). The model CREATES an intention via a tool; a scheduler owns the clock and the
// wake. Firing re-enters as a normal turn, so the policy boundary re-checks at fire time.
export type IntentionTrigger = "once" | "cron" | "event" | "manual" | "context";

/** A context-triggered intention matched against the current turn (facts-for-later). */
export interface ContextHit {
  id: string; // intention id (chunk ref)
  cue: string; // the phrase describing WHEN it's relevant
  provenance: Provenance;
}
export type IntentionStatus = "pending" | "firing" | "done" | "cancelled" | "expired";
/**
 * What a prospective item IS (vs. what triggers it). Shapes how Alil surfaces it: a `reminder`
 * is told/done, a `fact` is woven in silently when relevant, a `decision` is offered to resume,
 * an `aspiration` is review-only, a `watch` notifies on a condition. Storage is uniform.
 */
export type IntentionKind = "reminder" | "fact" | "decision" | "aspiration" | "watch";
export const INTENTION_KINDS: readonly IntentionKind[] = ["reminder", "fact", "decision", "aspiration", "watch"];

/** Predicate for an event-triggered intention ("when an email from X arrives…"). */
export interface EventMatch {
  channel?: string; // e.g. "email" | "telegram"
  type?: string; // event type, adapter-defined
  from?: string; // sender contains (case-insensitive)
  subject?: string; // subject contains
  contains?: string; // body/text contains
  // Time window (epoch ms) gating WHEN the predicate is live — for "on Oct 5, when we chat".
  after?: number; // only match events at/after this instant
  before?: number; // only match events strictly before this instant
}

/** An event delivered from a channel adapter, evaluated against pending event intentions. */
export interface IncomingEvent {
  channel: string;
  type?: string;
  from?: string;
  subject?: string;
  text?: string;
  provenance: Provenance; // rides onto the fired turn so event-driven action stays tainted
}

export interface Intention {
  id: string;
  title: string; // short human label, e.g. "call mom"
  action: string; // NL instruction replayed to future-self on fire
  kind: IntentionKind; // what it IS (reminder/fact/decision/aspiration/watch)
  trigger: IntentionTrigger;
  fireAt: number | null; // epoch ms; next fire for once/cron, null for pure event
  cronExpr: string | null; // recurrence, null unless cron
  eventMatch: EventMatch | null; // null unless event
  contextCue: string | null; // null unless context — the phrase describing WHEN it's relevant
  nag: boolean; // re-fire until acknowledged (once triggers only)
  lastSurfacedAt: number | null; // context items: last surface time (cooldown)
  status: IntentionStatus;
  dedupKey: string | null; // idempotency: a UNIQUE key prevents duplicate scheduling
  expiresAt: number | null; // past this, a never-fired intention is expired
  createdAt: number;
  firedAt: number | null; // last fire time
  attempts: number;
  provenance: Provenance;
  lens: string | null; // lens it was created under — it fires in that lens
}

/** An intention before storage assigns id/status/stats. */
export interface NewIntention {
  title: string;
  action: string;
  kind?: IntentionKind; // defaults to "reminder"
  trigger: IntentionTrigger;
  fireAt?: number | null;
  cronExpr?: string | null;
  eventMatch?: EventMatch | null;
  contextCue?: string | null;
  nag?: boolean;
  expiresAt?: number | null;
  dedupKey?: string | null;
  provenance: Provenance;
  lens?: string | null;
}

// ─── EpisodeSummarizer: distills a closed episode (Phase 5). ───
export interface EpisodeSummarizer {
  summarize(lines: TimelineLine[]): Promise<{ summary: string; salientFacts: string[] }>;
}
