/**
 * Memory subsystem entrypoint + barrel (MEMORY.md §3).
 * `openMemory()` is the deployable seam: one call wires the portable SQLite file, the
 * embedder, the timeline, the store, and the brain-facing recall port.
 */
import { openMemoryDb } from "./db.ts";
import { SqliteTimeline } from "./timeline.ts";
import { SqliteMemoryStore } from "./store.ts";
import { ProspectiveStore } from "./prospective.ts";
import { HashingEmbedder } from "./embedder.ts";
import { MemoryRecall } from "./recall-port.ts";
import { DEFAULT_DIM } from "./types.ts";
import type { Database as DB } from "better-sqlite3";
import type { Embedder, Timeline, MemoryStore } from "./types.ts";

export interface MemorySystem {
  db: DB;
  timeline: Timeline;
  store: MemoryStore;
  prospective: ProspectiveStore;
  recall: MemoryRecall;
  close(): void;
}

export interface OpenMemoryOptions {
  /** DB file path. Default: ALIL_DB env, else workspace/memory.db. Use ":memory:" for ephemeral. */
  path?: string;
  /** Embedding dimension (fixed at DB-create time). Default 256. */
  dim?: number;
  /** Custom embedder. Default HashingEmbedder(dim) — offline. Must match `dim`. */
  embedder?: Embedder;
  /** Recall tier sizes. */
  recall?: { k?: number; episodes?: number };
}

export function openMemory(opts: OpenMemoryOptions = {}): MemorySystem {
  const dim = opts.dim ?? DEFAULT_DIM;
  const embedder = opts.embedder ?? new HashingEmbedder(dim);
  if (embedder.dim !== dim) {
    throw new Error(`openMemory: embedder.dim (${embedder.dim}) must equal dim (${dim})`);
  }
  const path = opts.path ?? process.env.ALIL_DB ?? "workspace/memory.db";
  const db = openMemoryDb(path, dim);
  const timeline = new SqliteTimeline(db);
  const store = new SqliteMemoryStore(db, embedder);
  const prospective = new ProspectiveStore(db);
  const recall = new MemoryRecall(store, opts.recall);
  return { db, timeline, store, prospective, recall, close: () => db.close() };
}

export { openMemoryDb } from "./db.ts";
export { SqliteTimeline } from "./timeline.ts";
export { SqliteMemoryStore } from "./store.ts";
export { ProspectiveStore } from "./prospective.ts";
export { HashingEmbedder, BedrockTitanEmbedder } from "./embedder.ts";
export { MemoryRecall } from "./recall-port.ts";
export { EpisodeStore, EpisodeManager, DEFAULT_GAP_MS } from "./episodes.ts";
export type { EpisodeManagerDeps } from "./episodes.ts";
export { ExtractiveSummarizer } from "./summarizer.ts";
export { HeuristicFactExtractor } from "./fact-extractor.ts";
export { CanonicalPromoter } from "./promoter.ts";
export { CanonicalKnowledge } from "./knowledge.ts";
export { seedMemoryInstructions, DEFAULT_MEMORY_INSTRUCTIONS } from "./seed.ts";
export { schemaSql } from "./schema.ts";
export { DEFAULT_DIM } from "./types.ts";
export type * from "./types.ts";
