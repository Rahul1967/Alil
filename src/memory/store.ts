/**
 * SqliteMemoryStore — the retrieval layer (MEMORY.md §4–§5, Phase 3).
 *
 * recall() is hybrid: semantic KNN (sqlite-vec) fused with lexical BM25 (FTS5) via
 * reciprocal-rank fusion, then hydrated from recall_chunk so every returned Fragment
 * carries its ORIGINAL provenance — this is how taint survives recall.
 *
 * Tier searches (episodes, procedures, context cues) rank ONLY their own chunk kind, and accept an
 * optional lens focus (DESIGN §10b): the model's query runs unchanged (candidates A), a lens adds a
 * second stream over lens-relevant items widened by the lens keywords (candidates B), and the merged
 * list is re-ranked with a tag boost. With no lens, only stream A runs — the lens-free ranking.
 */
import { randomUUID } from "node:crypto";
import type { Database as DB, Statement } from "better-sqlite3";
import type { Fragment, Provenance } from "../core/types.ts";
import type {
  Embedder, Episode, EpisodeHit, Fact, MemoryStore, TimelineLine, ChunkKind, CanonicalKind,
  Procedure, NewProcedure, ProcedureUpdate, ProcedureHit, ProcedureCreateResult, ContextHit,
  LensFocus, MemorySearchOptions, ProcedureStatus, Tagger,
} from "./types.ts";

/** RRF constant — dampens the weight of any single ranker's top positions. */
const RRF_K = 60;

/** One "rank unit" in fused-score space: what a single top-ranked hit in one ranker is worth. */
const RANK_UNIT = 1 / RRF_K;

/**
 * Cosine floor for the lens stream's vector side: a lens-relevant item only joins the candidates on
 * vector similarity when it is at least this close to the query (FTS hits always qualify). Without
 * a floor, every lens-tagged item would surface on every search of a small library.
 */
const LENS_STREAM_COSINE_FLOOR = 0.3;

/** Max rowids per IN (...) batch (SQLite's default variable limit is far higher; stay modest). */
const IN_BATCH = 500;

/**
 * Cosine-similarity floor for two things to count as "the same procedure" on create. Vectors
 * are L2-normalized, so cosine = 1 − d²/2 for sqlite-vec's L2 distance d. 0.9 ⇒ near-duplicate
 * → route to update instead of piling on a second entry (skill-bloat defense, §7a).
 */
const DEDUP_COSINE = 0.9;

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Build an FTS5 MATCH expression from a free-text query (OR of quoted tokens). */
function ftsQuery(query: string): string | null {
  const toks = tokenize(query);
  if (toks.length === 0) return null;
  return [...new Set(toks)].map((t) => `"${t}"`).join(" OR ");
}

function parseList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface ChunkRow {
  kind: string;
  ref: string;
  text: string;
  provenance: string;
  source: string | null;
}

interface EpisodeRow {
  id: string;
  start_seq: number;
  end_seq: number | null;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  salient_facts: string | null;
  tags: string | null;
  lenses: string | null;
}

interface CanonicalRow {
  text: string;
  provenance: string;
  source: string | null;
  tags: string | null;
}

interface CanonicalKindRow {
  kind: string;
  text: string;
  provenance: string;
  source: string | null;
  tags: string | null;
  lens: string | null;
}

interface RankRow {
  rowid: number;
}

interface DistRow {
  rowid: number;
  distance: number;
}

interface ProcedureRow {
  id: string;
  name: string;
  trigger: string;
  abstract_method: string;
  verbatim_steps: string;
  evidence: string;
  uses: number;
  score: number;
  last_used_at: string | null;
  version: number;
  provenance: string;
  created_at: string;
  updated_at: string;
  tags: string | null;
  lens: string | null;
  status: string | null;
  successes: number | null;
  failures: number | null;
}

/** What the tier search needs to know about one item, keyed by its chunk `ref`. */
interface ItemMeta {
  tags: string[];
  lenses: string[];
  /** Excluded from results entirely (e.g. a deprecated procedure). */
  exclude: boolean;
  /** Small additive prior in rank units (e.g. a procedure's outcome record). */
  prior: number;
}

interface RankedRef {
  ref: string;
  rowid: number;
  lensMatch: boolean;
}

