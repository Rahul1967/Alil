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

export type ChunkKind = "turn" | "episode" | "canonical" | "procedure";

// ─── EpisodeHit: a semantic-search result over past conversations (memory.query) ───
export interface EpisodeHit {
  episodeId: string;
  when: string | null; // episode ended_at (or started_at) — situates the memory in time
  text: string; // the episode summary
  provenance: Provenance; // rides along so a tainted episode surfaces as tainted
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
}

/** A procedure record before storage assigns id/stats. */
export interface NewProcedure {
  name: string;
  trigger: string;
  abstractMethod: string;
  verbatimSteps: string;
  evidence: string;
  provenance: Provenance;
}

/** Partial revision of an existing procedure (only provided fields change). */
export interface ProcedureUpdate {
  trigger?: string;
  abstractMethod?: string;
  verbatimSteps?: string;
  evidence?: string;
}

/** A search hit — abstraction inline, verbatim fetched separately. */
export interface ProcedureHit {
  name: string;
  trigger: string;
  abstractMethod: string;
  provenance: Provenance;
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
  canonicalList(): Promise<{ key: string | null; kind: CanonicalKind; text: string }[]>;
  /** Delete a canonical fact (and its recall index) by key. Returns whether it existed. */
  forgetFact(key: string): Promise<boolean>;
  /** Canonical facts grouped by kind (for the typed standing-context sections). */
  canonicalByKind(): Promise<Map<CanonicalKind, Fragment[]>>;
  /** Recent closed-episode summaries (episodic tier), newest first. */
  recentEpisodes(limit: number): Promise<Episode[]>;
  /** Semantic + lexical recall over the full history (on-demand tier). */
  recall(query: string, k: number): Promise<Fragment[]>;
  /** Semantic search restricted to past episodes (for the memory.query tool). */
  searchEpisodes(query: string, k: number): Promise<EpisodeHit[]>;
  /** Index a closed episode's summary + turns for future recall. */
  index(episode: Episode, lines: TimelineLine[]): Promise<void>;

  // ─── Procedural tier (§7a) ───
  /** Search proven methods for the current task (embeds `trigger`); abstraction returned inline. */
  searchProcedures(query: string, k: number): Promise<ProcedureHit[]>;
  /** Fetch one method in full (verbatim steps + evidence); bumps its use stats. Null if absent. */
  getProcedure(name: string): Promise<Procedure | null>;
  /** Record a proven method. Semantically dedupes on `trigger` before inserting. */
  createProcedure(p: NewProcedure): Promise<ProcedureCreateResult>;
  /** Revise an existing method on new findings (bumps version). Returns whether it existed. */
  updateProcedure(name: string, patch: ProcedureUpdate): Promise<boolean>;
  /** All procedures, newest-updated first (for the dashboard). */
  procedureList(): Promise<Procedure[]>;
}

// ─── EpisodeSummarizer: distills a closed episode (Phase 5). ───
export interface EpisodeSummarizer {
  summarize(lines: TimelineLine[]): Promise<{ summary: string; salientFacts: string[] }>;
}
