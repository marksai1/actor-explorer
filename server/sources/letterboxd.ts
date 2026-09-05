import path from 'node:path';
import fs from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import type { BrowserContext } from 'playwright';
import { config, DOWNLOAD_DIR } from '../config.ts';
import { db, markSync } from '../db.ts';
import { ingestEvents } from '../ingest.ts';
import { withBrowser, hasBrowserProfile, isLetterboxdSignedIn } from '../browser.ts';
import { parseLetterboxdZip } from './parsers.ts';
import type { SyncContext, SyncResult, WatchEvent, WatchSource } from './types.ts';
import { emptyResult } from './types.ts';

/**
 * Letterboxd — films, fully automatic, no login anywhere.
 *
 * Incremental sync reads the public RSS feed, which hands us a TMDB id per
 * entry, so new films need no title matching at all. Backfill walks the public
 * films grid; anything the matcher isn't sure about gets its exact id from the
 * film page in a second pass.
 */

export const SOURCE_ID = 'letterboxd';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetches a URL and returns HTML. Either plain HTTP or driven through a browser. */
export type Fetcher = (url: string) => Promise<string>;

/** Cloudflare's interstitial, which a plain HTTP client can't clear. */
class CloudflareChallenge extends Error {
  constructor(url: string) {
    super(`Cloudflare challenged the request for ${url}`);
    this.name = 'CloudflareChallenge';
  }
}

/**
 * Detects the interstitial specifically.
 *
 * Deliberately narrow: Cloudflare injects a `/cdn-cgi/challenge-platform/`
 * telemetry script into perfectly normal pages, so matching that substring
 * flags real content as blocked. The actual interstitial is a small document
 * titled "Just a moment…", served with a 403.
 */
const isChallenge = (html: string): boolean =>
  /<title>\s*Just a moment/i.test(html) || /cf-browser-verification|cf_chl_opt/i.test(html);

/**
 * The fast path. Letterboxd usually serves plain requests happily, but
 * Cloudflare will start challenging a run of them from one address — which no
 * amount of header spoofing fixes, since it's fingerprinting the TLS handshake.
 */
export const plainGet: Fetcher = async (url: string): Promise<string> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const body = await res.text().catch(() => '');

    // A 200 is content, full stop — never second-guess it.
    if (res.ok) return body;
    if (res.status === 403 && isChallenge(body)) throw new CloudflareChallenge(url);
    if (res.status === 404) throw new Error(`Not found: ${url}`);
    if (res.status === 429 || res.status >= 500) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error(`Letterboxd responded ${res.status} for ${url}`);
  }
  throw new Error(`Letterboxd request failed after retries: ${url}`);
};

/**
 * The slow path, used only once Cloudflare starts pushing back.
 *
 * This runs *headed* on purpose. Cloudflare reliably detects headless Chromium
 * and keeps serving the interstitial to it, while a visible window clears in a
 * second or two. Backfill is a one-time operation, so a window that opens and
 * closes itself is a fair price for getting the whole history in.
 */
async function withBrowserFetcher<T>(run: (get: Fetcher) => Promise<T>): Promise<T> {
  return withBrowser(
    async (context) => {
      const page = await context.newPage();
      const get: Fetcher = async (url) => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        let html = await page.content();
        for (let i = 0; i < 10 && isChallenge(html); i++) {
          await page.waitForTimeout(2000);
          html = await page.content();
        }
        if (isChallenge(html)) {
          throw new Error(
            'Cloudflare kept challenging even in a real browser. Try again later, or use the Letterboxd export ZIP on the Library page.',
          );
        }
        return html;
      };
      try {
        return await run(get);
      } finally {
        await page.close().catch(() => {});
      }
    },
    { headed: true },
  );
}

/** Runs a scrape over plain HTTP, transparently upgrading to a browser if blocked. */
async function withFallback<T>(
  run: (get: Fetcher) => Promise<T>,
  log: (message: string) => void,
): Promise<T> {
  try {
    return await run(plainGet);
  } catch (err) {
    if (!(err instanceof CloudflareChallenge)) throw err;
    log('  Cloudflare challenged the plain request.');
    log('  Opening a browser window to get past it — it closes itself when done.');
    return withBrowserFetcher(run);
  }
}

