import type { MediaType } from '../db.ts';
import type { WatchEvent } from './types.ts';

/**
 * IMDb, read straight from IMDb's own GraphQL backend — no login, no browser,
 * no export, no session to expire.
 *
 * `www.imdb.com` sits behind an Amazon WAF that CAPTCHAs anything automated,
 * signed in or not, headless or headed. `api.graphql.imdb.com` does not: it
 * answers a plain anonymous `fetch`. And its title search takes constraints
 * scoped to *a named user* rather than the caller —
 * `singleUserWatchedConstraint { userId }` — so a `ur…` id is all that's needed
 * to read someone's history, exactly the way a public Letterboxd profile works.
 *
 * The only gate is IMDb's own privacy setting. When it's off, the API says so
 * in as many words ("User's watch history is not public"), which is why the
 * errors below are translated into the setting to go and change.
 *
 * This is an internal endpoint rather than a documented product, and IMDb's
 * responses carry a non-commercial-use disclaimer. It can move without notice —
 * the CSV drop on the Library page stays as the backstop for that day.
 */

const ENDPOINT = 'https://api.graphql.imdb.com/';

/** 500 is accepted, but 250 keeps a single response comfortably small. */
const PAGE_SIZE = 250;

const HEADERS = {
  'content-type': 'application/json',
  'x-imdb-client-name': 'imdb-web-next',
  'x-imdb-user-country': 'US',
  'x-imdb-user-language': 'en-US',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An error IMDb itself reported, as opposed to a transport failure. */
export class ImdbApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImdbApiError';
  }
}

/**
 * Accepts anything a person might paste: `ur12345678`, the id with stray case,
 * or a whole profile URL. Returns null when there's no `ur…` id in there at all.
 *
 * Note the `p.<hash>` profile id that IMDb now shows in its own URLs does *not*
 * work as a `userId` — the API returns null for it — so only the `ur…` form is
 * accepted here rather than silently failing later.
 */
export function normaliseImdbUserId(raw: string): string | null {
  return /\b(ur\d{6,})\b/i.exec(raw.trim())?.[1]?.toLowerCase() ?? null;
}

interface SearchPage {
  advancedTitleSearch: {
    total: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: {
      node: {
        title: {
          id: string;
          titleText: { text: string } | null;
          titleType: { id: string } | null;
          releaseYear: { year: number | null } | null;
          userRating: { value: number | null; date: string | null } | null;
        };
      };
    }[];
  } | null;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  let lastTransportError = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      lastTransportError = err instanceof Error ? err.message : String(err);
      await sleep(1000 * (attempt + 1));
      continue;
    }

    // Throttling and their own 5xx are worth another go; anything else is not.
    if (res.status === 429 || res.status >= 500) {
      lastTransportError = `IMDb responded ${res.status}`;
      await sleep(1000 * (attempt + 1));
      continue;
    }

    const text = await res.text();
    let body: { data?: T; errors?: { message: string }[] };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new ImdbApiError(
        `IMDb returned something that wasn't JSON (HTTP ${res.status}). The API may have moved.`,
      );
    }

    if (body.errors?.length) {
      throw new ImdbApiError(body.errors[0]?.message ?? 'IMDb rejected the request.');
    }
    if (!body.data) throw new ImdbApiError('IMDb returned an empty response.');
    return body.data;
  }

  throw new Error(`Could not reach IMDb's API: ${lastTransportError}`);
}

/**
 * Restate IMDb's refusals as the setting to go and change, since every one of
 * them is a privacy toggle rather than anything wrong with the app.
 */
function explain(message: string): string {
  if (/watch history is not public/i.test(message)) {
    return (
      'Your IMDb watch history is private. Open imdb.com → Account Settings → ' +
      'Privacy and set "Watch history" to public, then sync again.'
    );
  }
  if (/ratings are private/i.test(message)) {
    return (
      'Your IMDb ratings are private. Open imdb.com → Account Settings → ' +
      'Privacy and set "Ratings" to public, then sync again.'
    );
  }
  if (/CustomerId required/i.test(message)) {
    return 'IMDB_USER_ID looks wrong — it must be your own `ur…` id.';
  }
  return message;
}

/** IMDb title types that aren't screen performances worth indexing. */
const SKIP_TYPES = new Set(['videogame', 'podcastseries', 'podcastepisode', 'musicvideo']);

/**
 * Map IMDb's title type onto our two media types. Mirrors the CSV parser's
 * rules, against the API's camelCase ids rather than the export's prose labels.
 */
