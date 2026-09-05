import { db, nowIso } from './db.ts';
import { config } from './config.ts';
import type { MediaType } from './db.ts';
import { nameOf, yearOf } from './tmdb-shapes.ts';
import type {
  PersonCredit,
  TmdbCastMember,
  TmdbPersonResult,
  TmdbTitle,
} from './tmdb-shapes.ts';

// The shapes and their pure readers live next door so the browser build can
// share them; callers still import them from here.
export * from './tmdb-shapes.ts';

const BASE = 'https://api.themoviedb.org/3';

/** Cache lifetimes, in ms. Mappings that never change get long ones. */
const TTL = {
  find: 90 * 864e5, // an IMDb id points at the same TMDB entry forever
  detail: 30 * 864e5,
  credits: 30 * 864e5,
  person: 7 * 864e5,
  search: 7 * 864e5,
} as const;

/**
 * Caps concurrent outbound requests. TMDB tolerates far more than this, but
 * staying modest keeps the indexer from saturating a home connection.
 */
class Limiter {
  #active = 0;
  #queue: (() => void)[] = [];
  #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#max) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }
}

const limiter = new Limiter(12);

export class TmdbError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TmdbError';
    this.status = status;
  }
}

function cacheGet(url: string, ttl: number): unknown | undefined {
  const row = db
    .prepare('SELECT body, fetched_at FROM tmdb_cache WHERE url = ?')
    .get(url) as { body: string; fetched_at: number } | undefined;
  if (!row) return undefined;
  if (Date.now() - row.fetched_at > ttl) return undefined;
  try {
    return JSON.parse(row.body);
  } catch {
    return undefined;
  }
}

function cacheSet(url: string, value: unknown): void {
  db.prepare(
    `INSERT INTO tmdb_cache (url, body, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT (url) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
  ).run(url, JSON.stringify(value), Date.now());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a TMDB endpoint, serving from the disk cache when fresh.
 * Retries on 429 (honouring Retry-After) and on transient 5xx.
 */
export async function tmdb<T = any>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  ttl: number = TTL.detail,
): Promise<T> {
  if (!config.tmdbKey) {
    throw new TmdbError('TMDB_API_KEY is not set — add it to your .env file.', 500);
  }

  const url = new URL(`${BASE}/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  // Cache key excludes the api key so rotating it doesn't blow the whole cache away.
  const cacheKey = url.toString();
  const cached = cacheGet(cacheKey, ttl);
  if (cached !== undefined) return cached as T;

  url.searchParams.set('api_key', config.tmdbKey);

  return limiter.run(async () => {
    let lastError = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { accept: 'application/json' } });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await sleep(500 * 2 ** attempt);
        continue;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? 1);
        await sleep((Number.isFinite(retryAfter) ? retryAfter : 1) * 1000 + 250);
        continue;
      }
      if (res.status >= 500) {
        lastError = `TMDB ${res.status}`;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new TmdbError(
          res.status === 401
            ? 'TMDB rejected the API key. Check TMDB_API_KEY in your .env file.'
            : `TMDB ${res.status}: ${body.slice(0, 200)}`,
          res.status,
        );
      }

      const json = (await res.json()) as T;
      cacheSet(cacheKey, json);
      return json;
    }
    throw new TmdbError(`TMDB request failed after retries: ${lastError}`, 503);
  });
}

// ---------------------------------------------------------------------------
// Shapes — only the fields this app actually reads.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Endpoint wrappers
// ---------------------------------------------------------------------------

/** Multi-search, split into titles and people. */
export async function searchMulti(query: string): Promise<{
  titles: TmdbTitle[];
  people: TmdbPersonResult[];
}> {
  const res = await tmdb<{ results: (TmdbTitle & TmdbPersonResult)[] }>(
    'search/multi',
    { query, include_adult: 'false' },
    TTL.search,
  );
  const results = res.results ?? [];
  return {
    titles: results.filter((r) => r.media_type === 'movie' || r.media_type === 'tv'),
    people: results.filter((r) => r.media_type === 'person') as TmdbPersonResult[],
  };
}

export async function searchPeople(query: string): Promise<TmdbPersonResult[]> {
  const res = await tmdb<{ results: TmdbPersonResult[] }>(
    'search/person',
    { query, include_adult: 'false' },
    TTL.search,
  );
  return res.results ?? [];
}

