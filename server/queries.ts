import { db } from './db.ts';
import type { MediaType } from './db.ts';
import { img } from './config.ts';
import { scoreCredit } from './scoring.ts';
import {
  getCast,
  getDetail,
  getPerson,
  getPersonCredits,
  nameOf,
  savePerson,
  saveTitle,
  searchMulti,
  searchPeople,
  yearOf,
  castRole,
} from './tmdb.ts';
import { queueForIndexing } from './indexer.ts';

/**
 * The read side. Everything the actor page needs comes out of local SQL — the
 * cast index built at import time is what makes that possible.
 */

export interface TitleCard {
  tmdbId: number;
  mediaType: MediaType;
  name: string;
  year: number | null;
  poster: string | null;
  watched: boolean;
  rating: number | null;
}

const watchedLookup = db.prepare(
  'SELECT rating FROM library WHERE tmdb_id = ? AND media_type = ?',
);

function watchedInfo(tmdbId: number, mediaType: MediaType): { watched: boolean; rating: number | null } {
  const row = watchedLookup.get(tmdbId, mediaType) as { rating: number | null } | undefined;
  return { watched: Boolean(row), rating: row?.rating ?? null };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface PersonCard {
  personId: number;
  name: string;
  photo: string | null;
  knownFor: string | null;
  /** How many of your watched titles they appear in — a local count, instant. */
  seenCount: number;
}

const seenCountFor = db.prepare(
  `SELECT COUNT(*) AS n
     FROM credits c
     JOIN watched w ON w.tmdb_id = c.tmdb_id AND w.media_type = c.media_type
    WHERE c.person_id = ?`,
);

function toPersonCard(person: {
  id: number;
  name: string;
  profile_path?: string | null;
  known_for_department?: string;
}): PersonCard {
  const counted = seenCountFor.get(person.id) as { n: number };
  return {
    personId: person.id,
    name: person.name,
    photo: img(person.profile_path, 'w185'),
    knownFor: person.known_for_department ?? null,
    seenCount: counted.n,
  };
}

export async function search(
  query: string,
): Promise<{ titles: TitleCard[]; people: PersonCard[] }> {
  const { titles, people } = await searchMulti(query);

  const titleCards = titles
    .map((r) => {
      const mediaType = r.media_type as MediaType;
      const info = watchedInfo(r.id, mediaType);
      return {
        tmdbId: r.id,
        mediaType,
        name: nameOf(r),
        year: yearOf(r),
        poster: img(r.poster_path, 'w342'),
        watched: info.watched,
        rating: info.rating,
      };
    })
    .sort((a, b) => Number(b.watched) - Number(a.watched));

  // People you've actually seen come first — that's the whole point.
  const peopleCards = people
    .map(toPersonCard)
    .sort((a, b) => b.seenCount - a.seenCount);

  return { titles: titleCards, people: peopleCards };
}

/** Dedicated person search, for when the multi-search is drowned out by titles. */
export async function searchPersons(query: string): Promise<PersonCard[]> {
  const people = await searchPeople(query);
  return people.map(toPersonCard).sort((a, b) => b.seenCount - a.seenCount);
}

// ---------------------------------------------------------------------------
// Title page
// ---------------------------------------------------------------------------

export interface CastEntry {
  personId: number;
  name: string;
  photo: string | null;
  character: string | null;
  episodeCount: number | null;
  billingOrder: number | null;
  /** How many titles in *your* library this person appears in. */
  seenCount: number;
}

const overlapCount = db.prepare(
  `SELECT COUNT(*) AS n
     FROM credits c
     JOIN watched w ON w.tmdb_id = c.tmdb_id AND w.media_type = c.media_type
    WHERE c.person_id = ?
      AND NOT (c.tmdb_id = ? AND c.media_type = ?)`,
);

export async function getTitle(tmdbId: number, mediaType: MediaType) {
  const detail = await getDetail(tmdbId, mediaType);
  saveTitle(detail, mediaType, detail.external_ids?.imdb_id ?? null);

  const cast = await getCast(tmdbId, mediaType);
  // Viewing a title indexes it too, so the library's overlap data keeps
  // improving as you browse.
  queueForIndexing(tmdbId, mediaType);

  const entries: CastEntry[] = cast
    .slice()
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, 40)
    .map((member) => {
      savePerson(member);
      const { character, episodeCount } = castRole(member);
      const counted = overlapCount.get(member.id, tmdbId, mediaType) as { n: number };
      return {
        personId: member.id,
        name: member.name,
        photo: img(member.profile_path, 'w185'),
        character,
        episodeCount,
        billingOrder: member.order ?? null,
        seenCount: counted.n,
      };
    });

  const info = watchedInfo(tmdbId, mediaType);

  return {
    tmdbId,
    mediaType,
    name: nameOf(detail),
    year: yearOf(detail),
    overview: detail.overview ?? '',
    poster: img(detail.poster_path, 'w342'),
    backdrop: img(detail.backdrop_path, 'w1280'),
    watched: info.watched,
    rating: info.rating,
    cast: entries,
  };
}

