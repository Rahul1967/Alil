/**
 * SqliteMemoryStore — the retrieval layer (MEMORY.md §4–§5, Phase 3).
 *
 * recall() is hybrid: semantic KNN (sqlite-vec) fused with lexical BM25 (FTS5) via
 * reciprocal-rank fusion, then hydrated from recall_chunk so every returned Fragment
 * carries its ORIGINAL provenance — this is how taint survives recall.
 */
import { randomUUID } from "node:crypto";
import type { Database as DB, Statement } from "better-sqlite3";
import type { Fragment, Provenance } from "../core/types.ts";
import type { Embedder, Episode, EpisodeHit, Fact, MemoryStore, TimelineLine, ChunkKind, CanonicalKind } from "./types.ts";

/** RRF constant — dampens the weight of any single ranker's top positions. */
const RRF_K = 60;

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
  return toks.map((t) => `"${t}"`).join(" OR ");
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
}

interface CanonicalRow {
  text: string;
  provenance: string;
  source: string | null;
}

interface CanonicalKindRow {
  kind: string;
  text: string;
  provenance: string;
  source: string | null;
}

interface RankRow {
  rowid: number;
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
  #knn: Statement;
  #fts: Statement;

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
      `INSERT INTO canonical(id, key, kind, text, provenance, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#allCanonical = db.prepare(`SELECT text, provenance, source FROM canonical ORDER BY created_at ASC`);
    this.#byKind = db.prepare(`SELECT kind, text, provenance, source FROM canonical ORDER BY kind ASC, created_at ASC`);
    this.#listCanonical = db.prepare(`SELECT key, kind, text FROM canonical ORDER BY kind ASC, created_at ASC`);
    this.#getCanonByKey = db.prepare(`SELECT id FROM canonical WHERE key = ?`);
    this.#delCanonById = db.prepare(`DELETE FROM canonical WHERE id = ?`);
    this.#delVecByRef = db.prepare(`DELETE FROM recall_vec WHERE rowid IN (SELECT rowid FROM recall_chunk WHERE kind = ? AND ref = ?)`);
    this.#delFtsByRef = db.prepare(`DELETE FROM recall_fts WHERE rowid IN (SELECT rowid FROM recall_chunk WHERE kind = ? AND ref = ?)`);
    this.#delChunkByRef = db.prepare(`DELETE FROM recall_chunk WHERE kind = ? AND ref = ?`);
    this.#upsertEpisode = db.prepare(
      `INSERT OR REPLACE INTO episodes(id, start_seq, end_seq, started_at, ended_at, summary, salient_facts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#recentEpisodes = db.prepare(
      `SELECT * FROM episodes WHERE end_seq IS NOT NULL ORDER BY end_seq DESC LIMIT ?`,
    );
    this.#getEpisodeDate = db.prepare(`SELECT started_at, ended_at FROM episodes WHERE id = ?`);
    this.#knn = db.prepare(
      `SELECT rowid FROM recall_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
    );
    this.#fts = db.prepare(`SELECT rowid FROM recall_fts WHERE recall_fts MATCH ? ORDER BY rank LIMIT ?`);
  }

  async #indexChunk(
    kind: ChunkKind,
    ref: string,
    text: string,
    provenance: Provenance,
    source?: string,
  ): Promise<void> {
    const [vec] = await this.#embedder.embed([text]);
    if (!vec) return;
    const blob = toBlob(vec);
    const prov = JSON.stringify(provenance);
    const write = this.#db.transaction(() => {
      const r = this.#insVec.run(blob);
      const rowid = Number(r.lastInsertRowid);
      this.#insChunk.run(rowid, kind, ref, text, prov, source ?? null);
      this.#insFts.run(rowid, text);
    });
    write();
  }

  async canonical(): Promise<Fragment[]> {
    const rows = this.#allCanonical.all() as CanonicalRow[];
    return rows.map((r) => this.#toFragment(r.text, r.provenance, r.source));
  }

  async writeCanonical(fact: Fragment): Promise<void> {
    const id = randomUUID();
    this.#insCanonical.run(id, null, "preference", fact.text, JSON.stringify(fact.provenance), fact.source ?? null, new Date().toISOString());
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
    this.#insCanonical.run(id, fact.key, fact.kind ?? "preference", fact.text, JSON.stringify(fact.provenance), source, new Date().toISOString());
    await this.#indexChunk("canonical", id, fact.text, fact.provenance, source);
  }

  async factExists(key: string): Promise<boolean> {
    return this.#getCanonByKey.get(key) !== undefined;
  }

  async canonicalList(): Promise<{ key: string | null; kind: CanonicalKind; text: string }[]> {
    const rows = this.#listCanonical.all() as { key: string | null; kind: string; text: string }[];
    return rows.map((r) => ({ key: r.key, kind: r.kind as CanonicalKind, text: r.text }));
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
      list.push(this.#toFragment(r.text, r.provenance, r.source));
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

  async index(episode: Episode, lines: TimelineLine[]): Promise<void> {
    this.#upsertEpisode.run(
      episode.id,
      episode.startSeq,
      episode.endSeq,
      episode.startedAt,
      episode.endedAt ?? null,
      episode.summary ?? null,
      episode.salientFacts ? JSON.stringify(episode.salientFacts) : null,
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
      if (c) out.push(this.#toFragment(c.text, c.provenance, c.source));
    }
    return out;
  }

  async searchEpisodes(query: string, k: number): Promise<EpisodeHit[]> {
    if (k <= 0) return [];
    // Over-fetch from both rankers, fuse, then keep only episode chunks (canonical is already
    // standing context) and enrich each hit with its episode date.
    const over = k * 4;
    const [qvec] = await this.#embedder.embed([query]);
    const vecRows = qvec ? (this.#knn.all(toBlob(qvec), over) as RankRow[]) : [];
    const match = ftsQuery(query);
    const ftsRows = match ? (this.#fts.all(match, over) as RankRow[]) : [];

    const fused = new Map<number, number>();
    const fuse = (rows: RankRow[]) => {
      rows.forEach((row, i) => fused.set(row.rowid, (fused.get(row.rowid) ?? 0) + 1 / (RRF_K + i)));
    };
    fuse(vecRows);
    fuse(ftsRows);

    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]);
    const out: EpisodeHit[] = [];
    for (const [rowid] of ranked) {
      if (out.length >= k) break;
      const c = this.#getChunk.get(rowid) as ChunkRow | undefined;
      if (!c || c.kind !== "episode") continue;
      const date = this.#getEpisodeDate.get(c.ref) as { started_at: string; ended_at: string | null } | undefined;
      out.push({
        episodeId: c.ref,
        when: date?.ended_at ?? date?.started_at ?? null,
        text: c.text,
        provenance: JSON.parse(c.provenance) as Provenance,
      });
    }
    return out;
  }

  #toFragment(text: string, provenanceJson: string, source: string | null): Fragment {
    const frag: Fragment = { text, provenance: JSON.parse(provenanceJson) as Provenance };
    if (source !== null) frag.source = source;
    return frag;
  }
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
  return ep;
}
