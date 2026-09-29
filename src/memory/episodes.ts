/**
 * Episode lifecycle (Phase 5). An episode is a time-bounded slice of the timeline, cut on
 * an inactivity gap. Episodes are housekeeping, NOT conversations — the model never sees a
 * boundary as a reset (MEMORY.md §2.2).
 *
 * EpisodeManager.beginTurn() is called once at the start of each turn:
 *   - continues the active episode if the gap since last activity is small, or
 *   - closes the idle episode (summarize → gated/audited memory.write → index) and opens a
 *     fresh one.
 */
import { randomUUID } from "node:crypto";
import type { Database as DB, Statement } from "better-sqlite3";
import type { Episode, EpisodeSummarizer, MemoryStore, Tagger, Timeline } from "./types.ts";
import type { CanonicalPromoter } from "./promoter.ts";

/** Default inactivity gap that closes an episode (30 min). */
export const DEFAULT_GAP_MS = 30 * 60_000;

interface StateRow {
  active_episode_id: string | null;
  last_active_at: string | null;
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

/** Manages the agent_state cursor and the episodes table (the raw open/close mechanics). */
export class EpisodeStore {
  #getState: Statement;
  #initState: Statement;
  #setState: Statement;
  #insEpisode: Statement;
  #closeEpisode: Statement;
  #getEpisode: Statement;

  constructor(db: DB) {
    this.#getState = db.prepare(`SELECT active_episode_id, last_active_at FROM agent_state WHERE id = 1`);
    this.#initState = db.prepare(`INSERT OR IGNORE INTO agent_state(id) VALUES (1)`);
    this.#setState = db.prepare(`UPDATE agent_state SET active_episode_id = ?, last_active_at = ? WHERE id = 1`);
    this.#insEpisode = db.prepare(`INSERT INTO episodes(id, start_seq, end_seq, started_at) VALUES (?, ?, NULL, ?)`);
    this.#closeEpisode = db.prepare(`UPDATE episodes SET end_seq = ?, ended_at = ? WHERE id = ?`);
    this.#getEpisode = db.prepare(`SELECT * FROM episodes WHERE id = ?`);
    this.#initState.run();
  }

  /**
   * Ensure an active episode exists for `nowIso`. If idle longer than `gapMs`, close the
   * current one (stamping end_seq/ended_at) and open a fresh one. Returns the active id and
   * any episode that just closed (for the caller to summarize + index).
   */
  tick(nowIso: string, gapMs: number, latestSeq: number): { activeId: string; closed: Episode | null } {
    const state = this.#getState.get() as StateRow | undefined;
    const activeId = state?.active_episode_id ?? null;
    const lastActive = state?.last_active_at ?? null;

    const idle =
      activeId === null ||
      lastActive === null ||
      Date.parse(nowIso) - Date.parse(lastActive) > gapMs;

    if (!idle) {
      this.#setState.run(activeId, nowIso);
      return { activeId: activeId!, closed: null };
    }

    let closed: Episode | null = null;
    if (activeId !== null) {
      this.#closeEpisode.run(latestSeq, nowIso, activeId);
      const row = this.#getEpisode.get(activeId) as EpisodeRow | undefined;
      if (row) closed = toEpisode(row);
    }

    const newId = `ep_${randomUUID()}`;
    this.#insEpisode.run(newId, latestSeq + 1, nowIso);
    this.#setState.run(newId, nowIso);
    return { activeId: newId, closed };
  }
}

export interface EpisodeManagerDeps {
  db: DB;
  timeline: Timeline;
  store: MemoryStore;
  summarizer: EpisodeSummarizer;
  gapMs?: number;
  /** Optional canonical auto-write — promotes durable facts from a closed episode. */
  promoter?: CanonicalPromoter;
  /** Audit seam — fired when a closed episode is distilled into memory (a behavior-changing write). */
  onMemoryWrite?: (e: { episodeId: string; summary: string; salientFacts: string[]; lines: number; pinned: string[] }) => void;
  /**
   * Keyword tagger (the lens TagRegistry). Applied to the distilled summary + salient facts — the
   * same text retagEpisodes() uses — so an episode's derived tags are always recomputable.
   */
  tagger?: () => Tagger;
}

export class EpisodeManager {
  readonly #episodes: EpisodeStore;
  readonly #timeline: Timeline;
  readonly #store: MemoryStore;
  readonly #summarizer: EpisodeSummarizer;
  readonly #gapMs: number;
  readonly #promoter: CanonicalPromoter | undefined;
  readonly #onMemoryWrite: EpisodeManagerDeps["onMemoryWrite"];
  readonly #tagger: EpisodeManagerDeps["tagger"];

  constructor(deps: EpisodeManagerDeps) {
    this.#episodes = new EpisodeStore(deps.db);
    this.#timeline = deps.timeline;
    this.#store = deps.store;
    this.#summarizer = deps.summarizer;
    this.#gapMs = deps.gapMs ?? DEFAULT_GAP_MS;
    this.#promoter = deps.promoter;
    this.#onMemoryWrite = deps.onMemoryWrite;
    this.#tagger = deps.tagger;
  }

  /** Call at the start of a turn. Rolls the episode over if idle; returns the active id. */
  async beginTurn(nowIso: string): Promise<string> {
    const latestSeq = this.#timeline.lastSeq();
    const { activeId, closed } = this.#episodes.tick(nowIso, this.#gapMs, latestSeq);
    if (closed && closed.endSeq !== null) {
      await this.#finalize(closed);
    }
    return activeId;
  }

  async #finalize(closed: Episode): Promise<void> {
    const lines = this.#timeline.range(closed.startSeq, closed.endSeq ?? closed.startSeq);
    if (lines.length === 0) return;
    const { summary, salientFacts } = await this.#summarizer.summarize(lines);
    const lenses = [...new Set(lines.map((l) => l.lens).filter((l): l is string => !!l))];
    const tags = this.#tagger ? [...new Set(this.#tagger()([summary, ...salientFacts].join("\n")))].sort() : [];
    // Gated/audited memory.write: distilling an episode changes future behavior.
    await this.#store.index({ ...closed, summary, salientFacts, tags, lenses }, lines);
    // Canonical auto-write: promote durable, trusted facts from this episode.
    const pinned = this.#promoter ? (await this.#promoter.promoteFromLines(lines)).map((f) => f.key) : [];
    this.#onMemoryWrite?.({ episodeId: closed.id, summary, salientFacts, lines: lines.length, pinned });
  }
}

function toEpisode(r: EpisodeRow): Episode {
  const ep: Episode = { id: r.id, startSeq: r.start_seq, endSeq: r.end_seq, startedAt: r.started_at };
  if (r.ended_at !== null) ep.endedAt = r.ended_at;
  if (r.summary !== null) ep.summary = r.summary;
  if (r.salient_facts !== null) ep.salientFacts = JSON.parse(r.salient_facts) as string[];
  return ep;
}
