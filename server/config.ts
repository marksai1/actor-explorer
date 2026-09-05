import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { normaliseImdbUserId } from './sources/imdb-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

loadEnv({ path: path.join(ROOT, '.env') });

export const DATA_DIR = path.join(ROOT, '.data');
export const DB_PATH = path.join(DATA_DIR, 'db.sqlite');
export const BROWSER_PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
export const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');
export const CLIENT_DIST = path.join(ROOT, 'dist');

for (const dir of [DATA_DIR, DOWNLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /**
   * Listening address. The default accepts connections from the rest of your
   * network, which is what lets a phone open the app — there's no auth in
   * front of it, so set `HOST=127.0.0.1` to keep it to this machine only.
   */
  host: process.env.HOST?.trim() || '0.0.0.0',
  tmdbKey: process.env.TMDB_API_KEY?.trim() ?? '',
  letterboxdUser: process.env.LETTERBOXD_USER?.trim() ?? '',
  /**
   * Your `ur…` id, which is the whole of the IMDb setup — sync reads your
   * public watch history with it and never signs in. Pasting the profile URL
   * instead of the bare id is fine; the id is picked out of it.
   */
  imdbUserId: normaliseImdbUserId(process.env.IMDB_USER_ID ?? '') ?? '',
  /**
   * Which browser Playwright drives. Empty means its bundled Chromium.
   *
   * Set to `chrome` (or `msedge`) to use the real browser installed on this
   * machine. Cloudflare's Turnstile fingerprints bundled Chromium and will sit
   * on a permanent CAPTCHA loop; a genuine Chrome build usually passes. Cookies
   * carry over either way — they're encrypted against your Windows account, not
   * the browser build.
   */
  browserChannel: process.env.BROWSER_CHANNEL?.trim() ?? '',
};

export const TMDB_IMAGE = 'https://image.tmdb.org/t/p';

/** Poster/profile/backdrop URL at a given TMDB size, or null when the path is missing. */
export function img(path: string | null | undefined, size: string): string | null {
  return path ? `${TMDB_IMAGE}/${size}${path}` : null;
}
