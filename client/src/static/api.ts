import { scoreCredit } from '../../../server/scoring.ts';
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
 * Two things genuinely cannot come along: a person's biography and the dimmed
 * "rest of their work" section are live TMDB calls with no local equivalent, so
 * they come back empty. Both already have an empty state in the UI.
 */

let library: Indexed | null = null;

export function setLibrary(next: Indexed): void {
  library = next;
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

function getTitle(mediaType: MediaType, tmdbId: number): TitleDetail {
  const index = need();
  const at = index.titleIndexByKey.get(titleKey(mediaType, tmdbId));
  const row = at === undefined ? undefined : index.data.titles[at];

  if (at === undefined || !row) {
    throw new Error("That title isn't in this snapshot. Open it on the machine that syncs.");
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

// ---------------------------------------------------------------------------
// Person page
// ---------------------------------------------------------------------------

function getPerson(personId: number): PersonDetail {
  const index = need();
  const person = index.personById.get(personId);
  if (!person) throw new Error("That person isn't in this snapshot yet.");

  const seen: OverlapEntry[] = (index.creditsByPerson.get(personId) ?? [])
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

  return {
    personId,
    name: person[1],
    photo: img(person[2], 'h632'),
    biography: '',
    knownFor: null,
    seen,
    // Needs a live TMDB call. The section hides itself when it is empty.
    rest: [],
  };
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

  search: async (q: string) => ({
    titles: searchTitles(q, 24),
    people: searchPeopleRows(q, 24),
  }),

  searchPeople: async (q: string) => searchPeopleRows(q, 40),

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
