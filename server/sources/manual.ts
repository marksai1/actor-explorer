import { db, nowIso } from '../db.ts';
import type { MediaType } from '../db.ts';
import { getDetail, saveTitle } from '../tmdb.ts';
import { queueForIndexing } from '../indexer.ts';

/**
 * The in-app "seen it" toggle.
 *
 * You rate what you enjoyed, which means plenty of things you've actually
 * watched never make it into either export. This is the patch for that — it
 * writes under its own source so it never fights with what IMDb or Letterboxd
 * report.
 */

export const SOURCE_ID = 'manual';

export async function markWatched(
  tmdbId: number,
  mediaType: MediaType,
  watched: boolean,
): Promise<void> {
  if (!watched) {
    db.prepare(
      'DELETE FROM watched WHERE tmdb_id = ? AND media_type = ? AND source = ?',
    ).run(tmdbId, mediaType, SOURCE_ID);
    return;
  }

  const known = db
    .prepare('SELECT 1 FROM titles WHERE tmdb_id = ? AND media_type = ?')
    .get(tmdbId, mediaType);
  if (!known) {
    const detail = await getDetail(tmdbId, mediaType);
    saveTitle(detail, mediaType, detail.external_ids?.imdb_id ?? null);
  }

  db.prepare(
    `INSERT INTO watched (tmdb_id, media_type, source, rating, watched_at, source_ref, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT (tmdb_id, media_type, source) DO NOTHING`,
  ).run(
    tmdbId,
    mediaType,
    SOURCE_ID,
    nowIso().slice(0, 10),
    `${mediaType}:${tmdbId}`,
    nowIso(),
  );

  queueForIndexing(tmdbId, mediaType);
}

/** Is this title in the library from any source at all? */
export function isWatched(tmdbId: number, mediaType: MediaType): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 FROM watched WHERE tmdb_id = ? AND media_type = ? LIMIT 1')
      .get(tmdbId, mediaType),
  );
}