export async function searchByType(
  query: string,
  mediaType: MediaType,
  year?: number,
): Promise<TmdbTitle[]> {
  const params: Record<string, string | number | undefined> = {
    query,
    include_adult: 'false',
  };
  if (year) {
    if (mediaType === 'movie') params.primary_release_year = year;
    else params.first_air_date_year = year;
  }
  const res = await tmdb<{ results: TmdbTitle[] }>(
    `search/${mediaType}`,
    params,
    TTL.search,
  );
  return (res.results ?? []).map((r) => ({ ...r, media_type: mediaType }));
}

/** Exact IMDb id -> TMDB entry. No fuzzy matching involved. */
export async function findByImdbId(
  imdbId: string,
): Promise<{ item: TmdbTitle; mediaType: MediaType } | null> {
  const res = await tmdb<{
    movie_results: TmdbTitle[];
    tv_results: TmdbTitle[];
    tv_episode_results: (TmdbTitle & { show_id?: number })[];
  }>(`find/${imdbId}`, { external_source: 'imdb_id' }, TTL.find);

  const movie = res.movie_results?.[0];
  if (movie) return { item: { ...movie, media_type: 'movie' }, mediaType: 'movie' };
  const tv = res.tv_results?.[0];
  if (tv) return { item: { ...tv, media_type: 'tv' }, mediaType: 'tv' };

  // Rating a single episode on IMDb still means you watched the show, so
  // resolve episode consts up to their parent series.
  const showId = res.tv_episode_results?.[0]?.show_id;
  if (showId) {
    const show = await getDetail(showId, 'tv');
    return { item: { ...show, media_type: 'tv' }, mediaType: 'tv' };
  }
  return null;
}

export async function getDetail(
  tmdbId: number,
  mediaType: MediaType,
): Promise<TmdbTitle & { external_ids?: { imdb_id?: string | null } }> {
  return tmdb(`${mediaType}/${tmdbId}`, { append_to_response: 'external_ids' }, TTL.detail);
}

/**
 * Cast for a title. TV uses aggregate_credits, which rolls a performer's whole
 * run into one entry with an episode count — the signal that tells "series
 * regular" apart from "one-scene guest".
 */
export async function getCast(
  tmdbId: number,
  mediaType: MediaType,
): Promise<TmdbCastMember[]> {
  const endpoint = mediaType === 'tv' ? 'aggregate_credits' : 'credits';
  const res = await tmdb<{ cast: TmdbCastMember[] }>(
    `${mediaType}/${tmdbId}/${endpoint}`,
    {},
    TTL.credits,
  );
  return res.cast ?? [];
}

export async function getPerson(personId: number): Promise<{
  id: number;
  name: string;
  profile_path?: string | null;
  biography?: string;
  known_for_department?: string;
  popularity?: number;
  birthday?: string | null;
  place_of_birth?: string | null;
}> {
  return tmdb(`person/${personId}`, {}, TTL.person);
}

export async function getPersonCredits(personId: number): Promise<PersonCredit[]> {
  const res = await tmdb<{ cast: PersonCredit[] }>(
    `person/${personId}/combined_credits`,
    {},
    TTL.person,
  );
  return res.cast ?? [];
}

/** Upsert a title row from any TMDB payload we happen to have. */
export function saveTitle(item: TmdbTitle, mediaType: MediaType, imdbId?: string | null): void {
  db.prepare(
    `INSERT INTO titles (tmdb_id, media_type, imdb_id, name, year, poster_path, backdrop_path, overview, popularity, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tmdb_id, media_type) DO UPDATE SET
       imdb_id       = COALESCE(excluded.imdb_id, titles.imdb_id),
       name          = excluded.name,
       year          = COALESCE(excluded.year, titles.year),
       poster_path   = COALESCE(excluded.poster_path, titles.poster_path),
       backdrop_path = COALESCE(excluded.backdrop_path, titles.backdrop_path),
       overview      = COALESCE(excluded.overview, titles.overview),
       popularity    = excluded.popularity,
       updated_at    = excluded.updated_at`,
  ).run(
    item.id,
    mediaType,
    imdbId ?? null,
    nameOf(item),
    yearOf(item),
    item.poster_path ?? null,
    item.backdrop_path ?? null,
    item.overview ?? null,
    item.popularity ?? 0,
    nowIso(),
  );
}

export function savePerson(person: {
  id: number;
  name: string;
  profile_path?: string | null;
  popularity?: number;
}): void {
  db.prepare(
    `INSERT INTO people (tmdb_id, name, profile_path, popularity, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tmdb_id) DO UPDATE SET
       name         = excluded.name,
       profile_path = COALESCE(excluded.profile_path, people.profile_path),
       popularity   = excluded.popularity,
       updated_at   = excluded.updated_at`,
  ).run(person.id, person.name, person.profile_path ?? null, person.popularity ?? 0, nowIso());
}

export { TTL };
