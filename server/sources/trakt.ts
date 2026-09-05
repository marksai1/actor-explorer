import type { SyncContext, SyncResult, WatchSource } from './types.ts';
import { emptyResult } from './types.ts';

/**
 * Trakt — written against the source interface but switched off.
 *
 * Stremio can scrobble everything you watch to Trakt automatically, and Trakt
 * has a real OAuth API that returns both IMDb and TMDB ids — no scraping, no
 * session to expire. If you ever want it, turning it on is config plus the
 * fetch calls below, not a refactor: `ingestEvents` already accepts exactly the
 * shape Trakt returns.
 *
 * To enable:
 *   1. Create an API app at https://trakt.tv/oauth/applications
 *   2. Put TRAKT_CLIENT_ID / TRAKT_ACCESS_TOKEN in .env
 *   3. Fill in sync() below — GET /sync/history returns items carrying
 *      `ids: { trakt, slug, imdb, tmdb }`, which map straight onto WatchEvent.
 */

export const SOURCE_ID = 'trakt';

export const traktSource: WatchSource = {
  id: SOURCE_ID,
  label: 'Trakt',
  requiresAuth: true,

  isConfigured: () => false,

  describe: () =>
    'Not enabled. Connect Stremio to Trakt and fill in server/sources/trakt.ts to switch it on.',

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    return { ...emptyResult(), message: 'Trakt source is not enabled.' };
  },
};
