import { scoreCredit } from '../../../server/scoring.ts';
import { castRole, nameOf, yearOf } from '../../../server/tmdb-shapes.ts';
import type { PersonCredit, TmdbTitle } from '../../../server/tmdb-shapes.ts';
import * as tmdb from './tmdb';
import { setTmdbKey, tmdbAvailable } from './tmdb';
import { mediaTypeOf, titleKey, type CreditRow, type Indexed, type TitleRow } from './snapshot';
import type {
  CastEntry,
  MediaType,
  OverlapEntry,
  PersonCard,
  PersonDetail,
  SourceStatus,
  Stats,
  SyncState,
  TitleCard,
  TitleDetail,
} from '../api';

/**
 * The read side, offline.
 *
 * A straight port of `server/queries.ts` from SQL to Maps, against the snapshot
 * instead of the database. The ranking itself isn't reimplemented — this
 * imports the very same `scoreCredit`, so the phone and the desktop can't
 * disagree about where you know someone from.
 *
 * Where a connection is available it goes further than the snapshot alone can.
 * `./tmdb` reaches the whole catalogue again, so a film you have never watched
 * is searchable and its cast opens — and the badge on every face in it is still
 * a local count, because the credit index is keyed by the same TMDB person ids.
 * Every one of those paths falls back to the snapshot when the fetch fails, so
 * offline is a smaller app rather than a broken one.
 */

let library: Indexed | null = null;

export function setLibrary(next: Indexed): void {
  library = next;
  // The key rides inside the snapshot, so TMDB becomes reachable at exactly the
  // moment the library does — and not before.
  setTmdbKey(next.data.tmdbKey);
}

/** When the loaded snapshot was built, for the freshness line in Settings. */
export function snapshotGeneratedAt(): string | null {
  return library?.data.generatedAt ?? null;
}

function need(): Indexed {
  if (!library) throw new Error('The library snapshot has not been unlocked on this device yet.');
  return library;
}

const TMDB_IMAGE = 'https://image.tmdb.org/t/p';

/**
 * Posters come from TMDB's CDN, so they need a connection even though the data
 * doesn't. The service worker keeps every one you've looked at, and the UI
 * already has a placeholder for a poster it can't show.
 */
const img = (path: string | null, size: string): string | null =>
  path ? `${TMDB_IMAGE}/${size}${path}` : null;

const idle = {
  running: false,
  done: 0,
  total: 0,
  current: null,
  errors: 0,
  lastError: null,
};

const readOnly = (): never => {
  throw new Error('This is a read-only snapshot. Make the change on the machine that syncs.');
};

// ---------------------------------------------------------------------------
// Row -> card
// ---------------------------------------------------------------------------

function toTitleCard(row: TitleRow): TitleCard {
  return {
    tmdbId: row[0],
    mediaType: mediaTypeOf(row[1]),
    name: row[2],
    year: row[3],
    poster: img(row[4], 'w342'),
    watched: Boolean(row[8]),
    rating: row[9],
  };
}

