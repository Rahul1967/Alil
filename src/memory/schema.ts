/**
 * DDL for the memory database (MEMORY.md §4). Applied idempotently on open.
 * Kept as a string constant (not a .sql file) so it bundles trivially for deploy.
 * `dim` is the embedder dimension and fixes the vec0 column width at create time.
 */
export function schemaSql(dim: number): string {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`schemaSql: dim must be a positive integer, got ${dim}`);
  }
  return `
-- The global log: seq is the total order across all channels.
CREATE TABLE IF NOT EXISTS timeline (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  channel      TEXT NOT NULL,
  provenance   TEXT NOT NULL,
  episode_id   TEXT NOT NULL,
  role         TEXT NOT NULL,
  text         TEXT,
  tool_calls   TEXT,
  tool_results TEXT
);

-- Time-bounded slices (housekeeping, not identity).
CREATE TABLE IF NOT EXISTS episodes (
  id            TEXT PRIMARY KEY,
  start_seq     INTEGER NOT NULL,
  end_seq       INTEGER,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  summary       TEXT,
  salient_facts TEXT
);

-- Durable pinned facts (always in context). The key column enables upsert (a changed
-- preference replaces the old value instead of piling up duplicates).
CREATE TABLE IF NOT EXISTS canonical (
  id         TEXT PRIMARY KEY,
  key        TEXT,
  kind       TEXT NOT NULL DEFAULT 'preference',
  text       TEXT NOT NULL,
  provenance TEXT NOT NULL,
  source     TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS canonical_key ON canonical(key) WHERE key IS NOT NULL;

-- Single live cursor (singleton row id = 1).
CREATE TABLE IF NOT EXISTS agent_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  active_episode_id TEXT,
  last_active_at    TEXT,
  token_spent       INTEGER NOT NULL DEFAULT 0,
  token_ceiling     INTEGER NOT NULL DEFAULT 0,
  active_grants     TEXT NOT NULL DEFAULT '[]'
);

-- Recall: vec index + metadata side table, joined by rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS recall_vec USING vec0(embedding float[${dim}]);

CREATE TABLE IF NOT EXISTS recall_chunk (
  rowid      INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  text       TEXT NOT NULL,
  provenance TEXT NOT NULL,
  source     TEXT
);

-- Lexical fallback / hybrid ranking. rowid mirrors recall_chunk.rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(text);
`;
}
