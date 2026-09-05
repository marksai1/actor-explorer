import { db, nowIso } from './db.ts';
import type { MediaType } from './db.ts';
import { pickBest } from './match.ts';
import type { Candidate } from './match.ts';
import {
  findByImdbId,
  getDetail,
  nameOf,
  saveTitle,
  searchByType,
  yearOf,
} from './tmdb.ts';
import type { WatchEvent, SyncResult } from './sources/types.ts';
import { emptyResult } from './sources/types.ts';
import { queueForIndexing } from './indexer.ts';

/**
 * Turns raw watch events into library rows.
 *
 * Resolution runs in descending order of certainty:
 *   1. a TMDB id the source already knew (Letterboxd RSS)
 *   2. an IMDb `tt` const, resolved exactly via TMDB's find endpoint
 *   3. title + year search, accepted only when the match is unambiguous
 *
 * Anything that falls through lands in `unresolved` for one-click fixing in the
 * UI rather than being guessed at.
 */

const selectExistingRef = db.prepare(
  'SELECT tmdb_id, media_type FROM watched WHERE source = ? AND source_ref = ?',
);

const upsertWatched = db.prepare(
  `INSERT INTO watched (tmdb_id, media_type, source, rating, watched_at, source_ref, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (tmdb_id, media_type, source) DO UPDATE SET
     rating     = COALESCE(excluded.rating, watched.rating),
     watched_at = COALESCE(excluded.watched_at, watched.watched_at),
     source_ref = excluded.source_ref`,
);

const insertUnresolved = db.prepare(
  `INSERT INTO unresolved (source, raw_title, raw_year, raw_ref, media_hint, rating, watched_at, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
   ON CONFLICT (source, raw_ref) DO NOTHING`,
);

const clearUnresolved = db.prepare(
  `UPDATE unresolved SET status = 'resolved' WHERE source = ? AND raw_ref = ?`,
);

async function resolveEvent(
  event: WatchEvent,
): Promise<{ tmdbId: number; mediaType: MediaType } | null> {
  // 1. Source gave us the id outright.
  if (event.tmdbId && event.mediaType) {
    return { tmdbId: event.tmdbId, mediaType: event.mediaType };
  }

  // 2. IMDb const — an exact mapping, no guessing.
  if (event.imdbId) {
    const found = await findByImdbId(event.imdbId);
    if (found) {
      saveTitle(found.item, found.mediaType, event.imdbId);
      return { tmdbId: found.item.id, mediaType: found.mediaType };
    }
    return null;
  }

  // 3. Title + year. Search whichever media types are plausible.
  const types: MediaType[] = event.mediaType ? [event.mediaType] : ['movie', 'tv'];
  const candidates: (Candidate & { mediaType: MediaType })[] = [];

  for (const type of types) {
    const results = await searchByType(event.title, type, event.year ?? undefined);
    for (const result of results.slice(0, 8)) {
      candidates.push({
        id: result.id,
        name: nameOf(result),
        year: yearOf(result),
        popularity: result.popularity ?? 0,
        voteCount: result.vote_count ?? 0,
        mediaType: type,
      });
    }
  }

  const outcome = pickBest(event.title, event.year, candidates);
  if (!outcome.confident || !outcome.candidate) return null;

  const winner = candidates.find((c) => c.id === outcome.candidate!.id);
  if (!winner) return null;

  // Pull detail so we store the imdb id and artwork alongside.
  const detail = await getDetail(winner.id, winner.mediaType);
  saveTitle(detail, winner.mediaType, detail.external_ids?.imdb_id ?? null);
  return { tmdbId: winner.id, mediaType: winner.mediaType };
}

/** Ensure a title row exists before we reference it from `watched`. */
async function ensureTitle(tmdbId: number, mediaType: MediaType): Promise<void> {
  const existing = db
    .prepare('SELECT 1 FROM titles WHERE tmdb_id = ? AND media_type = ?')
    .get(tmdbId, mediaType);
  if (existing) return;
  const detail = await getDetail(tmdbId, mediaType);
  saveTitle(detail, mediaType, detail.external_ids?.imdb_id ?? null);
}

export async function ingestEvents(
  events: WatchEvent[],
  source: string,
  log: (message: string) => void = () => {},
): Promise<SyncResult> {
  const result = emptyResult();
  let sinceLog = 0;

  for (const event of events) {
    result.scanned++;

    // Already resolved this exact source row on a previous run — just refresh
    // the rating/date, skipping all network work. This is what makes repeat
    // syncs cheap.
    const known = selectExistingRef.get(source, event.sourceRef) as
      | { tmdb_id: number; media_type: MediaType }
      | undefined;
    if (known) {
      upsertWatched.run(
        known.tmdb_id,
        known.media_type,
        source,
        event.rating ?? null,
        event.watchedAt ?? null,
        event.sourceRef,
        nowIso(),
      );
      result.updated++;
      continue;
    }

    let resolved: { tmdbId: number; mediaType: MediaType } | null = null;
    try {
      resolved = await resolveEvent(event);
    } catch (err) {
      log(`  ! ${event.title}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!resolved) {
      insertUnresolved.run(
        source,
        event.title,
        event.year ?? null,
        event.sourceRef,
        event.mediaType ?? null,
        event.rating ?? null,
        event.watchedAt ?? null,
        nowIso(),
      );
      result.unresolved++;
      continue;
    }

    try {
      await ensureTitle(resolved.tmdbId, resolved.mediaType);
    } catch {
      // Non-fatal: we know the id, artwork can be backfilled later.
    }

    upsertWatched.run(
      resolved.tmdbId,
      resolved.mediaType,
      source,
      event.rating ?? null,
      event.watchedAt ?? null,
      event.sourceRef,
      nowIso(),
    );
    clearUnresolved.run(source, event.sourceRef);
    queueForIndexing(resolved.tmdbId, resolved.mediaType);
    result.added++;

    if (++sinceLog >= 25) {
      sinceLog = 0;
      log(`  … ${result.scanned}/${events.length} (${result.added} new)`);
    }
  }

  return result;
}

/** Manually attach an unresolved row to a specific TMDB title. */
export async function resolveManually(
  unresolvedId: number,
  tmdbId: number,
  mediaType: MediaType,
): Promise<void> {
  const row = db.prepare('SELECT * FROM unresolved WHERE id = ?').get(unresolvedId) as
    | {
        source: string;
        raw_ref: string;
        rating: number | null;
        watched_at: string | null;
      }
    | undefined;
  if (!row) throw new Error('No such unresolved entry');

  await ensureTitle(tmdbId, mediaType);
  upsertWatched.run(
    tmdbId,
    mediaType,
    row.source,
    row.rating,
    row.watched_at,
    row.raw_ref,
    nowIso(),
  );
  db.prepare(`UPDATE unresolved SET status = 'resolved' WHERE id = ?`).run(unresolvedId);
  queueForIndexing(tmdbId, mediaType);
}
