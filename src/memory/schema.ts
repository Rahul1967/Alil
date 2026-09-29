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
  tool_results TEXT,
  lens         TEXT                        -- active lens id when the line was written (null = none)
);

-- Time-bounded slices (housekeeping, not identity).
CREATE TABLE IF NOT EXISTS episodes (
  id            TEXT PRIMARY KEY,
  start_seq     INTEGER NOT NULL,
  end_seq       INTEGER,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  summary       TEXT,
  salient_facts TEXT,
  tags          TEXT NOT NULL DEFAULT '[]', -- keyword-derived tags: a rebuildable projection
  lenses        TEXT NOT NULL DEFAULT '[]'  -- lens ids active during the episode
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
  created_at TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',   -- tagged facts render only while a matching lens is active
  lens       TEXT                          -- lens stamp: where the fact was learned
);
CREATE UNIQUE INDEX IF NOT EXISTS canonical_key ON canonical(key) WHERE key IS NOT NULL;

-- Procedural memory: proven how-to methods (MEMORY.md §7a). A pulled tier — never in the
-- prompt. Two granularities: abstract_method generalizes, verbatim_steps carries the detail.
-- Only the trigger is embedded (into recall_vec with kind='procedure', ref=name) for search.
CREATE TABLE IF NOT EXISTS procedure (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  trigger         TEXT NOT NULL,
  abstract_method TEXT NOT NULL,
  verbatim_steps  TEXT NOT NULL,
  evidence        TEXT NOT NULL DEFAULT '',
  uses            INTEGER NOT NULL DEFAULT 0,
  score           REAL NOT NULL DEFAULT 0,
  last_used_at    TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  provenance      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]', -- what the method is about (approved with the write)
  lens            TEXT,                       -- lens stamp: where it was learned (harness-applied)
  status          TEXT NOT NULL DEFAULT 'active', -- active | deprecated
  successes       INTEGER NOT NULL DEFAULT 0,
  failures        INTEGER NOT NULL DEFAULT 0
);

-- Prospective memory: future-directed intentions (remember to act later). A scheduler polls
-- this table (time triggers) and a channel matcher evaluates it (event triggers); a due row
-- fires as a synthetic turn. dedup_key is UNIQUE so the same intention can't be double-scheduled.
CREATE TABLE IF NOT EXISTS intention (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  action       TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'reminder', -- reminder | fact | decision | aspiration | watch
  trigger      TEXT NOT NULL,              -- 'once' | 'cron' | 'event'
  fire_at      INTEGER,                    -- epoch ms; next fire for once/cron
  cron_expr    TEXT,                       -- recurrence, null unless cron
  event_match  TEXT,                       -- JSON predicate, null unless event
  context_cue  TEXT,                        -- relevance phrase, null unless trigger='context'
  nag          INTEGER NOT NULL DEFAULT 0,   -- 1 = re-fire until acknowledged (nag-until-done)
  last_surfaced_at INTEGER,                  -- context items: last time surfaced (cooldown)
  status       TEXT NOT NULL DEFAULT 'pending',
  dedup_key    TEXT,
  expires_at   INTEGER,
  created_at   INTEGER NOT NULL,
  fired_at     INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  provenance   TEXT NOT NULL,
  lens         TEXT                         -- lens the intention was created under; fires in it
);
CREATE UNIQUE INDEX IF NOT EXISTS intention_dedup ON intention(dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS intention_due ON intention(status, fire_at);

-- Small key/value store for channel adapter state (e.g. the Telegram getUpdates offset),
-- so a restart resumes exactly where it left off.
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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
