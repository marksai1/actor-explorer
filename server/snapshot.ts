import { db } from './db.ts';
import type { MediaType } from './db.ts';
import { config } from './config.ts';

/**
 * The offline snapshot.
 *
 * Everything the app can answer without a network call — your library, the cast
 * index, and the ratings and dates the ranking runs on — flattened into one
 * file the phone can hold. The live TMDB calls (a person's biography, the
 * dimmed "rest of their work" section) have no offline equivalent and are
 * simply absent; the UI already renders correctly without them.
 *
 * Rows are positional arrays rather than objects. Repeating twelve key names
 * across 23,000 credits is most of the file otherwise, and this is written once
 * and read once by code that sits next to it.
 */

export const SNAPSHOT_VERSION = 1;

/** movie -> 0, tv -> 1. */
const TYPE_CODE: Record<MediaType, number> = { movie: 0, tv: 1 };

export type TitleRow = [
  tmdbId: number,
  type: number,
  name: string,
  year: number | null,
  posterPath: string | null,
  backdropPath: string | null,
  overview: string,
  popularity: number,
  inLibrary: 0 | 1,
  rating: number | null,
  watchedAt: string | null,
  sources: string,
];

export type PersonRow = [id: number, name: string, profilePath: string | null];

/** The title is referenced by its index in `titles`, not by (id, type). */
export type CreditRow = [
  personId: number,
  titleIndex: number,
  character: string | null,
  episodeCount: number | null,
  billingOrder: number | null,
];

export interface Snapshot {
  version: number;
  generatedAt: string;
  /**
   * The TMDB key, carried inside the encrypted payload rather than compiled
   * into the bundle.
   *
   * The published app needs it to reach anything outside your library, and a
   * static host has nowhere to hide a secret at runtime. Putting it here means
   * the one thing already guarding your library guards this too: what gets
   * published is the app, which contains nothing, and one opaque blob. Empty
   * when TMDB_API_KEY is unset, which yields an offline-only build.
   */
  tmdbKey: string;
  counts: { movies: number; shows: number; people: number; indexed: number };
  sources: { id: string; lastOkAt: string | null; titleCount: number }[];
  titles: TitleRow[];
  people: PersonRow[];
  credits: CreditRow[];
}

export function buildSnapshot(): Snapshot {
  const titleRows = db
    .prepare(
      `SELECT t.tmdb_id, t.media_type, t.name, t.year, t.poster_path, t.backdrop_path,
              t.overview, t.popularity,
              l.rating, l.watched_at, l.sources
         FROM titles t
         LEFT JOIN library l ON l.tmdb_id = t.tmdb_id AND l.media_type = t.media_type
        ORDER BY t.tmdb_id, t.media_type`,
    )
    .all() as {
    tmdb_id: number;
    media_type: MediaType;
    name: string;
    year: number | null;
    poster_path: string | null;
    backdrop_path: string | null;
    overview: string | null;
    popularity: number | null;
    rating: number | null;
    watched_at: string | null;
    sources: string | null;
  }[];

  const titles: TitleRow[] = [];
  const titleIndex = new Map<string, number>();

  for (const row of titleRows) {
    titleIndex.set(`${row.media_type}:${row.tmdb_id}`, titles.length);
    titles.push([
      row.tmdb_id,
      TYPE_CODE[row.media_type],
      row.name,
      row.year,
      row.poster_path,
      row.backdrop_path,
      row.overview ?? '',
      row.popularity ?? 0,
      row.sources ? 1 : 0,
      row.rating,
      row.watched_at,
      row.sources ?? '',
    ]);
  }

  // Only credits pointing at a title we shipped are usable on the other side.
  const creditRows = db
    .prepare(
      `SELECT person_id, tmdb_id, media_type, character_name, episode_count, billing_order
         FROM credits`,
    )
    .all() as {
    person_id: number;
    tmdb_id: number;
    media_type: MediaType;
    character_name: string | null;
    episode_count: number | null;
    billing_order: number | null;
  }[];

  const credits: CreditRow[] = [];
  const wanted = new Set<number>();

  for (const row of creditRows) {
    const index = titleIndex.get(`${row.media_type}:${row.tmdb_id}`);
    if (index === undefined) continue;
    wanted.add(row.person_id);
    credits.push([
      row.person_id,
      index,
      row.character_name,
      row.episode_count,
      row.billing_order,
    ]);
  }

  const people: PersonRow[] = (
    db.prepare('SELECT tmdb_id, name, profile_path FROM people ORDER BY tmdb_id').all() as {
      tmdb_id: number;
      name: string;
      profile_path: string | null;
    }[]
  )
    .filter((person) => wanted.has(person.tmdb_id))
    .map((person) => [person.tmdb_id, person.name, person.profile_path]);

  const counts = db
    .prepare('SELECT media_type, COUNT(*) AS n FROM library GROUP BY media_type')
    .all() as { media_type: MediaType; n: number }[];
  const indexed = db.prepare('SELECT COUNT(*) AS n FROM indexed_titles').get() as { n: number };

  const sources = (
    db.prepare('SELECT source, last_ok_at FROM sync_state').all() as {
      source: string;
      last_ok_at: string | null;
    }[]
  ).map((row) => {
    const counted = db
      .prepare('SELECT COUNT(DISTINCT tmdb_id || media_type) AS n FROM watched WHERE source = ?')
      .get(row.source) as { n: number };
    return { id: row.source, lastOkAt: row.last_ok_at, titleCount: counted.n };
  });

  return {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    tmdbKey: config.tmdbKey,
    counts: {
      movies: counts.find((c) => c.media_type === 'movie')?.n ?? 0,
      shows: counts.find((c) => c.media_type === 'tv')?.n ?? 0,
      people: people.length,
      indexed: indexed.n,
    },
    sources,
    titles,
    people,
    credits,
  };
}
