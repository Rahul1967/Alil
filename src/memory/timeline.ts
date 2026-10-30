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
  TimelineAttachment,
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
  attachments: string | null;
  turn_id?: string | null;
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
  if (r.attachments) line.attachments = JSON.parse(r.attachments) as TimelineAttachment[];
  if (r.turn_id) line.turnId = r.turn_id;
  return line;
}

export class SqliteTimeline implements Timeline {
  #ins: Statement;
  #recent: Statement;
  #since: Statement;
  #range: Statement;
  #max: Statement;
  #attachments: Statement;
  #findAttachment: Statement;

  constructor(db: DB) {
    this.#ins = db.prepare(
      `INSERT INTO timeline(at, channel, provenance, episode_id, role, text, tool_calls, tool_results, lens, attachments, turn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#recent = db.prepare(`SELECT * FROM timeline ORDER BY seq DESC LIMIT ?`);
    this.#since = db.prepare(`SELECT * FROM timeline WHERE seq > ? ORDER BY seq ASC`);
    this.#range = db.prepare(`SELECT * FROM timeline WHERE seq >= ? AND seq <= ? ORDER BY seq ASC`);
    this.#max = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM timeline`);
    this.#findAttachment = db.prepare(
      `SELECT attachments, provenance FROM timeline WHERE attachments LIKE ? ORDER BY seq DESC`,
    );
    this.#attachments = db.prepare(
      `SELECT attachments FROM timeline WHERE episode_id = ? AND attachments IS NOT NULL ORDER BY seq ASC`,
    );
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
      line.attachments && line.attachments.length > 0 ? JSON.stringify(line.attachments) : null,
      line.turnId ?? null,
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

  findAttachment(path: string): (TimelineAttachment & { origin: string }) | null {
    // Candidate rows by substring, then an exact match on the parsed record (paths are
    // [a-z0-9./-] only, so the LIKE pattern needs no escaping beyond the JSON quotes).
    const rows = this.#findAttachment.all(`%${JSON.stringify(path)}%`) as { attachments: string; provenance: string }[];
    for (const r of rows) {
      const hit = (JSON.parse(r.attachments) as TimelineAttachment[]).find((a) => a.path === path);
      if (hit) return { ...hit, origin: (JSON.parse(r.provenance) as Provenance).origin };
    }
    return null;
  }

  attachmentsIn(episodeId: string): TimelineAttachment[] {
    return (this.#attachments.all(episodeId) as { attachments: string }[])
      .flatMap((r) => JSON.parse(r.attachments) as TimelineAttachment[]);
  }
}