function lensMatches(meta: ItemMeta, lens: LensFocus): boolean {
  if (meta.lenses.includes(lens.id)) return true;
  return meta.tags.some((t) => lens.tags.includes(t));
}

export class SqliteMemoryStore implements MemoryStore {
  readonly #db: DB;
  readonly #embedder: Embedder;

  #insVec: Statement;
  #insChunk: Statement;
  #insFts: Statement;
  #getChunk: Statement;
  #insCanonical: Statement;
  #allCanonical: Statement;
  #byKind: Statement;
  #listCanonical: Statement;
  #getCanonByKey: Statement;
  #delCanonById: Statement;
  #delVecByRef: Statement;
  #delFtsByRef: Statement;
  #delChunkByRef: Statement;
  #upsertEpisode: Statement;
  #recentEpisodes: Statement;
  #getEpisodeDate: Statement;
  #episodeMeta: Statement;
  #episodeLabels: Statement;
  #allEpisodes: Statement;
  #setEpisodeTags: Statement;
  #chunksOfKind: Statement;
  #knn: Statement;
  #fts: Statement;
  #knnKind: Statement;
  #ftsKind: Statement;
  #insProc: Statement;
  #getProcByName: Statement;
  #updProc: Statement;
  #touchProc: Statement;
  #procOutcome: Statement;
  #listProc: Statement;

