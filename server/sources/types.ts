import type { MediaType } from '../db.ts';

/**
 * One "I watched this" fact, in whatever fidelity the source could give us.
 * Adapters emit these; `ingest.ts` is responsible for resolving them to TMDB.
 */
export interface WatchEvent {
  /** Best case — the source handed us a TMDB id outright (Letterboxd RSS does). */
  tmdbId?: number;
  /** Next best — an IMDb `tt` const, which maps exactly via TMDB's find endpoint. */
  imdbId?: string;
  mediaType?: MediaType;
  title: string;
  year?: number | null;
  /** Normalised to a 0–10 scale regardless of the source's native scale. */
  rating?: number | null;
  watchedAt?: string | null;
  /** Stable identifier within the source, used to dedupe across runs. */
  sourceRef: string;
}

export interface SyncResult {
  scanned: number;
  added: number;
  updated: number;
  unresolved: number;
  message?: string;
}

export interface SyncContext {
  /** Full backfill vs. cheap incremental poll. */
  full: boolean;
  log: (message: string) => void;
}

export interface WatchSource {
  id: string;
  label: string;
  /** Whether this source needs a logged-in browser profile to work. */
  requiresAuth: boolean;
  isConfigured(): boolean;
  /** Human-readable note about what's missing, shown in Settings. */
  describe(): string;
  sync(ctx: SyncContext): Promise<SyncResult>;
}

export const emptyResult = (): SyncResult => ({
  scanned: 0,
  added: 0,
  updated: 0,
  unresolved: 0,
});
