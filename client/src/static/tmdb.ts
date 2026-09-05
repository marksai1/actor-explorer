import type {
  PersonCredit,
  TmdbCastMember,
  TmdbPersonResult,
  TmdbTitle,
} from '../../../server/tmdb-shapes.ts';

/**
 * TMDB from the phone.
 *
 * The snapshot answers everything about your own library offline. This covers
 * the one thing it cannot: a film you have never watched, whose cast is not in
 * your index. Search reaches all of TMDB again, and opening an unfamiliar title
 * pulls its cast live — but the question that matters, *how many things I have
 * watched is this face in*, is still answered locally, because the credit index
 * on the device is keyed by the same TMDB person ids.
 *
 * The key arrives inside the encrypted snapshot rather than compiled into the
 * bundle, so nothing published is readable without the passphrase. That does
 * mean TMDB is unreachable until the library has been unlocked — which the app
 * already requires before it will render anything at all.
 */

const BASE = 'https://api.themoviedb.org/3';

let key = '';

/** Called as the decrypted snapshot is installed; before that there is no key. */
export function setTmdbKey(next: string | undefined): void {
  key = (next ?? '').trim();
}

/** False when the snapshot carried no key, which keeps the app offline-only. */
export const tmdbAvailable = (): boolean => key.length > 0;

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  if (!tmdbAvailable()) throw new Error('This snapshot carries no TMDB key.');

  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set('api_key', key);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`TMDB said ${response.status}.`);
  return (await response.json()) as T;
}

export async function searchMulti(
  query: string,
): Promise<{ titles: TmdbTitle[]; people: TmdbPersonResult[] }> {
  const res = await get<{ results: (TmdbTitle & TmdbPersonResult)[] }>('search/multi', {
    query,
    include_adult: 'false',
  });
  const results = res.results ?? [];
  return {
    titles: results.filter((r) => r.media_type === 'movie' || r.media_type === 'tv'),
    people: results.filter((r) => r.media_type === 'person') as TmdbPersonResult[],
  };
}

export const getDetail = (mediaType: 'movie' | 'tv', tmdbId: number) =>
  get<TmdbTitle>(`${mediaType}/${tmdbId}`);

/** TV uses aggregate_credits, which rolls a performer's whole run into one row. */
export async function getCast(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
): Promise<TmdbCastMember[]> {
  const endpoint = mediaType === 'tv' ? 'aggregate_credits' : 'credits';
  const res = await get<{ cast: TmdbCastMember[] }>(`${mediaType}/${tmdbId}/${endpoint}`);
  return res.cast ?? [];
}

export const getPerson = (personId: number) =>
  get<{
    id: number;
    name: string;
    profile_path?: string | null;
    biography?: string;
    known_for_department?: string;
  }>(`person/${personId}`);

export async function getPersonCredits(personId: number): Promise<PersonCredit[]> {
  const res = await get<{ cast: PersonCredit[] }>(`person/${personId}/combined_credits`);
  return res.cast ?? [];
}