  constructor(db: DB, embedder: Embedder) {
    this.#db = db;
    this.#embedder = embedder;
    this.#insVec = db.prepare(`INSERT INTO recall_vec(embedding) VALUES (?)`);
    this.#insChunk = db.prepare(
      `INSERT INTO recall_chunk(rowid, kind, ref, text, provenance, source) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.#insFts = db.prepare(`INSERT INTO recall_fts(rowid, text) VALUES (?, ?)`);
    this.#getChunk = db.prepare(`SELECT kind, ref, text, provenance, source FROM recall_chunk WHERE rowid = ?`);
    this.#insCanonical = db.prepare(
      `INSERT INTO canonical(id, key, kind, text, provenance, source, created_at, tags, lens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#allCanonical = db.prepare(`SELECT text, provenance, source, tags FROM canonical ORDER BY created_at ASC`);
    this.#byKind = db.prepare(`SELECT kind, text, provenance, source, tags, lens FROM canonical ORDER BY kind ASC, created_at ASC`);
    this.#listCanonical = db.prepare(`SELECT key, kind, text, tags FROM canonical ORDER BY kind ASC, created_at ASC`);
    this.#getCanonByKey = db.prepare(`SELECT id FROM canonical WHERE key = ?`);
    this.#delCanonById = db.prepare(`DELETE FROM canonical WHERE id = ?`);
    this.#delVecByRef = db.prepare(`DELETE FROM recall_vec WHERE rowid IN (SELECT rowid FROM recall_chunk WHERE kind = ? AND ref = ?)`);
    this.#delFtsByRef = db.prepare(`DELETE FROM recall_fts WHERE rowid IN (SELECT rowid FROM recall_chunk WHERE kind = ? AND ref = ?)`);
    this.#delChunkByRef = db.prepare(`DELETE FROM recall_chunk WHERE kind = ? AND ref = ?`);
    this.#upsertEpisode = db.prepare(
      `INSERT OR REPLACE INTO episodes(id, start_seq, end_seq, started_at, ended_at, summary, salient_facts, tags, lenses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#recentEpisodes = db.prepare(
      `SELECT * FROM episodes WHERE end_seq IS NOT NULL ORDER BY end_seq DESC LIMIT ?`,
    );
    this.#getEpisodeDate = db.prepare(`SELECT started_at, ended_at FROM episodes WHERE id = ?`);
    this.#episodeMeta = db.prepare(`SELECT id, tags, lenses FROM episodes`);
    this.#episodeLabels = db.prepare(`SELECT tags, lenses FROM episodes WHERE id = ?`);
    this.#allEpisodes = db.prepare(`SELECT id, summary, salient_facts, tags FROM episodes WHERE summary IS NOT NULL`);
    this.#setEpisodeTags = db.prepare(`UPDATE episodes SET tags = ? WHERE id = ?`);
    this.#chunksOfKind = db.prepare(`SELECT rowid, ref FROM recall_chunk WHERE kind = ?`);
    this.#knn = db.prepare(
      `SELECT rowid FROM recall_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
    );
    this.#fts = db.prepare(`SELECT rowid FROM recall_fts WHERE recall_fts MATCH ? ORDER BY rank LIMIT ?`);
    // Kind-restricted rankers: a search for one tier must rank only that tier's chunks, or a large
    // tier (episodes) crowds a small one (procedures) out of the over-fetched window. The vector
    // side is a linear scan over the tier (fine at single-operator scale; ANN is a later step).
    this.#knnKind = db.prepare(
      `SELECT v.rowid AS rowid, vec_distance_l2(v.embedding, ?) AS distance
         FROM recall_vec v JOIN recall_chunk c ON c.rowid = v.rowid
        WHERE c.kind = ? ORDER BY distance LIMIT ?`,
    );
    this.#ftsKind = db.prepare(
      `SELECT recall_fts.rowid AS rowid FROM recall_fts JOIN recall_chunk c ON c.rowid = recall_fts.rowid
        WHERE recall_fts MATCH ? AND c.kind = ? ORDER BY recall_fts.rank LIMIT ?`,
    );
    this.#insProc = db.prepare(
      `INSERT INTO procedure(id, name, trigger, abstract_method, verbatim_steps, evidence,
                             provenance, created_at, updated_at, tags, lens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#getProcByName = db.prepare(`SELECT * FROM procedure WHERE name = ?`);
    this.#updProc = db.prepare(
      `UPDATE procedure SET trigger = ?, abstract_method = ?, verbatim_steps = ?, evidence = ?, tags = ?, status = ?,
                            version = version + 1, updated_at = ? WHERE name = ?`,
    );
    // A fetch is a use, not a success: score moves only on a recorded outcome.
    this.#touchProc = db.prepare(
      `UPDATE procedure SET uses = uses + 1, last_used_at = ? WHERE name = ?`,
    );
    this.#procOutcome = db.prepare(
      `UPDATE procedure SET successes = successes + ?, failures = failures + ?, score = score + ? WHERE name = ?`,
    );
    this.#listProc = db.prepare(`SELECT * FROM procedure ORDER BY updated_at DESC`);
  }

  /** Index one chunk. `ftsText` (default `text`) lets lexical search see more than is embedded
   * (e.g. a procedure's tags) without changing its vector. */
  async #indexChunk(
    kind: ChunkKind,
    ref: string,
    text: string,
    provenance: Provenance,
    source?: string,
    ftsText?: string,
  ): Promise<void> {
    const [vec] = await this.#embedder.embed([text]);
    if (!vec) return;
    const blob = toBlob(vec);
    const prov = JSON.stringify(provenance);
    const write = this.#db.transaction(() => {
      const r = this.#insVec.run(blob);
      const rowid = Number(r.lastInsertRowid);
      this.#insChunk.run(rowid, kind, ref, text, prov, source ?? null);
      this.#insFts.run(rowid, ftsText ?? text);
    });
    write();
  }

  async canonical(): Promise<Fragment[]> {
    const rows = this.#allCanonical.all() as CanonicalRow[];
    return rows.map((r) => this.#toFragment(r.text, r.provenance, r.source, r.tags));
  }

  async writeCanonical(fact: Fragment): Promise<void> {
    const id = randomUUID();
    this.#insCanonical.run(id, null, "preference", fact.text, JSON.stringify(fact.provenance), fact.source ?? null, new Date().toISOString(), JSON.stringify(fact.tags ?? []), null);
    await this.#indexChunk("canonical", id, fact.text, fact.provenance, fact.source);
  }

  async upsertFact(fact: Fact): Promise<void> {
    // Replace any existing fact with the same key (a changed preference supersedes the old),
    // including its stale recall chunk so recall never returns the outdated value.
    const existing = this.#getCanonByKey.get(fact.key) as { id: string } | undefined;
    if (existing) {
      this.#deleteChunkByRef("canonical", existing.id);
      this.#delCanonById.run(existing.id);
    }
    const id = randomUUID();
    // Distinct source per fact so downstream dedup (which keys on source) never collapses
    // two different canonical facts into one.
    const source = `canonical:${fact.key}`;
    this.#insCanonical.run(
      id, fact.key, fact.kind ?? "preference", fact.text, JSON.stringify(fact.provenance), source, new Date().toISOString(),
      JSON.stringify(fact.tags ?? []), fact.lens ?? null,
    );
    await this.#indexChunk("canonical", id, fact.text, fact.provenance, source);
  }

  async factExists(key: string): Promise<boolean> {
    return this.#getCanonByKey.get(key) !== undefined;
  }

  async canonicalList(): Promise<{ key: string | null; kind: CanonicalKind; text: string; tags: string[] }[]> {
    const rows = this.#listCanonical.all() as { key: string | null; kind: string; text: string; tags: string | null }[];
    return rows.map((r) => ({ key: r.key, kind: r.kind as CanonicalKind, text: r.text, tags: parseList(r.tags) }));
  }

  async forgetFact(key: string): Promise<boolean> {
    const existing = this.#getCanonByKey.get(key) as { id: string } | undefined;
    if (!existing) return false;
    this.#deleteChunkByRef("canonical", existing.id);
    this.#delCanonById.run(existing.id);
    return true;
  }

  async canonicalByKind(): Promise<Map<CanonicalKind, Fragment[]>> {
    const rows = this.#byKind.all() as CanonicalKindRow[];
    const out = new Map<CanonicalKind, Fragment[]>();
    for (const r of rows) {
      const kind = r.kind as CanonicalKind;
      const list = out.get(kind) ?? [];
      list.push(this.#toFragment(r.text, r.provenance, r.source, r.tags));
      out.set(kind, list);
    }
    return out;
  }

  #deleteChunkByRef(kind: ChunkKind, ref: string): void {
    const del = this.#db.transaction(() => {
      this.#delVecByRef.run(kind, ref);
      this.#delFtsByRef.run(kind, ref);
      this.#delChunkByRef.run(kind, ref);
    });
    del();
  }

  async recentEpisodes(limit: number): Promise<Episode[]> {
    const rows = this.#recentEpisodes.all(limit) as EpisodeRow[];
    return rows.map(toEpisode);
  }

  // ─── Context-triggered intentions (facts-for-later, §D) ───
  async indexContextCue(id: string, cue: string, provenance: Provenance): Promise<void> {
    await this.#indexChunk("intention", id, cue, provenance);
  }

  /**
   * Cues relevant to the current turn. Keyword-anchored (FTS): a context fact surfaces when the
   * conversation lexically touches its cue — predictable with the offline embedder, and avoids
   * surfacing the "nearest" cue on every turn. (A stronger embedder enables true semantic match;
   * see the design's context-trigger open question.) The caller filters to live intentions.
   */
  async searchContextCues(query: string, k: number): Promise<ContextHit[]> {
    const match = ftsQuery(query);
    if (!match || k <= 0) return [];
    const rows = this.#ftsKind.all(match, "intention", k) as RankRow[];
    const out: ContextHit[] = [];
    for (const { rowid } of rows) {
      const c = this.#getChunk.get(rowid) as ChunkRow | undefined;
      if (!c) continue;
      out.push({ id: c.ref, cue: c.text, provenance: JSON.parse(c.provenance) as Provenance });
    }
    return out;
  }

  removeContextCue(id: string): void {
    this.#deleteChunkByRef("intention", id);
  }

  /**
   * Hybrid rank within ONE chunk kind: sqlite-vec distance + FTS5 BM25, fused by RRF. Returns
   * rowid → fused score.
   */
  async #rankKind(kind: ChunkKind, query: string, n: number): Promise<Map<number, number>> {
    const [qvec] = await this.#embedder.embed([query]);
    const vecRows = qvec ? (this.#knnKind.all(toBlob(qvec), kind, n) as DistRow[]) : [];
    const match = ftsQuery(query);
    const ftsRows = match ? (this.#ftsKind.all(match, kind, n) as RankRow[]) : [];
    const fused = new Map<number, number>();
    vecRows.forEach((row, i) => fused.set(row.rowid, (fused.get(row.rowid) ?? 0) + 1 / (RRF_K + i)));
    ftsRows.forEach((row, i) => fused.set(row.rowid, (fused.get(row.rowid) ?? 0) + 1 / (RRF_K + i)));
    return fused;
  }

  /**
   * The lens stream (candidates B): the same query, widened by the lens keywords, ranked only over
   * the lens-relevant rowids. An item qualifies on a lexical hit, or on vector similarity above the
   * floor — so an unrelated lens-tagged item does not ride along on every search.
   */
  async #rankWithin(rowids: number[], query: string, keywords: string[]): Promise<Map<number, number>> {
    const fused = new Map<number, number>();
    if (rowids.length === 0) return fused;
    const [qvec] = await this.#embedder.embed([query]);
    const match = ftsQuery([query, ...keywords].join(" "));
    const vecRows: DistRow[] = [];
    const ftsRows: RankRow[] = [];
    for (let i = 0; i < rowids.length; i += IN_BATCH) {
      const batch = rowids.slice(i, i + IN_BATCH);
      const ph = batch.map(() => "?").join(",");
      if (qvec) {
        vecRows.push(...(this.#db
          .prepare(`SELECT rowid, vec_distance_l2(embedding, ?) AS distance FROM recall_vec WHERE rowid IN (${ph})`)
          .all(toBlob(qvec), ...batch) as DistRow[]));
      }
      if (match) {
        ftsRows.push(...(this.#db
          .prepare(`SELECT rowid FROM recall_fts WHERE recall_fts MATCH ? AND rowid IN (${ph}) ORDER BY rank`)
          .all(match, ...batch) as RankRow[]));
      }
    }
    const lexical = new Set(ftsRows.map((r) => r.rowid));
    vecRows
      .filter((r) => lexical.has(r.rowid) || 1 - (r.distance * r.distance) / 2 >= LENS_STREAM_COSINE_FLOOR)
      .sort((a, b) => a.distance - b.distance)
      .forEach((row, i) => fused.set(row.rowid, (fused.get(row.rowid) ?? 0) + 1 / (RRF_K + i)));
    ftsRows.forEach((row, i) => fused.set(row.rowid, (fused.get(row.rowid) ?? 0) + 1 / (RRF_K + i)));
    return fused;
  }

  /**
   * Shared tier search: stream A (the unchanged query) ∪ stream B (lens), filtered by explicit tags
   * and `exclude`, re-ranked by base relevance + lens boost + prior. With no lens, no tags and no
   * priors, this is exactly stream A's order.
   */
  async #tierSearch(kind: ChunkKind, query: string, k: number, opts: MemorySearchOptions | undefined, meta: Map<string, ItemMeta> | null): Promise<RankedRef[]> {
    const a = await this.#rankKind(kind, query, k * 4);
    const lens = opts?.lens && opts.lens.weight > 0 ? opts.lens : null;
    let b = new Map<number, number>();
    const refOf = new Map<number, string>();
    if (lens && meta) {
      const relevant: number[] = [];
      for (const row of this.#chunksOfKind.all(kind) as { rowid: number; ref: string }[]) {
        const m = meta.get(row.ref);
        if (m && !m.exclude && lensMatches(m, lens)) {
          relevant.push(row.rowid);
          refOf.set(row.rowid, row.ref);
        }
      }
      b = await this.#rankWithin(relevant, query, lens.keywords);
    }
    const filterTags = opts?.tags && opts.tags.length > 0 ? opts.tags : null;
    const scored: { ref: string; rowid: number; score: number; lensMatch: boolean }[] = [];
    const seen = new Set<string>();
    for (const rowid of new Set([...a.keys(), ...b.keys()])) {
      let ref = refOf.get(rowid);
      if (ref === undefined) {
        const c = this.#getChunk.get(rowid) as ChunkRow | undefined;
        if (!c) continue;
        ref = c.ref;
      }
      if (seen.has(ref)) continue;
      const m = meta?.get(ref);
      if (m?.exclude) continue;
      if (filterTags && !(m && m.tags.some((t) => filterTags.includes(t)))) continue;
      const matched = !!(lens && m && lensMatches(m, lens));
      const score = (a.get(rowid) ?? 0) + (b.get(rowid) ?? 0) + (matched ? lens!.weight * RANK_UNIT : 0) + (m?.prior ?? 0);
      seen.add(ref);
      scored.push({ ref, rowid, score, lensMatch: matched });
    }
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, k).map(({ ref, rowid, lensMatch }) => ({ ref, rowid, lensMatch }));
  }

  async index(episode: Episode, lines: TimelineLine[]): Promise<void> {
    this.#upsertEpisode.run(
      episode.id,
      episode.startSeq,
      episode.endSeq,
      episode.startedAt,
      episode.endedAt ?? null,
      episode.summary ?? null,
      episode.salientFacts ? JSON.stringify(episode.salientFacts) : null,
      JSON.stringify(episode.tags ?? []),
      JSON.stringify(episode.lenses ?? []),
    );

    const parts: string[] = [];
    if (episode.summary) parts.push(episode.summary);
    if (episode.salientFacts) parts.push(...episode.salientFacts);
    if (parts.length === 0) {
      for (const l of lines) if (l.text) parts.push(l.text);
    }
    const text = parts.join("\n").trim();
    if (text.length === 0) return;

    // Taint survives recall: if any contributing line was tainted, mark the episode chunk.
    const taintedBy: string[] = [];
    for (const l of lines) {
      const p = l.provenance;
      if (p.origin === "ingested" || (p.taintedBy?.length ?? 0) > 0) {
        taintedBy.push(p.ingestedFrom ?? `${l.channel}:${l.seq}`);
      }
    }
    const provenance: Provenance =
      taintedBy.length > 0 ? { origin: "system", taintedBy } : { origin: "system" };

    // Idempotent: re-indexing an episode (e.g. crash recovery) replaces its chunk, never duplicates it.
    this.#deleteChunkByRef("episode", episode.id);
    await this.#indexChunk("episode", episode.id, text, provenance, `episode:${episode.id}`);
  }

  async recall(query: string, k: number): Promise<Fragment[]> {
    if (k <= 0) return [];

    // Semantic ranking (sqlite-vec KNN).
    const [qvec] = await this.#embedder.embed([query]);
    const vecRows = qvec ? (this.#knn.all(toBlob(qvec), k) as RankRow[]) : [];

    // Lexical ranking (FTS5 BM25).
    const match = ftsQuery(query);
    const ftsRows = match ? (this.#fts.all(match, k) as RankRow[]) : [];

    // Reciprocal-rank fusion across the two rankers.
    const fused = new Map<number, number>();
    const fuse = (rows: RankRow[]) => {
      rows.forEach((row, i) => {
        fused.set(row.rowid, (fused.get(row.rowid) ?? 0) + 1 / (RRF_K + i));
      });
    };
    fuse(vecRows);
    fuse(ftsRows);

    const top = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    const out: Fragment[] = [];
    for (const [rowid] of top) {
      const c = this.#getChunk.get(rowid) as ChunkRow | undefined;
      if (c) out.push(this.#toFragment(c.text, c.provenance, c.source, null));
    }
    return out;
  }

  #oneEpisodeMeta(id: string): ItemMeta | undefined {
    const r = this.#episodeLabels.get(id) as { tags: string | null; lenses: string | null } | undefined;
    return r ? { tags: parseList(r.tags), lenses: parseList(r.lenses), exclude: false, prior: 0 } : undefined;
  }

  #episodeMetaMap(): Map<string, ItemMeta> {
    const out = new Map<string, ItemMeta>();
    for (const r of this.#episodeMeta.all() as { id: string; tags: string | null; lenses: string | null }[]) {
      out.set(r.id, { tags: parseList(r.tags), lenses: parseList(r.lenses), exclude: false, prior: 0 });
    }
    return out;
  }

  async searchEpisodes(query: string, k: number, opts?: MemorySearchOptions): Promise<EpisodeHit[]> {
    if (k <= 0) return [];
    // Rank only episode chunks (canonical is already standing context), then enrich each hit
    // with its episode date and labels.
    const meta = opts?.lens || opts?.tags?.length ? this.#episodeMetaMap() : null;
    const ranked = await this.#tierSearch("episode", query, k, opts, meta);
    const out: EpisodeHit[] = [];
    for (const r of ranked) {
      const c = this.#getChunk.get(r.rowid) as ChunkRow | undefined;
      if (!c) continue;
      const date = this.#getEpisodeDate.get(c.ref) as { started_at: string; ended_at: string | null } | undefined;
      const m = meta?.get(c.ref) ?? this.#oneEpisodeMeta(c.ref);
      out.push({
        episodeId: c.ref,
        when: date?.ended_at ?? date?.started_at ?? null,
        text: c.text,
        provenance: JSON.parse(c.provenance) as Provenance,
        tags: m?.tags ?? [],
        lenses: m?.lenses ?? [],
        ...(r.lensMatch ? { lensMatch: true } : {}),
      });
    }
    return out;
  }

  async retagEpisodes(tagger: Tagger): Promise<number> {
    let changed = 0;
    const rows = this.#allEpisodes.all() as { id: string; summary: string; salient_facts: string | null; tags: string | null }[];
    const apply = this.#db.transaction(() => {
      for (const r of rows) {
        const text = [r.summary, ...parseList(r.salient_facts)].join("\n");
        const next = JSON.stringify([...new Set(tagger(text))].sort());
        if (next !== JSON.stringify([...parseList(r.tags)].sort())) {
          this.#setEpisodeTags.run(next, r.id);
          changed++;
        }
      }
    });
    apply();
    return changed;
  }

  // ─── Procedural tier (§7a) ───

  #procedureMetaMap(): Map<string, ItemMeta> {
    const out = new Map<string, ItemMeta>();
    for (const r of this.#listProc.all() as ProcedureRow[]) {
      const s = r.successes ?? 0;
      const f = r.failures ?? 0;
      // Outcome prior (Laplace-smoothed success rate, centered): ±0.5 rank unit at the extremes, 0
      // for a method with no recorded outcomes — so untouched libraries rank exactly as before.
      const prior = s + f > 0 ? ((s + 1) / (s + f + 2) - 0.5) * RANK_UNIT : 0;
      out.set(r.name, { tags: parseList(r.tags), lenses: r.lens ? [r.lens] : [], exclude: r.status === "deprecated", prior });
    }
    return out;
  }

  async searchProcedures(query: string, k: number, opts?: MemorySearchOptions): Promise<ProcedureHit[]> {
    if (k <= 0) return [];
    // Rank only procedure chunks (whose embedded text is the trigger), then hydrate the full
    // procedure and return its abstraction inline. Deprecated methods are excluded unless asked for.
    const meta = this.#procedureMetaMap();
    if (opts?.includeDeprecated) for (const m of meta.values()) m.exclude = false;
    const ranked = await this.#tierSearch("procedure", query, k, opts, meta);
    const out: ProcedureHit[] = [];
    for (const r of ranked) {
      const p = this.#getProcByName.get(r.ref) as ProcedureRow | undefined;
      if (!p) continue;
      const proc = toProcedure(p);
      out.push({
        name: proc.name,
        trigger: proc.trigger,
        abstractMethod: proc.abstractMethod,
        provenance: proc.provenance,
        tags: proc.tags,
        lens: proc.lens,
        status: proc.status,
        successes: proc.successes,
        failures: proc.failures,
        ...(r.lensMatch ? { lensMatch: true } : {}),
      });
    }
    return out;
  }

  async getProcedure(name: string): Promise<Procedure | null> {
    const before = this.#getProcByName.get(name) as ProcedureRow | undefined;
    if (!before) return null;
    // Fetching a method to follow it counts as a use — feeds ranking + soft-forgetting (§7a).
    this.#touchProc.run(new Date().toISOString(), name);
    const after = this.#getProcByName.get(name) as ProcedureRow;
    return toProcedure(after);
  }

  async recordProcedureOutcome(name: string, success: boolean): Promise<boolean> {
    const r = this.#procOutcome.run(success ? 1 : 0, success ? 0 : 1, success ? 1 : -1, name);
    return r.changes > 0;
  }

  async createProcedure(p: NewProcedure): Promise<ProcedureCreateResult> {
    // Exact-name collision → treat as an update target, not a second row.
    const byName = this.#getProcByName.get(p.name) as ProcedureRow | undefined;
    if (byName) return { created: false, duplicateOf: p.name, similarity: 1 };

    // Semantic dedup on the trigger (skill-bloat defense): a near-duplicate routes to update.
    const near = await this.#nearestProcedure(p.trigger);
    if (near && near.similarity >= DEDUP_COSINE) {
      return { created: false, duplicateOf: near.name, similarity: near.similarity };
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const tags = p.tags ?? [];
    this.#insProc.run(
      id, p.name, p.trigger, p.abstractMethod, p.verbatimSteps, p.evidence,
      JSON.stringify(p.provenance), now, now, JSON.stringify(tags), p.lens ?? null,
    );
    // Embed the TRIGGER (not the body) — search matches intent, per Voyager/Memp. Tags ride in the
    // lexical index only, so a tag query can hit a method whose trigger doesn't use the word.
    await this.#indexChunk("procedure", p.name, p.trigger, p.provenance, `procedure:${p.name}`, procedureFtsText(p.trigger, tags));
    return { created: true, name: p.name };
  }

  async updateProcedure(name: string, patch: ProcedureUpdate): Promise<boolean> {
    const existing = this.#getProcByName.get(name) as ProcedureRow | undefined;
    if (!existing) return false;
    const trigger = patch.trigger ?? existing.trigger;
    const abstractMethod = patch.abstractMethod ?? existing.abstract_method;
    const verbatimSteps = patch.verbatimSteps ?? existing.verbatim_steps;
    const evidence = patch.evidence ?? existing.evidence;
    const oldTags = parseList(existing.tags);
    const tags = patch.tags ?? oldTags;
    const status: ProcedureStatus = patch.status ?? (existing.status === "deprecated" ? "deprecated" : "active");
    this.#updProc.run(trigger, abstractMethod, verbatimSteps, evidence, JSON.stringify(tags), status, new Date().toISOString(), name);
    // Re-index only if an indexed field (the embedded trigger, or the lexically-indexed tags) changed.
    const tagsChanged = JSON.stringify(tags) !== JSON.stringify(oldTags);
    if ((patch.trigger !== undefined && patch.trigger !== existing.trigger) || tagsChanged) {
      this.#deleteChunkByRef("procedure", name);
      const prov = JSON.parse(existing.provenance) as Provenance;
      await this.#indexChunk("procedure", name, trigger, prov, `procedure:${name}`, procedureFtsText(trigger, tags));
    }
    return true;
  }

  async procedureList(): Promise<Procedure[]> {
    return (this.#listProc.all() as ProcedureRow[]).map(toProcedure);
  }

  /** Nearest existing procedure to `trigger` by cosine, or null if the library is empty. */
  async #nearestProcedure(trigger: string): Promise<{ name: string; similarity: number } | null> {
    const [qvec] = await this.#embedder.embed([trigger]);
    if (!qvec) return null;
    const [row] = this.#knnKind.all(toBlob(qvec), "procedure", 1) as DistRow[];
    if (!row) return null;
    const c = this.#getChunk.get(row.rowid) as ChunkRow | undefined;
    if (!c) return null;
    // L2 distance on unit vectors → cosine similarity.
    return { name: c.ref, similarity: 1 - (row.distance * row.distance) / 2 };
  }

  #toFragment(text: string, provenanceJson: string, source: string | null, tagsJson: string | null): Fragment {
    const frag: Fragment = { text, provenance: JSON.parse(provenanceJson) as Provenance };
    if (source !== null) frag.source = source;
    const tags = parseList(tagsJson);
    if (tags.length > 0) frag.tags = tags;
    return frag;
  }
}

function procedureFtsText(trigger: string, tags: string[]): string {
  return tags.length > 0 ? `${trigger}\n${tags.join(" ")}` : trigger;
}

function toProcedure(r: ProcedureRow): Procedure {
  return {
    id: r.id,
    name: r.name,
    trigger: r.trigger,
    abstractMethod: r.abstract_method,
    verbatimSteps: r.verbatim_steps,
    evidence: r.evidence,
    uses: r.uses,
    score: r.score,
    lastUsedAt: r.last_used_at,
    version: r.version,
    provenance: JSON.parse(r.provenance) as Provenance,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    tags: parseList(r.tags),
    lens: r.lens,
    status: r.status === "deprecated" ? "deprecated" : "active",
    successes: r.successes ?? 0,
    failures: r.failures ?? 0,
  };
}

function toEpisode(r: EpisodeRow): Episode {
  const ep: Episode = {
    id: r.id,
    startSeq: r.start_seq,
    endSeq: r.end_seq,
    startedAt: r.started_at,
  };
  if (r.ended_at !== null) ep.endedAt = r.ended_at;
  if (r.summary !== null) ep.summary = r.summary;
  if (r.salient_facts !== null) ep.salientFacts = JSON.parse(r.salient_facts) as string[];
  const tags = parseList(r.tags);
  if (tags.length > 0) ep.tags = tags;
  const lenses = parseList(r.lenses);
  if (lenses.length > 0) ep.lenses = lenses;
  return ep;
}
