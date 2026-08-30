/**
 * ProspectiveStore — durable storage for future-directed intentions (MEMORY.md §7b).
 *
 * The model creates an intention via a tool; this table is the source of truth. A scheduler
 * polls `due()` (time triggers) and a channel matcher calls `matchEvent()` (event triggers).
 * Firing is a claim-then-deliver handshake: `claim()` flips pending→firing atomically so a
 * crash can't double-fire, and `recoverStale()` reclaims rows whose delivery died mid-flight.
 */
import { randomUUID } from "node:crypto";
import type { Database as DB, Statement } from "better-sqlite3";
import type { Provenance } from "../core/types.ts";
import type {
  Intention, NewIntention, IntentionStatus, IntentionTrigger, EventMatch, IncomingEvent,
} from "./types.ts";

interface IntentionRow {
  id: string;
  title: string;
  action: string;
  kind: string;
  trigger: string;
  fire_at: number | null;
  cron_expr: string | null;
  event_match: string | null;
  status: string;
  dedup_key: string | null;
  expires_at: number | null;
  created_at: number;
  fired_at: number | null;
  attempts: number;
  provenance: string;
}

/** case-insensitive substring test; an absent needle matches anything. */
function contains(haystack: string | undefined, needle: string | undefined): boolean {
  if (needle === undefined) return true;
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

export class ProspectiveStore {
  readonly #db: DB;
  #ins: Statement;
  #get: Statement;
  #getByDedup: Statement;
  #due: Statement;
  #pendingEvents: Statement;
  #claim: Statement;
  #toDone: Statement;
  #reschedule: Statement;
  #cancel: Statement;
  #snooze: Statement;
  #done: Statement;
  #list: Statement;
  #recover: Statement;
  #expire: Statement;

  constructor(db: DB) {
    this.#db = db;
    this.#ins = db.prepare(
      `INSERT INTO intention(id, title, action, kind, trigger, fire_at, cron_expr, event_match,
                             status, dedup_key, expires_at, created_at, fired_at, attempts, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, 0, ?)`,
    );
    this.#get = db.prepare(`SELECT * FROM intention WHERE id = ?`);
    this.#getByDedup = db.prepare(`SELECT * FROM intention WHERE dedup_key = ?`);
    this.#due = db.prepare(
      `SELECT * FROM intention
       WHERE status = 'pending' AND trigger IN ('once','cron')
         AND fire_at IS NOT NULL AND fire_at <= ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY fire_at ASC`,
    );
    this.#pendingEvents = db.prepare(
      `SELECT * FROM intention WHERE status = 'pending' AND trigger = 'event'
         AND (expires_at IS NULL OR expires_at > ?)`,
    );
    this.#claim = db.prepare(
      `UPDATE intention SET status = 'firing', fired_at = ?, attempts = attempts + 1
       WHERE id = ? AND status = 'pending'`,
    );
    this.#toDone = db.prepare(`UPDATE intention SET status = 'done' WHERE id = ?`);
    this.#reschedule = db.prepare(
      `UPDATE intention SET status = 'pending', fire_at = ? WHERE id = ?`,
    );
    this.#cancel = db.prepare(
      `UPDATE intention SET status = 'cancelled' WHERE id = ? AND status IN ('pending','firing')`,
    );
    // Snooze: re-arm to a new fire time (works from pending/firing, and from done — "remind me
    // again in an hour" after it already fired). A cron item resumes its schedule after the snooze fire.
    this.#snooze = db.prepare(
      `UPDATE intention SET status = 'pending', fire_at = ? WHERE id = ? AND status IN ('pending','firing','done')`,
    );
    // Done: acknowledge/complete an intention (distinct from cancel = "don't want it").
    this.#done = db.prepare(`UPDATE intention SET status = 'done' WHERE id = ? AND status IN ('pending','firing')`);
    this.#list = db.prepare(`SELECT * FROM intention ORDER BY created_at DESC LIMIT ?`);
    this.#recover = db.prepare(
      `UPDATE intention SET status = 'pending' WHERE status = 'firing' AND fired_at < ?`,
    );
    this.#expire = db.prepare(
      `UPDATE intention SET status = 'expired'
       WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
    );
  }

  /** Create an intention. If its dedup_key already exists, returns the existing row unchanged. */
  create(n: NewIntention): { intention: Intention; created: boolean } {
    if (n.dedupKey) {
      const existing = this.#getByDedup.get(n.dedupKey) as IntentionRow | undefined;
      if (existing) return { intention: toIntention(existing), created: false };
    }
    const id = randomUUID();
    this.#ins.run(
      id,
      n.title,
      n.action,
      n.kind ?? "reminder",
      n.trigger,
      n.fireAt ?? null,
      n.cronExpr ?? null,
      n.eventMatch ? JSON.stringify(n.eventMatch) : null,
      n.dedupKey ?? null,
      n.expiresAt ?? null,
      Date.now(),
      JSON.stringify(n.provenance),
    );
    return { intention: toIntention(this.#get.get(id) as IntentionRow), created: true };
  }

  get(id: string): Intention | null {
    const r = this.#get.get(id) as IntentionRow | undefined;
    return r ? toIntention(r) : null;
  }

  /** Time-triggered intentions due at or before `now` (catch-up drains ones missed while down). */
  due(now: number): Intention[] {
    return (this.#due.all(now, now) as IntentionRow[]).map(toIntention);
  }

  /** Pending event intentions whose predicate matches the incoming event. */
  matchEvent(event: IncomingEvent, now: number): Intention[] {
    const rows = this.#pendingEvents.all(now) as IntentionRow[];
    return rows.map(toIntention).filter((i) => {
      const m = i.eventMatch;
      if (!m) return false;
      // Time window: the predicate is only live within [after, before). Lets an event trigger be
      // gated to a date ("only when we chat on Oct 5") — outside the window it never matches.
      if (m.after !== undefined && now < m.after) return false;
      if (m.before !== undefined && now >= m.before) return false;
      return (
        contains(event.channel, m.channel) &&
        contains(event.type, m.type) &&
        contains(event.from, m.from) &&
        contains(event.subject, m.subject) &&
        contains(event.text, m.contains)
      );
    });
  }

  /** Atomically claim a pending intention for firing. False if already claimed/gone. */
  claim(id: string, now: number): boolean {
    return this.#claim.run(now, id).changes === 1;
  }

  /** Mark a fired intention done (one-shot). */
  markDone(id: string): void {
    this.#toDone.run(id);
  }

  /** Re-arm a recurring intention for its next fire time. */
  reschedule(id: string, fireAt: number): void {
    this.#reschedule.run(fireAt, id);
  }

  cancel(id: string): boolean {
    return this.#cancel.run(id).changes >= 1;
  }

  /** Re-arm an intention to fire at `until` (epoch ms). "Remind me again later." */
  snooze(id: string, until: number): boolean {
    return this.#snooze.run(until, id).changes >= 1;
  }

  /** Mark an intention acknowledged/complete. Returns false if it wasn't live. */
  done(id: string): boolean {
    return this.#done.run(id).changes >= 1;
  }

  list(limit = 100): Intention[] {
    return (this.#list.all(limit) as IntentionRow[]).map(toIntention);
  }

  /** Reclaim rows stuck in 'firing' (delivery crashed) older than `staleBefore`. Returns count. */
  recoverStale(staleBefore: number): number {
    return this.#recover.run(staleBefore).changes;
  }

  /** Expire pending intentions past their expiry. Returns count. */
  expireOverdue(now: number): number {
    return this.#expire.run(now).changes;
  }
}

function toIntention(r: IntentionRow): Intention {
  return {
    id: r.id,
    title: r.title,
    action: r.action,
    kind: (r.kind ?? "reminder") as Intention["kind"],
    trigger: r.trigger as IntentionTrigger,
    fireAt: r.fire_at,
    cronExpr: r.cron_expr,
    eventMatch: r.event_match ? (JSON.parse(r.event_match) as EventMatch) : null,
    status: r.status as IntentionStatus,
    dedupKey: r.dedup_key,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    firedAt: r.fired_at,
    attempts: r.attempts,
    provenance: JSON.parse(r.provenance) as Provenance,
  };
}