function toPersonCard(id: number): PersonCard | null {
  const index = need();
  const person = index.personById.get(id);
  if (!person) return null;
  return {
    personId: person[0],
    name: person[1],
    photo: img(person[2], 'w185'),
    // TMDB's known-for department isn't in the cast index, so it isn't in the
    // snapshot either. The UI omits the line when it's missing.
    knownFor: null,
    seenCount: index.seenCount.get(id) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Substring matching over the snapshot, where the server would have asked TMDB.
 * Search therefore reaches your library and the faces in it rather than all of
 * TMDB — which is the part that works offline, and the part you want when the
 * question is "where do I know them from".
 *
 * Ranked so a prefix beats a match starting mid-word.
 */
function rank(name: string, needle: string): number {
  const haystack = name.toLowerCase();
  const at = haystack.indexOf(needle);
  if (at < 0) return -1;
  if (at === 0) return 2;
  return haystack[at - 1] === ' ' ? 1 : 0;
}

function searchTitles(query: string, limit: number): TitleCard[] {
  const index = need();
  const needle = query.toLowerCase();

  return index.data.titles
    .map((row) => ({ row, score: rank(row[2], needle) }))
    .filter((hit) => hit.score >= 0)
    .sort(
      (a, b) =>
        // Things you've watched come first — that's the whole point of the app.
        b.row[8] - a.row[8] || b.score - a.score || b.row[7] - a.row[7],
    )
    .slice(0, limit)
    .map((hit) => toTitleCard(hit.row));
}

function searchPeopleRows(query: string, limit: number): PersonCard[] {
  const index = need();
  const needle = query.toLowerCase();

  return index.data.people
    .map((person) => ({ person, score: rank(person[1], needle) }))
    .filter((hit) => hit.score >= 0)
    .sort((a, b) => {
      const seenA = index.seenCount.get(a.person[0]) ?? 0;
      const seenB = index.seenCount.get(b.person[0]) ?? 0;
      return seenB - seenA || b.score - a.score || a.person[1].localeCompare(b.person[1]);
    })
    .slice(0, limit)
    .map((hit) => toPersonCard(hit.person[0]))
    .filter((card): card is PersonCard => card !== null);
}

/** A TMDB search hit, told apart by whether the snapshot already knows it. */
function remoteTitleCard(item: TmdbTitle): TitleCard | null {
  const mediaType = item.media_type;
  if (mediaType !== 'movie' && mediaType !== 'tv') return null;

  const index = need();
  const at = index.titleIndexByKey.get(titleKey(mediaType, item.id));
  const row = at === undefined ? undefined : index.data.titles[at];

  return {
    tmdbId: item.id,
    mediaType,
    name: nameOf(item),
    year: yearOf(item),
    poster: img(item.poster_path ?? null, 'w342'),
    watched: Boolean(row?.[8]),
    rating: row?.[9] ?? null,
  };
}

/**
 * Your library first, then the rest of TMDB behind it.
 *
 * Offline, or on a snapshot carrying no key, this is the snapshot alone — which
 * finds everything you have watched and every face already indexed. With a
 * connection it also reaches the film you started twenty minutes ago.
 */
async function mergedSearch(query: string): Promise<{ titles: TitleCard[]; people: PersonCard[] }> {
  const local = { titles: searchTitles(query, 24), people: searchPeopleRows(query, 24) };
  if (!tmdbAvailable()) return local;

  try {
    const index = need();
    const remote = await tmdb.searchMulti(query);

    const titles = [...local.titles];
    const haveTitle = new Set(titles.map((t) => `${t.mediaType}:${t.tmdbId}`));
    for (const item of remote.titles) {
      const card = remoteTitleCard(item);
      if (!card) continue;
      const key = `${card.mediaType}:${card.tmdbId}`;
      if (haveTitle.has(key)) continue;
      haveTitle.add(key);
      titles.push(card);
    }

    const people = [...local.people];
    const havePerson = new Set(people.map((p) => p.personId));
    for (const person of remote.people) {
      if (havePerson.has(person.id)) continue;
      havePerson.add(person.id);
      people.push({
        personId: person.id,
        name: person.name,
        photo: img(person.profile_path ?? null, 'w185'),
        knownFor: person.known_for_department ?? null,
        seenCount: index.seenCount.get(person.id) ?? 0,
      });
    }

    // Sorting is stable, so ties keep the local-first order these arrived in.
    titles.sort((a, b) => Number(b.watched) - Number(a.watched));
    people.sort((a, b) => b.seenCount - a.seenCount);

    return { titles: titles.slice(0, 40), people: people.slice(0, 40) };
  } catch {
    return local;
  }
}

// ---------------------------------------------------------------------------
// Title page
// ---------------------------------------------------------------------------

/**
 * Billing order is a bad ranking for television — the same reason the indexer
 * sorts by episode count — so the cast grid follows the rule the index was
 * built with rather than billing for both.
 */
function castOrder(mediaType: MediaType) {
  return (a: CreditRow, b: CreditRow): number => {
    if (mediaType === 'tv') {
      const byEpisodes = (b[3] ?? 0) - (a[3] ?? 0);
      if (byEpisodes !== 0) return byEpisodes;
    }
    return (a[4] ?? 9999) - (b[4] ?? 9999);
  };
}

async function getTitle(mediaType: MediaType, tmdbId: number): Promise<TitleDetail> {
  const index = need();
  const at = index.titleIndexByKey.get(titleKey(mediaType, tmdbId));
  const row = at === undefined ? undefined : index.data.titles[at];

  // Something you have not watched, so its cast was never indexed. This is the
  // case the app exists for when you are halfway through a new film.
  if (at === undefined || !row) {
    if (!tmdbAvailable()) {
      throw new Error("That title isn't in this snapshot, and there's no connection.");
    }
    return liveTitle(mediaType, tmdbId);
  }

  const inLibrary = Boolean(row[8]);
  const cast: CastEntry[] = (index.creditsByTitle.get(at) ?? [])
    .slice()
    .sort(castOrder(mediaType))
    .slice(0, 40)
    .map((credit) => {
      const person = index.personById.get(credit[0]);
      const total = index.seenCount.get(credit[0]) ?? 0;
      return {
        personId: credit[0],
        name: person?.[1] ?? 'Unknown',
        photo: img(person?.[2] ?? null, 'w185'),
        character: credit[2],
        episodeCount: credit[3],
        billingOrder: credit[4],
        // The badge counts everything *else* you have seen them in.
        seenCount: inLibrary ? Math.max(0, total - 1) : total,
      };
    });

  return {
    tmdbId: row[0],
    mediaType,
    name: row[2],
    year: row[3],
    overview: row[6],
    poster: img(row[4], 'w342'),
    backdrop: img(row[5], 'w1280'),
    watched: inLibrary,
    rating: row[9],
    cast,
  };
}

/**
 * A title from TMDB rather than the snapshot.
 *
 * The cast is TMDB's, ordered the way the server orders it, but `seenCount` on
 * every face is still the local index — which is the whole point: you are
 * looking at a film you have never seen and asking where you know these people
 * from, and that answer has always lived on the device.
 */
async function liveTitle(mediaType: MediaType, tmdbId: number): Promise<TitleDetail> {
  const index = need();
  const [detail, cast] = await Promise.all([
    tmdb.getDetail(mediaType, tmdbId),
    tmdb.getCast(mediaType, tmdbId),
  ]);

  const entries: CastEntry[] = cast
    .slice()
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, 40)
    .map((member) => {
      const { character, episodeCount } = castRole(member);
      return {
        personId: member.id,
        name: member.name,
        photo: img(member.profile_path ?? null, 'w185'),
        character,
        episodeCount,
        billingOrder: member.order ?? null,
        seenCount: index.seenCount.get(member.id) ?? 0,
      };
    });

  return {
    tmdbId,
    mediaType,
    name: nameOf(detail),
    year: yearOf(detail),
    overview: detail.overview ?? '',
    poster: img(detail.poster_path ?? null, 'w342'),
    backdrop: img(detail.backdrop_path ?? null, 'w1280'),
    watched: false,
    rating: null,
    cast: entries,
  };
}

// ---------------------------------------------------------------------------
// Person page
// ---------------------------------------------------------------------------

/** The overlap the cast index knows about — complete for anyone it has seen. */
function localOverlap(personId: number): OverlapEntry[] {
  const index = need();
  return (index.creditsByPerson.get(personId) ?? [])
    .flatMap((credit) => {
      const row = index.data.titles[credit[1]];
      if (!row || !row[8]) return [];

      const { score, basis } = scoreCredit({
        mediaType: mediaTypeOf(row[1]),
        billingOrder: credit[4],
        episodeCount: credit[3],
        rating: row[9],
        watchedAt: row[10],
        popularity: row[7],
      });

      return [
        {
          ...toTitleCard(row),
          character: credit[2],
          episodeCount: credit[3],
          billingOrder: credit[4],
          watchedAt: row[10],
          sources: row[11].split(',').filter(Boolean),
          score,
          basis,
        },
      ];
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * The same overlap worked out from TMDB's credit list instead of the index.
 *
 * This is how a face from a film you have never watched still gets a ranked
 * "where you know them from": their filmography comes down live, and anything
 * in it that is also in your library is scored from local ratings and dates.
 */
function overlapFromCredits(credits: PersonCredit[]): OverlapEntry[] {
  const index = need();

  return credits
    .flatMap((credit) => {
      const mediaType = credit.media_type;
      if (mediaType !== 'movie' && mediaType !== 'tv') return [];

      const at = index.titleIndexByKey.get(titleKey(mediaType, credit.id));
      const row = at === undefined ? undefined : index.data.titles[at];
      if (!row || !row[8]) return [];

      const episodeCount = credit.episode_count ?? null;
      const billingOrder = credit.order ?? null;
      const { score, basis } = scoreCredit({
        mediaType,
        billingOrder,
        episodeCount,
        rating: row[9],
        watchedAt: row[10],
        popularity: row[7],
      });

      return [
        {
          ...toTitleCard(row),
          character: credit.character ?? null,
          episodeCount,
          billingOrder,
          watchedAt: row[10],
          sources: row[11].split(',').filter(Boolean),
          score,
          basis,
        },
      ];
    })
    .sort((a, b) => b.score - a.score);
}

async function getPerson(personId: number): Promise<PersonDetail> {
  const index = need();
  const local = index.personById.get(personId);

  let name = local?.[1] ?? null;
  let photo = local?.[2] ?? null;
  let biography = '';
  let knownFor: string | null = null;
  let seen = localOverlap(personId);
  let rest: TitleCard[] = [];

  if (tmdbAvailable()) {
    try {
      const [person, credits] = await Promise.all([
        tmdb.getPerson(personId),
        tmdb.getPersonCredits(personId),
      ]);

      name = person.name;
      photo = person.profile_path ?? photo;
      biography = person.biography ?? '';
      knownFor = person.known_for_department ?? null;

      // The index is authoritative when it knows them — it holds aggregated
      // episode counts that a combined-credits row does not. Fall back to
      // TMDB's list only for someone it has never indexed.
      if (seen.length === 0) seen = overlapFromCredits(credits);

      const already = new Set(seen.map((entry) => `${entry.mediaType}:${entry.tmdbId}`));
      rest = credits
        .flatMap((credit): TitleCard[] => {
          const mediaType = credit.media_type;
          if (mediaType !== 'movie' && mediaType !== 'tv') return [];
          if (already.has(`${mediaType}:${credit.id}`)) return [];
          return [
            {
              tmdbId: credit.id,
              mediaType,
              name: nameOf(credit),
              year: yearOf(credit),
              poster: img(credit.poster_path ?? null, 'w185'),
              watched: false,
              rating: null,
            },
          ];
        })
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    } catch {
      // Offline, or TMDB is having a moment. What the snapshot knows still stands.
    }
  }

  if (name === null) {
    throw new Error("That person isn't in this snapshot, and there's no connection.");
  }

  return { personId, name, photo: img(photo, 'h632'), biography, knownFor, seen, rest };
}

// ---------------------------------------------------------------------------
// The surface `client/src/api.ts` dispatches to
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  letterboxd: 'Letterboxd',
  imdb: 'IMDb',
  manual: 'Marked as seen',
};

const settled: SyncState = {
  running: false,
  source: null,
  startedAt: null,
  finishedAt: null,
  lines: [],
  error: null,
};

export const staticApi = {
  stats: async (): Promise<Stats> => {
    const { counts } = need().data;
    return { ...counts, unresolved: 0, indexing: idle };
  },

  recent: async (): Promise<TitleCard[]> =>
    need()
      .data.titles.filter((row) => row[8] && row[10])
      .sort((a, b) => (b[10] ?? '').localeCompare(a[10] ?? ''))
      .slice(0, 24)
      .map(toTitleCard),

  search: mergedSearch,

  searchPeople: async (q: string) => (await mergedSearch(q)).people,

  title: async (mediaType: MediaType, id: number) => getTitle(mediaType, id),
  person: async (id: number) => getPerson(id),

  library: async (params: { type?: string; q?: string; offset?: number }) => {
    const index = need();
    const needle = params.q?.trim().toLowerCase() ?? '';
    const offset = params.offset ?? 0;

    const matches = index.data.titles
      .filter((row) => {
        if (!row[8]) return false;
        if (params.type && mediaTypeOf(row[1]) !== params.type) return false;
        return !needle || row[2].toLowerCase().includes(needle);
      })
      .sort((a, b) => (b[10] ?? '').localeCompare(a[10] ?? '') || a[2].localeCompare(b[2]));

    return {
      total: matches.length,
      items: matches.slice(offset, offset + 60).map(toTitleCard),
    };
  },

  sources: async () => ({
    sources: need().data.sources.map<SourceStatus>((source) => ({
      id: source.id,
      label: SOURCE_LABELS[source.id] ?? source.id,
      configured: true,
      requiresAuth: false,
      description: 'As of the last sync before this snapshot was taken.',
      lastRunAt: source.lastOkAt,
      lastOkAt: source.lastOkAt,
      status: source.lastOkAt ? 'ok' : null,
      message: null,
      titleCount: source.titleCount,
    })),
    sync: settled,
    indexing: idle,
  }),

  syncState: async () => ({ sync: settled, indexing: idle }),

  settings: async () => ({
    tmdbKey: false,
    letterboxdUser: '',
    imdbUserId: '',
    autoSync: false,
  }),

  imdbSession: async () => ({ signedIn: false, userId: null }),

  // Nothing below this line exists without the server behind it.
  foundExports: async () => ({ files: [] }),
  unresolved: async () => [],
  candidates: async () => [],
  saveSettings: async () => ({ ok: true as const }),
  setWatched: async () => readOnly(),
  sync: async () => readOnly(),
  reindex: async () => readOnly(),
  reindexAll: async () => readOnly(),
  importFound: async () => readOnly(),
  resolve: async () => readOnly(),
  ignore: async () => readOnly(),
  upload: async () => readOnly(),
};