// ---------------------------------------------------------------------------
// Incremental: the public RSS feed
// ---------------------------------------------------------------------------

interface RssItem {
  guid?: string | { '#text'?: string };
  'letterboxd:filmTitle'?: string;
  'letterboxd:filmYear'?: number | string;
  'letterboxd:memberRating'?: number | string;
  'letterboxd:watchedDate'?: string;
  'tmdb:movieId'?: number | string;
}

export async function fetchRssEvents(
  username: string,
  get: Fetcher = plainGet,
): Promise<WatchEvent[]> {
  const xml = await get(`https://letterboxd.com/${encodeURIComponent(username)}/rss/`);
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });
  const parsed = parser.parse(xml) as { rss?: { channel?: { item?: RssItem | RssItem[] } } };

  const raw = parsed.rss?.channel?.item;
  const items: RssItem[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const events: WatchEvent[] = [];
  for (const item of items) {
    // The feed also carries list posts and standalone reviews; only entries
    // with a film id are watch events.
    const tmdbId = Number(item['tmdb:movieId']);
    const title = item['letterboxd:filmTitle'];
    if (!Number.isFinite(tmdbId) || tmdbId <= 0 || !title) continue;

    const guid = typeof item.guid === 'object' ? item.guid?.['#text'] : item.guid;
    const rating = Number(item['letterboxd:memberRating']);
    const year = Number(item['letterboxd:filmYear']);

    events.push({
      tmdbId,
      mediaType: 'movie',
      title: String(title),
      year: Number.isFinite(year) ? year : null,
      // Letterboxd stars are 0.5–5; the library is 0–10 throughout.
      rating: Number.isFinite(rating) ? rating * 2 : null,
      watchedAt: item['letterboxd:watchedDate'] ?? null,
      sourceRef: String(guid ?? `tmdb:${tmdbId}`),
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Backfill: the public films grid
// ---------------------------------------------------------------------------

/** Pulls slug + title + year out of the LazyPoster components on a grid page. */
export function parseFilmsPage(html: string): {
  entries: { slug: string; title: string; year: number | null }[];
  hasNext: boolean;
} {
  const entries: { slug: string; title: string; year: number | null }[] = [];

  // Parse each poster component as a unit so attribute order can shift without
  // silently pairing the wrong title to the wrong slug.
  const componentRe = /<div\b[^>]*\bdata-item-slug="[^"]+"[^>]*>/g;

  for (const [tag] of html.matchAll(componentRe)) {
    const slug = /\bdata-item-slug="([^"]+)"/.exec(tag)?.[1];
    if (!slug) continue;

    const display = decodeEntities(
      /\bdata-item-full-display-name="([^"]*)"/.exec(tag)?.[1] ??
        /\bdata-item-name="([^"]*)"/.exec(tag)?.[1] ??
        '',
    );

    // Display names arrive as "Title (Year)".
    const parsed = /^(.*?)\s*\((\d{4})\)\s*$/.exec(display);
    entries.push({
      slug: decodeEntities(slug),
      title: parsed?.[1]?.trim() || display || slug.replace(/-/g, ' '),
      year: parsed?.[2] ? Number(parsed[2]) : null,
    });
  }

  return { entries, hasNext: /class="next"\s+href="/.test(html) };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export async function fetchAllFilms(
  username: string,
  log: (message: string) => void,
  get: Fetcher = plainGet,
): Promise<WatchEvent[]> {
  const events: WatchEvent[] = [];
  const seen = new Set<string>();
  const base = `https://letterboxd.com/${encodeURIComponent(username)}/films`;

  for (let page = 1; page <= 200; page++) {
    // Page 1 has a canonical URL without the /page/1/ suffix, which is the one
    // Letterboxd's cache is warm for.
    const url = page === 1 ? `${base}/` : `${base}/page/${page}/`;
    const html = await get(url);
    const { entries, hasNext } = parseFilmsPage(html);
    if (entries.length === 0) break;

    for (const entry of entries) {
      if (seen.has(entry.slug)) continue;
      seen.add(entry.slug);
      events.push({
        mediaType: 'movie',
        title: entry.title,
        year: entry.year,
        sourceRef: `/film/${entry.slug}/`,
      });
    }

    log(`  page ${page}: ${entries.length} films (${events.length} total)`);
    if (!hasNext) break;
    await sleep(600); // be a good guest
  }

  return events;
}

