import { db, nowIso } from './db.ts';
import type { MediaType } from './db.ts';
import { castRole, getCast, savePerson } from './tmdb.ts';

/**
 * Builds the person <-> title index.
 *
 * The question "how many things I've watched is this actor in?" would cost one
 * TMDB call per face if answered live — unusable for a 30-person cast grid. So
 * we pay that cost once, when a title enters the library, and every later
 * lookup becomes a local SQL count.
 */

/**
 * How much of a cast to index, and in what priority.
 *
 * Billing order is the wrong ranking for television. TMDB's aggregate credits
 * order a long-running show by something close to overall prominence, which
 * buries recurring guests: Scott Adsit is billed 538th in Veep despite nine
 * episodes, and 501st in The Office. Both are exactly the "wait, where do I
 * know them from?" connection this app exists to catch, and a billing-based
 * cutoff at any sane depth throws them away.
 *
 * So TV is ranked by episode count first — time on screen is what makes a face
 * recognisable — and only falls back to billing to break ties. Films have no
 * episode count, so billing is all there is.
 *
 * This is the index, not what gets displayed. Being generous costs a few tens
 * of thousands of SQLite rows and nothing else.
 */
const MAX_MOVIE_CAST = 80;
const MAX_TV_CAST = 500;

interface QueueItem {
  tmdbId: number;
  mediaType: MediaType;
}

export interface IndexProgress {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  errors: number;
  lastError: string | null;
}

const queue: QueueItem[] = [];
const queued = new Set<string>();
let working = false;

const progress: IndexProgress = {
  running: false,
  done: 0,
  total: 0,
  current: null,
  errors: 0,
  lastError: null,
};

const key = (tmdbId: number, mediaType: MediaType) => `${mediaType}:${tmdbId}`;

const isIndexed = db.prepare(
  'SELECT 1 FROM indexed_titles WHERE tmdb_id = ? AND media_type = ?',
);
const markIndexed = db.prepare(
  `INSERT INTO indexed_titles (tmdb_id, media_type, indexed_at, cast_count)
   VALUES (?, ?, ?, ?)
   ON CONFLICT (tmdb_id, media_type) DO UPDATE SET
     indexed_at = excluded.indexed_at,
     cast_count = excluded.cast_count`,
);
const clearCredits = db.prepare(
  'DELETE FROM credits WHERE tmdb_id = ? AND media_type = ?',
);
const insertCredit = db.prepare(
  `INSERT INTO credits (person_id, tmdb_id, media_type, character_name, episode_count, billing_order)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT (person_id, tmdb_id, media_type) DO UPDATE SET
     character_name = COALESCE(excluded.character_name, credits.character_name),
     episode_count  = COALESCE(excluded.episode_count, credits.episode_count),
     billing_order  = COALESCE(excluded.billing_order, credits.billing_order)`,
);

/** Add a title to the indexing queue unless it's already done or pending. */
export function queueForIndexing(
  tmdbId: number,
  mediaType: MediaType,
  force = false,
): void {
  const id = key(tmdbId, mediaType);
  if (queued.has(id)) return;
  if (!force && isIndexed.get(tmdbId, mediaType)) return;
  queued.add(id);
  queue.push({ tmdbId, mediaType });
  progress.total++;
  void startWorker();
}

/**
 * Forget what's been indexed and rebuild from scratch. Needed after changing
 * the cast-selection rules, since existing rows were built under the old ones.
 */
export function rebuildIndex(): number {
  db.exec('DELETE FROM indexed_titles');
  return queueUnindexedLibrary();
}

/** Queue every watched title that has never been indexed. Safe to call anytime. */
export function queueUnindexedLibrary(): number {
  const rows = db
    .prepare(
      `SELECT DISTINCT w.tmdb_id, w.media_type
         FROM watched w
         LEFT JOIN indexed_titles i
           ON i.tmdb_id = w.tmdb_id AND i.media_type = w.media_type
        WHERE i.tmdb_id IS NULL`,
    )
    .all() as { tmdb_id: number; media_type: MediaType }[];

  for (const row of rows) queueForIndexing(row.tmdb_id, row.media_type);
  return rows.length;
}

async function indexOne(item: QueueItem): Promise<void> {
  const titleRow = db
    .prepare('SELECT name FROM titles WHERE tmdb_id = ? AND media_type = ?')
    .get(item.tmdbId, item.mediaType) as { name: string } | undefined;
  progress.current = titleRow?.name ?? `${item.mediaType} ${item.tmdbId}`;

  const cast = await getCast(item.tmdbId, item.mediaType);
  const isTv = item.mediaType === 'tv';

  const ranked = cast
    .map((member) => ({ member, ...castRole(member) }))
    .sort((a, b) => {
      if (isTv) {
        const byEpisodes = (b.episodeCount ?? 0) - (a.episodeCount ?? 0);
        if (byEpisodes !== 0) return byEpisodes;
      }
      return (a.member.order ?? 99999) - (b.member.order ?? 99999);
    })
    .slice(0, isTv ? MAX_TV_CAST : MAX_MOVIE_CAST);

  // Replace rather than merge, so the index reflects only what TMDB says now
  // and re-indexing after a rule change actually drops what no longer belongs.
  clearCredits.run(item.tmdbId, item.mediaType);

  for (const { member, character, episodeCount } of ranked) {
    savePerson(member);
    insertCredit.run(
      member.id,
      item.tmdbId,
      item.mediaType,
      character,
      episodeCount,
      member.order ?? null,
    );
  }

  markIndexed.run(item.tmdbId, item.mediaType, nowIso(), ranked.length);
}

async function startWorker(): Promise<void> {
  if (working) return;
  working = true;
  progress.running = true;

  try {
    while (queue.length > 0) {
      // Small batches in parallel — TMDB is fine with it and it turns a
      // thousand-title backfill from ~15 minutes into a couple.
      const batch = queue.splice(0, 6);
      await Promise.all(
        batch.map(async (item) => {
          try {
            await indexOne(item);
          } catch (err) {
            progress.errors++;
            progress.lastError = `${progress.current}: ${
              err instanceof Error ? err.message : String(err)
            }`;
          } finally {
            queued.delete(key(item.tmdbId, item.mediaType));
            progress.done++;
          }
        }),
      );
    }
  } finally {
    working = false;
    progress.running = false;
    progress.current = null;
    // Reset counters once idle so the next run starts from zero.
    if (queue.length === 0) {
      progress.done = 0;
      progress.total = 0;
    }
  }
}

export function getIndexProgress(): IndexProgress {
  return { ...progress, total: Math.max(progress.total, progress.done) };
}

/** Wait for the queue to drain — used by the CLI sync script. */
export async function waitForIndexer(): Promise<void> {
  while (working || queue.length > 0) {
    await new Promise((r) => setTimeout(r, 250));
  }
}