function mediaHint(typeId: string): MediaType | undefined {
  const t = typeId.toLowerCase();
  if (!t) return undefined;
  // `tvMovie` is a film despite the prefix, so movie is tested first.
  if (t.includes('movie') || t === 'short' || t === 'video') return 'movie';
  if (t.includes('episode') || t.includes('series') || t.startsWith('tv')) return 'tv';
  return undefined;
}

type Mode = 'watched' | 'rated';

const MODES: Record<Mode, { constraint: string; sort: string; label: string }> = {
  watched: {
    constraint: 'singleUserWatchedConstraint: { userId: $u, filterType: INCLUDE }',
    sort: 'SINGLE_USER_WATCHED_DATE',
    label: 'watch history',
  },
  rated: {
    constraint: 'singleUserRatingConstraint: { userId: $u, filterType: INCLUDE }',
    sort: 'SINGLE_USER_RATING_DATE',
    label: 'ratings',
  },
};

/**
 * `userRating` rides along on the watched query, so the common case is one
 * request that returns every title *and* the score on the ones that have it.
 */
const pageQuery = (mode: Mode): string => `
  query($u: ID!, $after: String) {
    advancedTitleSearch(
      first: ${PAGE_SIZE}
      after: $after
      sort: { sortBy: ${MODES[mode].sort}, sortOrder: DESC }
      constraints: { ${MODES[mode].constraint} }
    ) {
      total
      pageInfo { hasNextPage endCursor }
      edges { node { title {
        id
        titleText { text }
        titleType { id }
        releaseYear { year }
        userRating(userId: $u) { value date }
      } } }
    }
  }`;

async function fetchMode(
  userId: string,
  mode: Mode,
  log: (message: string) => void,
): Promise<WatchEvent[]> {
  const events: WatchEvent[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  let page = 0;

  do {
    const data: SearchPage = await gql<SearchPage>(pageQuery(mode), { u: userId, after });
    const search = data.advancedTitleSearch;
    if (!search) break;

    if (page === 0) log(`  ${MODES[mode].label}: ${search.total} titles`);

    for (const edge of search.edges) {
      const title = edge.node.title;
      if (seen.has(title.id)) continue;
      seen.add(title.id);
      if (SKIP_TYPES.has((title.titleType?.id ?? '').toLowerCase())) continue;

      events.push({
        imdbId: title.id,
        mediaType: mediaHint(title.titleType?.id ?? ''),
        title: title.titleText?.text ?? title.id,
        year: title.releaseYear?.year ?? null,
        // IMDb ratings are already on the 1–10 scale the library stores.
        rating: title.userRating?.value ?? null,
        // A rating date is the only date IMDb exposes for another user; a plain
        // check-in carries none, which ingest is happy to take as null.
        watchedAt: title.userRating?.date?.slice(0, 10) ?? null,
        // The `tt` const, so API rows and dropped-CSV rows dedupe against each
        // other rather than double-counting.
        sourceRef: title.id,
      });
    }

    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
    page++;
    if (after) log(`  … ${events.length} so far`);
  } while (after && page < 200);

  return events;
}

/**
 * Everything IMDb will tell us about this user, publicly.
 *
 * Watch history is the superset — IMDb defines it as everything watched, rated,
 * reviewed or checked into — so ratings are only queried separately when watch
 * history is private, which is the one case that set wouldn't already cover.
 */
export async function fetchPublicLibrary(
  userId: string,
  log: (message: string) => void,
): Promise<WatchEvent[]> {
  try {
    return await fetchMode(userId, 'watched', log);
  } catch (err) {
    if (!(err instanceof ImdbApiError) || !/watch history is not public/i.test(err.message)) {
      throw new Error(err instanceof Error ? explain(err.message) : String(err));
    }
    log('  watch history is private — falling back to ratings only');
    try {
      return await fetchMode(userId, 'rated', log);
    } catch (inner) {
      throw new Error(
        inner instanceof ImdbApiError
          ? `${explain(err.message)} (Ratings are private too.)`
          : String(inner),
      );
    }
  }
}

/** What each half of the public profile currently exposes. Used by `doctor`. */
export async function checkPublicProfile(
  userId: string,
): Promise<{ watched: number | null; rated: number | null; notes: string[] }> {
  const notes: string[] = [];
  const count = async (mode: Mode): Promise<number | null> => {
    try {
      const data = await gql<SearchPage>(
        `query($u: ID!) {
           advancedTitleSearch(first: 1, constraints: { ${MODES[mode].constraint} }) { total }
         }`,
        { u: userId },
      );
      return data.advancedTitleSearch?.total ?? 0;
    } catch (err) {
      notes.push(explain(err instanceof Error ? err.message : String(err)));
      return null;
    }
  };

  return { watched: await count('watched'), rated: await count('rated'), notes };
}
