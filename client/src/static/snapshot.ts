import { decryptEnvelope, deriveKey, parseEnvelope, WrongPassphrase, type Envelope } from './decrypt';
import { idb, KEYS } from './store';

/**
 * Loading and indexing the offline snapshot.
 *
 * The published file is a flat set of rows — see `server/snapshot.ts` for the
 * layout, which this must match. Everything the pages ask for is derived here
 * once at load into plain Maps; at this size (a few hundred titles, tens of
 * thousands of credits) that is a few milliseconds and every subsequent lookup
 * is free.
 */

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

export type CreditRow = [
  personId: number,
  titleIndex: number,
  character: string | null,
  episodeCount: number | null,
  billingOrder: number | null,
];

export interface Library {
  version: number;
  generatedAt: string;
  counts: { movies: number; shows: number; people: number; indexed: number };
  sources: { id: string; lastOkAt: string | null; titleCount: number }[];
  titles: TitleRow[];
  people: PersonRow[];
  credits: CreditRow[];
}

export interface Indexed {
  data: Library;
  titleIndexByKey: Map<string, number>;
  personById: Map<number, PersonRow>;
  creditsByPerson: Map<number, CreditRow[]>;
  creditsByTitle: Map<number, CreditRow[]>;
  /** Titles in your library this person appears in — the badge on every face. */
  seenCount: Map<number, number>;
}

export const mediaTypeOf = (code: number): 'movie' | 'tv' => (code === 1 ? 'tv' : 'movie');
export const titleKey = (mediaType: string, tmdbId: number) => `${mediaType}:${tmdbId}`;

export function indexLibrary(data: Library): Indexed {
  const titleIndexByKey = new Map<string, number>();
  data.titles.forEach((row, i) => {
    titleIndexByKey.set(titleKey(mediaTypeOf(row[1]), row[0]), i);
  });

  const personById = new Map<number, PersonRow>();
  for (const person of data.people) personById.set(person[0], person);

  const creditsByPerson = new Map<number, CreditRow[]>();
  const creditsByTitle = new Map<number, CreditRow[]>();
  const seenCount = new Map<number, number>();

  for (const credit of data.credits) {
    const [personId, titleIndex] = credit;

    let forPerson = creditsByPerson.get(personId);
    if (!forPerson) creditsByPerson.set(personId, (forPerson = []));
    forPerson.push(credit);

    let forTitle = creditsByTitle.get(titleIndex);
    if (!forTitle) creditsByTitle.set(titleIndex, (forTitle = []));
    forTitle.push(credit);

    if (data.titles[titleIndex]?.[8]) {
      seenCount.set(personId, (seenCount.get(personId) ?? 0) + 1);
    }
  }

  return { data, titleIndexByKey, personById, creditsByPerson, creditsByTitle, seenCount };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const DATA_URL = `${import.meta.env.BASE_URL}data/`;

export interface Meta {
  version: number;
  generatedAt: string;
}

/** The published snapshot's timestamp, or null when we're offline. */
export async function fetchMeta(): Promise<Meta | null> {
  try {
    const response = await fetch(`${DATA_URL}meta.json`, { cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json()) as Meta;
  } catch {
    return null;
  }
}

async function fetchEnvelope(): Promise<Envelope> {
  const response = await fetch(`${DATA_URL}library.enc`);
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'No snapshot has been published yet.'
        : `Couldn't download the snapshot (${response.status}).`,
    );
  }
  return parseEnvelope(await response.arrayBuffer());
}

async function store(data: Library, key: CryptoKey): Promise<Indexed> {
  await idb.set(KEYS.snapshot, data);
  await idb.set(KEYS.generatedAt, data.generatedAt);
  await idb.set(KEYS.cryptoKey, key);
  return indexLibrary(data);
}

/**
 * First unlock. Everything after this is silent — the derived key is kept, and
 * because the salt is stable across builds it opens future snapshots too.
 */
export async function unlock(passphrase: string): Promise<Indexed> {
  const envelope = await fetchEnvelope();
  const key = await deriveKey(passphrase, envelope);
  const json = await decryptEnvelope(envelope, key);
  return store(JSON.parse(json) as Library, key);
}

export async function loadCached(): Promise<Indexed | null> {
  const data = await idb.get<Library>(KEYS.snapshot);
  return data ? indexLibrary(data) : null;
}

/**
 * Pulls a newer snapshot if one has been published, using the key already held.
 * Returns null when there is nothing new, we're offline, or the key no longer
 * fits — none of which is worth interrupting the user for.
 */
export async function refresh(cachedAt: string | null): Promise<Indexed | null> {
  const meta = await fetchMeta();
  if (!meta || meta.generatedAt === cachedAt) return null;

  const key = await idb.get<CryptoKey>(KEYS.cryptoKey);
  if (!key) return null;

  try {
    const envelope = await fetchEnvelope();
    const json = await decryptEnvelope(envelope, key);
    return store(JSON.parse(json) as Library, key);
  } catch (error) {
    // A rebuilt salt is the one case that needs the passphrase again; the app
    // keeps running on what it has until the user opens Settings.
    if (error instanceof WrongPassphrase) return null;
    throw error;
  }
}

export async function forget(): Promise<void> {
  await idb.delete(KEYS.snapshot);
  await idb.delete(KEYS.generatedAt);
  await idb.delete(KEYS.cryptoKey);
}