// ---------------------------------------------------------------------------
// Backfill, preferred route: Letterboxd's own export ZIP
// ---------------------------------------------------------------------------

/**
 * Downloads your data export through the signed-in browser profile.
 *
 * This is the right way to backfill. Cloudflare hard-blocks the paginated films
 * grid — not just for headless clients, but for a real visible browser doing
 * genuine in-site navigation — so scraping history page by page is not
 * dependable. The export is one file, complete, with ratings and real diary
 * dates attached, and it goes through the same parser as a manually dropped ZIP.
 */
export async function downloadExportZip(
  context: BrowserContext,
  log: (message: string) => void,
): Promise<Uint8Array> {
  const page = await context.newPage();
  try {
    log('  requesting your Letterboxd data export…');

    const capture = context.waitForEvent('download', { timeout: 120_000 });

    // The export is a plain authenticated GET; the settings page is the fallback
    // if that endpoint ever moves.
    await page
      .goto('https://letterboxd.com/data/export/', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      .catch(() => {
        /* navigation aborts once the download takes over — expected */
      });

    let download = await capture.catch(() => null);

    if (!download) {
      log('  direct export URL did not deliver, trying the settings page…');
      await page.goto('https://letterboxd.com/settings/data/', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      const link = page
        .getByRole('link', { name: /export your data|export/i })
        .or(page.getByRole('button', { name: /export your data|export/i }))
        .first();
      if (!(await link.isVisible().catch(() => false))) {
        throw new Error(
          'Could not find the export control. Are you signed in to Letterboxd? Run:  npm run login letterboxd',
        );
      }
      const second = context.waitForEvent('download', { timeout: 120_000 });
      await link.click();
      download = await second;
    }

    const target = path.join(DOWNLOAD_DIR, `letterboxd-export-${Date.now()}.zip`);
    await download.saveAs(target);
    const bytes = new Uint8Array(await fs.readFile(target));

    if (bytes.length < 100 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new Error('The downloaded export was not a ZIP file.');
    }
    log(`  export downloaded (${Math.round(bytes.length / 1024)} KB)`);
    return bytes;
  } finally {
    await page.close().catch(() => {});
  }
}

/** Exact TMDB id straight off a film page — used only when matching was unsure. */
export async function tmdbIdFromFilmPage(
  slug: string,
  get: Fetcher = plainGet,
): Promise<{ tmdbId: number; mediaType: 'movie' | 'tv' } | null> {
  const html = await get(`https://letterboxd.com/film/${slug}/`);

  const attr = /data-tmdb-id="(\d+)"/.exec(html);
  const type = /data-tmdb-type="(\w+)"/.exec(html);
  if (attr) {
    return {
      tmdbId: Number(attr[1]),
      mediaType: type?.[1] === 'tv' ? 'tv' : 'movie',
    };
  }

  const link = /themoviedb\.org\/(movie|tv)\/(\d+)/.exec(html);
  if (link) return { tmdbId: Number(link[2]), mediaType: link[1] as 'movie' | 'tv' };

  return null;
}

/**
 * Second pass over rows the matcher declined to guess at. Bounded to the
 * failures, so a clean library costs zero extra requests.
 */
async function resolveStragglers(
  log: (message: string) => void,
  get: Fetcher = plainGet,
): Promise<number> {
  const pending = db
    .prepare(
      `SELECT id, raw_ref, raw_title FROM unresolved
        WHERE source = ? AND status = 'pending' AND raw_ref LIKE '/film/%'
        LIMIT 300`,
    )
    .all(SOURCE_ID) as { id: number; raw_ref: string; raw_title: string }[];

  if (pending.length === 0) return 0;
  log(`  resolving ${pending.length} uncertain matches via film pages…`);

  const { resolveManually } = await import('../ingest.ts');
  let fixed = 0;

  for (const row of pending) {
    const slug = row.raw_ref.replace(/^\/film\//, '').replace(/\/$/, '');
    try {
      const found = await tmdbIdFromFilmPage(slug, get);
      if (found) {
        await resolveManually(row.id, found.tmdbId, found.mediaType);
        fixed++;
      }
    } catch (err) {
      log(`  ! ${row.raw_title}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(400);
  }

  return fixed;
}

/**
 * Attempt the export-ZIP route. Returns null when there's no Letterboxd
 * session to use, so the caller can fall back to the public grid.
 */
async function tryExportZip(log: (message: string) => void): Promise<WatchEvent[] | null> {
  if (!hasBrowserProfile()) return null;

  try {
    return await withBrowser(async (context) => {
      if (!(await isLetterboxdSignedIn(context))) {
        log('  not signed in to Letterboxd — run `npm run login letterboxd` for full history.');
        return null;
      }
      const bytes = await downloadExportZip(context, log);
      const events = parseLetterboxdZip(bytes);
      log(`  export contained ${events.length} films`);
      return events;
    });
  } catch (err) {
    log(`  export download failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------

export const letterboxdSource: WatchSource = {
  id: SOURCE_ID,
  label: 'Letterboxd',
  requiresAuth: false,

  isConfigured: () => Boolean(config.letterboxdUser),

  describe: () => {
    if (!config.letterboxdUser) {
      return 'Set LETTERBOXD_USER in your .env file to enable automatic film sync.';
    }
    return (
      `Syncing films for @${config.letterboxdUser} from the public RSS feed — no login needed. ` +
      'For full history, sign in once with `npm run login letterboxd` so backfill can use your data export.'
    );
  },

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const username = config.letterboxdUser;
    if (!username) {
      return { ...emptyResult(), message: 'LETTERBOXD_USER is not set' };
    }

    markSync(SOURCE_ID, 'running');
    try {
      let events: WatchEvent[];
      let result;

      if (ctx.full) {
        ctx.log(`Letterboxd: full backfill for @${username}`);

        const zipEvents = await tryExportZip(ctx.log);

        if (zipEvents) {
          // The export is authoritative and complete; RSS still adds the most
          // recent watches in case the export lags behind.
          const rss = await fetchRssEvents(username).catch(() => []);
          result = await ingestEvents([...zipEvents, ...rss], SOURCE_ID, ctx.log);
        } else {
          // No Letterboxd session — fall back to the public grid. Cloudflare
          // usually allows the first page and blocks the rest, so this gets
          // recent history rather than all of it.
          result = await withFallback(async (get) => {
            const films = await fetchAllFilms(username, ctx.log, get);
            const rss = await fetchRssEvents(username, get).catch(() => []);
            const ingested = await ingestEvents([...films, ...rss], SOURCE_ID, ctx.log);

            const fixed = await resolveStragglers(ctx.log, get);
            ingested.added += fixed;
            ingested.unresolved = Math.max(0, ingested.unresolved - fixed);
            return ingested;
          }, ctx.log);
        }
      } else {
        ctx.log(`Letterboxd: checking recent activity for @${username}`);
        events = await withFallback((get) => fetchRssEvents(username, get), ctx.log);
        result = await ingestEvents(events, SOURCE_ID, ctx.log);
      }

      markSync(
        SOURCE_ID,
        'ok',
        `${result.added} added, ${result.updated} updated, ${result.unresolved} unresolved`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markSync(SOURCE_ID, 'error', message);
      throw err;
    }
  },
};
