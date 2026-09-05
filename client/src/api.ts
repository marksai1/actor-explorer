import { staticApi } from './static/api';

export type MediaType = 'movie' | 'tv';

export interface TitleCard {
  tmdbId: number;
  mediaType: MediaType;
  name: string;
  year: number | null;
  poster: string | null;
  watched: boolean;
  rating: number | null;
}

export interface PersonCard {
  personId: number;
  name: string;
  photo: string | null;
  knownFor: string | null;
  seenCount: number;
}

export interface CastEntry {
  personId: number;
  name: string;
  photo: string | null;
  character: string | null;
  episodeCount: number | null;
  billingOrder: number | null;
  seenCount: number;
}

export interface TitleDetail {
  tmdbId: number;
  mediaType: MediaType;
  name: string;
  year: number | null;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  watched: boolean;
  rating: number | null;
  cast: CastEntry[];
}

export interface OverlapEntry extends TitleCard {
  character: string | null;
  episodeCount: number | null;
  billingOrder: number | null;
  watchedAt: string | null;
  sources: string[];
  score: number;
  basis: string;
}

export interface PersonDetail {
  personId: number;
  name: string;
  photo: string | null;
  biography: string;
  knownFor: string | null;
  seen: OverlapEntry[];
  rest: TitleCard[];
}

export interface IndexProgress {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  errors: number;
  lastError: string | null;
}

export interface Stats {
  movies: number;
  shows: number;
  people: number;
  indexed: number;
  unresolved: number;
  indexing: IndexProgress;
}

export interface SourceStatus {
  id: string;
  label: string;
  configured: boolean;
  requiresAuth: boolean;
  description: string;
  lastRunAt: string | null;
  lastOkAt: string | null;
  status: string | null;
  message: string | null;
  titleCount: number;
}

export interface SyncState {
  running: boolean;
  source: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lines: string[];
  error: string | null;
}

export interface UnresolvedRow {
  id: number;
  source: string;
  raw_title: string;
  raw_year: number | null;
  raw_ref: string;
  media_hint: string | null;
  rating: number | null;
  watched_at: string | null;
}

export interface Candidate {
  tmdbId: number;
  mediaType: MediaType;
  name: string;
  year: number | null;
  poster: string | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body instanceof FormData ? undefined : { 'content-type': 'application/json' },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

const post = <T,>(url: string, data?: unknown) =>
  request<T>(url, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) });

const serverApi = {
  stats: () => request<Stats>('/api/stats'),
  recent: () => request<TitleCard[]>('/api/recent'),
  search: (q: string) =>
    request<{ titles: TitleCard[]; people: PersonCard[] }>(
      `/api/search?q=${encodeURIComponent(q)}`,
    ),
  searchPeople: (q: string) =>
    request<PersonCard[]>(`/api/search/people?q=${encodeURIComponent(q)}`),
  title: (mediaType: MediaType, id: number) =>
    request<TitleDetail>(`/api/title/${mediaType}/${id}`),
  person: (id: number) => request<PersonDetail>(`/api/person/${id}`),

  library: (params: { type?: string; q?: string; offset?: number }) => {
    const search = new URLSearchParams();
    if (params.type) search.set('type', params.type);
    if (params.q) search.set('q', params.q);
    if (params.offset) search.set('offset', String(params.offset));
    return request<{ items: TitleCard[]; total: number }>(`/api/library?${search}`);
  },

  setWatched: (tmdbId: number, mediaType: MediaType, watched: boolean) =>
    post<{ ok: true }>('/api/watched', { tmdbId, mediaType, watched }),

  sources: () =>
    request<{ sources: SourceStatus[]; sync: SyncState; indexing: IndexProgress }>('/api/sources'),
  syncState: () => request<{ sync: SyncState; indexing: IndexProgress }>('/api/sync/state'),
  sync: (source?: string, full?: boolean) => post<SyncState>('/api/sync', { source, full }),
  reindex: () => post<{ queued: number }>('/api/reindex'),
  reindexAll: () => post<{ queued: number }>('/api/reindex/all'),

  foundExports: () =>
    request<{ files: { file: string; kind: 'letterboxd' | 'imdb'; modified: number }[] }>(
      '/api/import/found',
    ),
  importFound: (file: string) =>
    post<{ result: { added: number; updated: number; unresolved: number } }>(
      '/api/import/found',
      { file },
    ),

  unresolved: () => request<UnresolvedRow[]>('/api/unresolved'),
  candidates: (id: number) => request<Candidate[]>(`/api/unresolved/${id}/candidates`),
  resolve: (id: number, tmdbId: number, mediaType: MediaType) =>
    post<{ ok: true }>(`/api/unresolved/${id}/resolve`, { tmdbId, mediaType }),
  ignore: (id: number) => post<{ ok: true }>(`/api/unresolved/${id}/ignore`),

  settings: () =>
    request<{
      tmdbKey: boolean;
      letterboxdUser: string;
      imdbUserId: string;
      autoSync: boolean;
    }>('/api/settings'),
  saveSettings: (data: { autoSync?: boolean }) => post<{ ok: true }>('/api/settings', data),
  imdbSession: () => request<{ signedIn: boolean; userId: string | null }>('/api/session/imdb'),

  upload: async (files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append('file', file);
    return request<{ results: { filename: string; source: string; added: number; updated: number; unresolved: number }[] }>(
      '/api/import',
      { method: 'POST', body: form },
    );
  },
};

/**
 * Which half of the app is running.
 *
 * The published build has no server behind it: `npm run build:static` sets this
 * and every call is answered from the encrypted snapshot on the device instead.
 * The LAN build is untouched and still talks to Fastify.
 */
export const IS_STATIC = import.meta.env.VITE_STATIC === '1';

/**
 * The static implementation covers the whole read side and refuses the writes,
 * which is exactly the shape the pages already handle. The cast is because its
 * refusals return `never` rather than each method's success type.
 */
export const api: typeof serverApi = IS_STATIC
  ? (staticApi as unknown as typeof serverApi)
  : serverApi;
