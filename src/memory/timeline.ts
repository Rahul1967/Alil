/**
 * SqliteTimeline — the global append-only log (MEMORY.md §4, Phase 1).
 * seq is assigned by SQLite (AUTOINCREMENT), giving a total order across all channels.
 */
import type { Database as DB, Statement } from "better-sqlite3";
import type { Provenance } from "../core/types.ts";
import type {
  Timeline,
  TimelineLine,
  NewTimelineLine,
  TimelineRole,
} from "./types.ts";

interface RawRow {
  seq: number;
  at: string;
  channel: string;
  provenance: string;
  episode_id: string;
  role: string;
  text: string | null;
  tool_calls: string | null;
  tool_results: string | null;
  lens: string | null;
}

function toLine(r: RawRow): TimelineLine {
  const line: TimelineLine = {
    seq: r.seq,
    at: r.at,
    channel: r.channel,
    provenance: JSON.parse(r.provenance) as Provenance,
    episodeId: r.episode_id,
    role: r.role as TimelineRole,
  };
  if (r.text !== null) line.text = r.text;
  if (r.tool_calls !== null) line.toolCalls = JSON.parse(r.tool_calls);
  if (r.tool_results !== null) line.toolResults = JSON.parse(r.tool_results);
  if (r.lens) line.lens = r.lens;
  return line;
}

export class SqliteTimeline implements Timeline {
  #ins: Statement;
  #recent: Statement;
  #since: Statement;
  #range: Statement;
  #max: Statement;

  constructor(db: DB) {
    this.#ins = db.prepare(
      `INSERT INTO timeline(at, channel, provenance, episode_id, role, text, tool_calls, tool_results, lens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#recent = db.prepare(`SELECT * FROM timeline ORDER BY seq DESC LIMIT ?`);
    this.#since = db.prepare(`SELECT * FROM timeline WHERE seq > ? ORDER BY seq ASC`);
    this.#range = db.prepare(`SELECT * FROM timeline WHERE seq >= ? AND seq <= ? ORDER BY seq ASC`);
    this.#max = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM timeline`);
  }

  append(line: NewTimelineLine): number {
    const r = this.#ins.run(
      line.at,
      line.channel,
      JSON.stringify(line.provenance),
      line.episodeId,
      line.role,
      line.text ?? null,
      line.toolCalls !== undefined ? JSON.stringify(line.toolCalls) : null,
      line.toolResults !== undefined ? JSON.stringify(line.toolResults) : null,
      line.lens ?? null,
    );
    return Number(r.lastInsertRowid);
  }

  workingSet(n: number): TimelineLine[] {
    const rows = this.#recent.all(n) as RawRow[];
    return rows.reverse().map(toLine);
  }

  since(seq: number): TimelineLine[] {
    return (this.#since.all(seq) as RawRow[]).map(toLine);
  }

  range(fromSeq: number, toSeq: number): TimelineLine[] {
    return (this.#range.all(fromSeq, toSeq) as RawRow[]).map(toLine);
  }

  lastSeq(): number {
    return (this.#max.get() as { m: number }).m;
  }
}
