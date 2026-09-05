import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.ts';

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;
`);

db.exec(`
  -- Every title we've learned about from TMDB, watched or not.
  CREATE TABLE IF NOT EXISTS titles (
    tmdb_id       INTEGER NOT NULL,
    media_type    TEXT    NOT NULL CHECK (media_type IN ('movie', 'tv')),
    imdb_id       TEXT,
    name          TEXT    NOT NULL,
    year          INTEGER,
    poster_path   TEXT,
    backdrop_path TEXT,
    overview      TEXT,
    popularity    REAL    NOT NULL DEFAULT 0,
    updated_at    TEXT    NOT NULL,
    PRIMARY KEY (tmdb_id, media_type)
  );
  CREATE INDEX IF NOT EXISTS idx_titles_imdb ON titles (imdb_id);

  -- Your library. A title can arrive from several sources independently, so the
  -- source is part of the key rather than something we overwrite.
  CREATE TABLE IF NOT EXISTS watched (
    tmdb_id     INTEGER NOT NULL,
    media_type  TEXT    NOT NULL,
    source      TEXT    NOT NULL,
    rating      REAL,
    watched_at  TEXT,
    source_ref  TEXT,
    created_at  TEXT    NOT NULL,
    PRIMARY KEY (tmdb_id, media_type, source)
  );
  CREATE INDEX IF NOT EXISTS idx_watched_lookup ON watched (tmdb_id, media_type);
  CREATE INDEX IF NOT EXISTS idx_watched_ref    ON watched (source, source_ref);

  CREATE TABLE IF NOT EXISTS people (
    tmdb_id      INTEGER PRIMARY KEY,
    name         TEXT    NOT NULL,
    profile_path TEXT,
    popularity   REAL    NOT NULL DEFAULT 0,
    updated_at   TEXT    NOT NULL
  );

  -- The inverted index that makes the whole app fast: person <-> title, built at
  -- import time so overlap questions are a local SQL count, never a network call.
  CREATE TABLE IF NOT EXISTS credits (
    person_id      INTEGER NOT NULL,
    tmdb_id        INTEGER NOT NULL,
    media_type     TEXT    NOT NULL,
    character_name TEXT,
    episode_count  INTEGER,
    billing_order  INTEGER,
    PRIMARY KEY (person_id, tmdb_id, media_type)
  );
  CREATE INDEX IF NOT EXISTS idx_credits_title  ON credits (tmdb_id, media_type);
  CREATE INDEX IF NOT EXISTS idx_credits_person ON credits (person_id);

  -- Which titles have had their cast pulled, so the indexer can resume.
  CREATE TABLE IF NOT EXISTS indexed_titles (
    tmdb_id    INTEGER NOT NULL,
    media_type TEXT    NOT NULL,
    indexed_at TEXT    NOT NULL,
    cast_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tmdb_id, media_type)
  );

  -- Import rows we could not confidently match to TMDB, surfaced in the UI fixer.
  CREATE TABLE IF NOT EXISTS unresolved (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT    NOT NULL,
    raw_title  TEXT    NOT NULL,
    raw_year   INTEGER,
    raw_ref    TEXT    NOT NULL,
    media_hint TEXT,
    rating     REAL,
    watched_at TEXT,
    status     TEXT    NOT NULL DEFAULT 'pending',
    created_at TEXT    NOT NULL,
    UNIQUE (source, raw_ref)
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    source      TEXT PRIMARY KEY,
    last_run_at TEXT,
    last_ok_at  TEXT,
    status      TEXT,
    message     TEXT,
    cursor      TEXT
  );

  CREATE TABLE IF NOT EXISTS tmdb_cache (
    url        TEXT    PRIMARY KEY,
    body       TEXT    NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Collapses multi-source rows into one row per title.
  CREATE VIEW IF NOT EXISTS library AS
    SELECT
      tmdb_id,
      media_type,
      MAX(rating)                    AS rating,
      MAX(watched_at)                AS watched_at,
      GROUP_CONCAT(DISTINCT source)  AS sources
    FROM watched
    GROUP BY tmdb_id, media_type;
`);

export type MediaType = 'movie' | 'tv';

export function nowIso(): string {
  return new Date().toISOString();
}

/** Read a persisted setting, falling back to the given default. */
export function getSetting(key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function markSync(
  source: string,
  status: 'running' | 'ok' | 'error',
  message = '',
): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO sync_state (source, last_run_at, last_ok_at, status, message)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (source) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_ok_at  = CASE WHEN excluded.status = 'ok' THEN excluded.last_run_at ELSE sync_state.last_ok_at END,
       status      = excluded.status,
       message     = excluded.message`,
  ).run(source, now, status === 'ok' ? now : null, status, message);
}
