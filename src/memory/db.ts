/**
 * Opens the memory database: loads sqlite-vec, sets crash-safe pragmas, applies the schema.
 * One file = the whole memory (MEMORY.md §2). Caller owns closing the returned handle.
 */
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { schemaSql } from "./schema.ts";

export function openMemoryDb(path: string, dim: number): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  db.exec(schemaSql(dim));
  migrate(db);
  return db;
}

/** Idempotent, additive migrations for DBs created by an earlier schema. */
function migrate(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(canonical)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "key")) {
    db.exec("ALTER TABLE canonical ADD COLUMN key TEXT");
  }
  if (!cols.some((c) => c.name === "kind")) {
    db.exec("ALTER TABLE canonical ADD COLUMN kind TEXT NOT NULL DEFAULT 'preference'");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS canonical_key ON canonical(key) WHERE key IS NOT NULL");

  // Prospective memory generalized from reminders to future-directed cognition (Phase 1).
  const icols = db.prepare("PRAGMA table_info(intention)").all() as { name: string }[];
  if (icols.length > 0 && !icols.some((c) => c.name === "kind")) {
    db.exec("ALTER TABLE intention ADD COLUMN kind TEXT NOT NULL DEFAULT 'reminder'");
  }
  if (icols.length > 0 && !icols.some((c) => c.name === "context_cue")) {
    db.exec("ALTER TABLE intention ADD COLUMN context_cue TEXT");
  }
  if (icols.length > 0 && !icols.some((c) => c.name === "nag")) {
    db.exec("ALTER TABLE intention ADD COLUMN nag INTEGER NOT NULL DEFAULT 0");
  }
  if (icols.length > 0 && !icols.some((c) => c.name === "last_surfaced_at")) {
    db.exec("ALTER TABLE intention ADD COLUMN last_surfaced_at INTEGER");
  }

  // Lenses (DESIGN §10b): tags + lens stamps across tiers, procedure status + outcome stats.
  addColumn(db, "intention", "lens", "TEXT");
  addColumn(db, "timeline", "lens", "TEXT");
  addColumn(db, "episodes", "tags", "TEXT NOT NULL DEFAULT '[]'");
  addColumn(db, "episodes", "lenses", "TEXT NOT NULL DEFAULT '[]'");
  addColumn(db, "canonical", "tags", "TEXT NOT NULL DEFAULT '[]'");
  addColumn(db, "canonical", "lens", "TEXT");
  addColumn(db, "procedure", "tags", "TEXT NOT NULL DEFAULT '[]'");
  addColumn(db, "procedure", "lens", "TEXT");
  addColumn(db, "procedure", "status", "TEXT NOT NULL DEFAULT 'active'");
  addColumn(db, "procedure", "successes", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "procedure", "failures", "INTEGER NOT NULL DEFAULT 0");
}

function addColumn(db: DB, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