// ---------------------------------------------------------------------------
// Person page — the payoff
// ---------------------------------------------------------------------------

export interface OverlapEntry extends TitleCard {
  character: string | null;
  episodeCount: number | null;
  billingOrder: number | null;
  watchedAt: string | null;
  sources: string[];
  score: number;
  basis: string;
}

const personOverlap = db.prepare(
  `SELECT t.tmdb_id, t.media_type, t.name, t.year, t.poster_path, t.popularity,
          c.character_name, c.episode_count, c.billing_order,
          l.rating, l.watched_at, l.sources
     FROM credits c
     JOIN titles  t ON t.tmdb_id = c.tmdb_id AND t.media_type = c.media_type
     JOIN library l ON l.tmdb_id = c.tmdb_id AND l.media_type = c.media_type
    WHERE c.person_id = ?`,
);

export async function getPersonPage(personId: number) {
  const person = await getPerson(personId);
  savePerson(person);

  const rows = personOverlap.all(personId) as {
    tmdb_id: number;
    media_type: MediaType;
    name: string;
    year: number | null;
    poster_path: string | null;
    popularity: number | null;
    character_name: string | null;
    episode_count: number | null;
    billing_order: number | null;
    rating: number | null;
    watched_at: string | null;
    sources: string | null;
  }[];

  const seen: OverlapEntry[] = rows
    .map((row) => {
      const { score, basis } = scoreCredit({
        mediaType: row.media_type,
        billingOrder: row.billing_order,
        episodeCount: row.episode_count,
        rating: row.rating,
        watchedAt: row.watched_at,
        popularity: row.popularity,
      });
      return {
        tmdbId: row.tmdb_id,
        mediaType: row.media_type,
        name: row.name,
        year: row.year,
        poster: img(row.poster_path, 'w342'),
        watched: true,
        rating: row.rating,
        character: row.character_name,
        episodeCount: row.episode_count,
        billingOrder: row.billing_order,
        watchedAt: row.watched_at,
        sources: (row.sources ?? '').split(',').filter(Boolean),
        score,
        basis,
      };
    })
    .sort((a, b) => b.score - a.score);

  // Only the dimmed "rest of their work" section needs a live call.
  const seenKeys = new Set(seen.map((s) => `${s.mediaType}:${s.tmdbId}`));
  const credits = await getPersonCredits(personId);

  const rest: TitleCard[] = credits
    .filter((credit) => {
      const mediaType = credit.media_type as MediaType | undefined;
      if (mediaType !== 'movie' && mediaType !== 'tv') return false;
      return !seenKeys.has(`${mediaType}:${credit.id}`);
    })
    .map((credit) => ({
      tmdbId: credit.id,
      mediaType: credit.media_type as MediaType,
      name: nameOf(credit),
      year: yearOf(credit),
      poster: img(credit.poster_path, 'w185'),
      watched: false,
      rating: null,
    }))
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

  return {
    personId,
    name: person.name,
    photo: img(person.profile_path, 'h632'),
    biography: person.biography ?? '',
    knownFor: person.known_for_department ?? null,
    seen,
    rest,
  };
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export function libraryStats() {
  const counts = db
    .prepare(
      `SELECT media_type, COUNT(*) AS n FROM library GROUP BY media_type`,
    )
    .all() as { media_type: MediaType; n: number }[];

  const people = db.prepare('SELECT COUNT(DISTINCT person_id) AS n FROM credits').get() as {
    n: number;
  };
  const indexed = db.prepare('SELECT COUNT(*) AS n FROM indexed_titles').get() as { n: number };
  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM unresolved WHERE status = 'pending'`)
    .get() as { n: number };

  return {
    movies: counts.find((c) => c.media_type === 'movie')?.n ?? 0,
    shows: counts.find((c) => c.media_type === 'tv')?.n ?? 0,
    people: people.n,
    indexed: indexed.n,
    unresolved: pending.n,
  };
}

export function recentlyWatched(limit = 24): TitleCard[] {
  const rows = db
    .prepare(
      `SELECT t.tmdb_id, t.media_type, t.name, t.year, t.poster_path, l.rating
         FROM library l
         JOIN titles t ON t.tmdb_id = l.tmdb_id AND t.media_type = l.media_type
        WHERE l.watched_at IS NOT NULL
        ORDER BY l.watched_at DESC
        LIMIT ?`,
    )
    .all(limit) as {
    tmdb_id: number;
    media_type: MediaType;
    name: string;
    year: number | null;
    poster_path: string | null;
    rating: number | null;
  }[];

  return rows.map((row) => ({
    tmdbId: row.tmdb_id,
    mediaType: row.media_type,
    name: row.name,
    year: row.year,
    poster: img(row.poster_path, 'w342'),
    watched: true,
    rating: row.rating,
  }));
}

export function libraryTitles(options: {
  mediaType?: MediaType;
  query?: string;
  limit?: number;
  offset?: number;
}): { items: TitleCard[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (options.mediaType) {
    where.push('l.media_type = ?');
    params.push(options.mediaType);
  }
  if (options.query) {
    where.push('t.name LIKE ?');
    params.push(`%${options.query}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM library l
         JOIN titles t ON t.tmdb_id = l.tmdb_id AND t.media_type = l.media_type ${clause}`,
    )
    .get(...params) as { n: number };

  const rows = db
    .prepare(
      `SELECT t.tmdb_id, t.media_type, t.name, t.year, t.poster_path, l.rating
         FROM library l
         JOIN titles t ON t.tmdb_id = l.tmdb_id AND t.media_type = l.media_type
         ${clause}
        ORDER BY COALESCE(l.watched_at, '') DESC, t.name
        LIMIT ? OFFSET ?`,
    )
    .all(...params, options.limit ?? 60, options.offset ?? 0) as {
    tmdb_id: number;
    media_type: MediaType;
    name: string;
    year: number | null;
    poster_path: string | null;
    rating: number | null;
  }[];

  return {
    total: total.n,
    items: rows.map((row) => ({
      tmdbId: row.tmdb_id,
      mediaType: row.media_type,
      name: row.name,
      year: row.year,
      poster: img(row.poster_path, 'w342'),
      watched: true,
      rating: row.rating,
    })),
  };
}

export function unresolvedRows() {
  return db
    .prepare(
      `SELECT id, source, raw_title, raw_year, raw_ref, media_hint, rating, watched_at
         FROM unresolved WHERE status = 'pending'
        ORDER BY raw_title LIMIT 300`,
    )
    .all() as {
    id: number;
    source: string;
    raw_title: string;
    raw_year: number | null;
    raw_ref: string;
    media_hint: string | null;
    rating: number | null;
    watched_at: string | null;
  }[];
}
