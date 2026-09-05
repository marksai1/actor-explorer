import { config } from '../config.ts';
import {
  withBrowser,
  hasBrowserProfile,
  isSignedIn,
  isLetterboxdSignedIn,
  findImdbUserId,
} from '../browser.ts';
import { downloadRatingsCsv } from '../sources/imdb.ts';
import { checkPublicProfile } from '../sources/imdb-api.ts';
import { parseImdbRatingsCsv } from '../sources/parsers.ts';
import { fetchRssEvents } from '../sources/letterboxd.ts';
import { tmdb } from '../tmdb.ts';

/**
 * Checks each moving part in isolation and says exactly which one is broken.
 *
 * IMDb and Letterboxd are third-party pages that change without warning — the
 * Export control has already moved into a menu once, and IMDb's profile URL
 * scheme changed shape. When sync breaks, run this first: it tells you whether
 * the problem is your key, your session, or their markup.
 *
 *   npm run doctor            checks your key, feeds and IMDb privacy settings
 *   npm run doctor -- --export  also triggers a real IMDb export (slower, and
 *                               only relevant on the old browser-session route)
 */

const wantExport = process.argv.includes('--export');
let failures = 0;

const ok = (label: string, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label: string, detail: string) => {
  failures++;
  console.log(`  FAIL  ${label} — ${detail}`);
};

console.log('\nTMDB');
if (!config.tmdbKey) {
  bad('api key', 'TMDB_API_KEY is not set in .env');
} else {
  try {
    const res = await tmdb<{ results: unknown[] }>('search/movie', { query: 'Heat' }, 0);
    ok('api key', `search returned ${res.results?.length ?? 0} results`);
  } catch (err) {
    bad('api key', err instanceof Error ? err.message : String(err));
  }
}

console.log('\nLetterboxd');
if (!config.letterboxdUser) {
  bad('username', 'LETTERBOXD_USER is not set in .env');
} else {
  try {
    const events = await fetchRssEvents(config.letterboxdUser);
    if (events.length === 0) {
      bad('rss feed', 'feed parsed but contained no film entries — is the profile public?');
    } else {
      const withId = events.filter((e) => e.tmdbId).length;
      ok('rss feed', `${events.length} entries, ${withId} carrying a TMDB id`);
    }
  } catch (err) {
    bad('rss feed', err instanceof Error ? err.message : String(err));
  }

  if (hasBrowserProfile()) {
    try {
      const signedIn = await withBrowser((context) => isLetterboxdSignedIn(context));
      if (signedIn) ok('session', 'signed in — backfill can use your data export');
      else
        console.log(
          '  WARN  session — not signed in; backfill falls back to the public grid, which Cloudflare limits. Run `npm run login letterboxd`',
        );
    } catch (err) {
      bad('session', err instanceof Error ? err.message : String(err));
    }
  }
}

console.log('\nIMDb');
if (config.imdbUserId) {
  const { watched, rated, notes } = await checkPublicProfile(config.imdbUserId);

  if (watched === null) bad('watch history', notes[0] ?? 'not readable');
  else ok('watch history', `${watched} titles public`);

  if (rated === null) {
    console.log(`  WARN  ratings — ${notes[notes.length - 1] ?? 'private'}`);
    console.log('        Titles still sync; your scores and dates do not, and ranking uses them.');
  } else {
    ok('ratings', `${rated} rated titles public`);
  }
} else if (!hasBrowserProfile()) {
  bad('user id', 'IMDB_USER_ID is not set in .env — add your `ur…` id');
} else {
  try {
    await withBrowser(async (context) => {
      if (!(await isSignedIn(context))) {
        bad('session', 'the at-main cookie is gone — run `npm run login` again');
        return;
      }
      ok('session', 'at-main cookie present');

      const userId = await findImdbUserId(context);
      if (userId) ok('user id', userId);
      else bad('user id', 'could not read a ur… id from the profile page (sync still works without it)');

      if (wantExport) {
        try {
          const csv = await downloadRatingsCsv(context, (m) => console.log(`        ${m.trim()}`));
          const events = parseImdbRatingsCsv(csv);
          ok('export flow', `downloaded and parsed ${events.length} rated titles`);
        } catch (err) {
          bad('export flow', err instanceof Error ? err.message : String(err));
        }
      } else {
        console.log('  SKIP  export flow — pass --export to test it');
      }
    });
  } catch (err) {
    bad('browser', err instanceof Error ? err.message : String(err));
  }
}

console.log(
  failures === 0
    ? '\nEverything checks out.\n'
    : `\n${failures} check${failures === 1 ? '' : 's'} failed. The file-drop import on the Library page always works regardless.\n`,
);

process.exit(failures === 0 ? 0 : 1);
