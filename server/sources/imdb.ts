import path from 'node:path';
import fs from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import { DOWNLOAD_DIR, config } from '../config.ts';
import { markSync } from '../db.ts';
import { ingestEvents } from '../ingest.ts';
import { withBrowser, hasBrowserProfile, isSignedIn } from '../browser.ts';
import { fetchPublicLibrary } from './imdb-api.ts';
import { parseImdbRatingsCsv } from './parsers.ts';
import type { SyncContext, SyncResult, WatchEvent, WatchSource } from './types.ts';
import { emptyResult } from './types.ts';

/**
 * IMDb — TV.
 *
 * The live path is `imdb-api.ts`: set `IMDB_USER_ID` to your `ur…` id, make
 * your watch history public, and sync reads it anonymously over IMDb's own
 * GraphQL API. No browser, no login, no export, nothing to re-do when a session
 * expires.
 *
 * Everything below it is the older browser-driven route, kept because it costs
 * nothing to keep and covers the case where someone would rather sign in than
 * make anything public. It only runs when there's no `IMDB_USER_ID` but there
 * *is* a saved browser profile. Be warned that IMDb now WAFs headless browsers
 * outright, so it needs a visible window to work at all.
 */

export const SOURCE_ID = 'imdb';

const RATINGS_URL = 'https://www.imdb.com/list/ratings';
const EXPORTS_URL = 'https://www.imdb.com/exports/';

async function dismissConsent(page: Page): Promise<void> {
  // IMDb occasionally interstitials a cookie banner that swallows clicks.
  for (const name of [/accept/i, /agree/i, /continue/i]) {
    const button = page.getByRole('button', { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 3000 }).catch(() => {});
      return;
    }
  }
}

/**
 * Ask IMDb to generate a ratings export, then wait for it to appear on the
 * exports page and download it. Returns the CSV text.
 */
export async function downloadRatingsCsv(
  context: BrowserContext,
  log: (message: string) => void,
): Promise<string> {
  const page = await context.newPage();
  try {
    log('  requesting a fresh ratings export…');
    await page.goto(RATINGS_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(3000);
    await dismissConsent(page);

    if (/signin|registration|ap\/signin/i.test(page.url())) {
      throw new Error('Not signed in to IMDb. Run:  npm run login');
    }

    // Export isn't a top-level control — it sits inside the "…" actions menu on
    // the list page, so that has to be opened first.
    const menuButton = page
      .locator('[data-testid="hero-list-subnav-actions-menu-button"]')
      .first();
    if (await menuButton.isVisible().catch(() => false)) {
      await menuButton.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    // The item is an <li role="menuitem">, not a button, so role matters here.
    const exportItem = page
      .getByRole('menuitem', { name: /^export$/i })
      .or(page.locator('[data-testid="hero-list-subnav-actions-menu"] li:has-text("Export")'))
      .or(page.getByText('Export', { exact: true }))
      .first();

    if (await exportItem.isVisible().catch(() => false)) {
      await exportItem.click().catch(() => {});
      log('  export requested');
      await page.waitForTimeout(3000);
    } else {
      log('  (no Export control found — checking for an existing export)');
    }

    // IMDb generates exports asynchronously; poll the exports page for a ready
    // ratings row. Generation is usually seconds, occasionally a minute.
    const deadline = Date.now() + 5 * 60_000;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;
      await page.goto(EXPORTS_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await dismissConsent(page);
      await page.waitForTimeout(1500);

      const downloadLink = page
        .locator('a[href*="export"], a[download], button')
        .filter({ hasText: /download|ready/i })
        .first();

      const ready = await downloadLink.isVisible().catch(() => false);
      if (ready) {
        log('  export ready, downloading…');
        const [download] = await Promise.all([
          context.waitForEvent('download', { timeout: 60_000 }),
          downloadLink.click(),
        ]);
        const target = path.join(DOWNLOAD_DIR, `imdb-ratings-${Date.now()}.csv`);
        await download.saveAs(target);
        const text = await fs.readFile(target, 'utf8');
        if (!/const/i.test(text.slice(0, 300))) {
          throw new Error('Downloaded file does not look like an IMDb ratings CSV.');
        }
        return text;
      }

      if (attempt === 1) log('  waiting for IMDb to build the export…');
      await page.waitForTimeout(10_000);
    }

    throw new Error('Timed out waiting for IMDb to prepare the export.');
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Fallback: read the ratings straight off the page. Less complete than the
 * export but keeps sync working if the export UI shifts under us.
 */
async function scrapeRatings(
  context: BrowserContext,
  log: (message: string) => void,
): Promise<WatchEvent[]> {
  const page = await context.newPage();
  try {
    log('  falling back to reading the ratings page directly…');
    // Always go through /list/ratings — IMDb redirects it to whatever the
    // current per-user URL shape is, so there's nothing to hand-build.
    await page.goto(RATINGS_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(3000);
    await dismissConsent(page);

    if (/signin|registration|ap\/signin/i.test(page.url())) {
      throw new Error('Not signed in to IMDb. Run:  npm run login');
    }

    // Expand the list until IMDb stops offering more.
    for (let i = 0; i < 100; i++) {
      const more = page.getByRole('button', { name: /\d+ more|show more/i }).first();
      if (!(await more.isVisible().catch(() => false))) break;
      await more.click().catch(() => {});
      await page.waitForTimeout(1200);
    }

    // Runs inside the page, so DOM globals are reached through a cast rather
    // than pulling browser typings into the server's lib.
    const rows = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: any }).document;
      const out: { imdbId: string; title: string; rating: number | null }[] = [];
      const seen = new Set<string>();

      for (const item of doc.querySelectorAll('li, .ipc-metadata-list-summary-item')) {
        const anchor = item.querySelector('a[href*="/title/tt"]');
        if (!anchor) continue;
        const id = /\/title\/(tt\d+)/.exec(anchor.getAttribute('href') ?? '')?.[1];
        if (!id || seen.has(id)) continue;

        const text: string = item.innerText ?? '';
        // "Your rating" appears next to the star the user set.
        const rating = /your rating[^\d]{0,12}(\d{1,2})/i.exec(text)?.[1];

        seen.add(id);
        out.push({
          imdbId: id,
          title: anchor.textContent?.replace(/^\d+\.\s*/, '').trim() ?? id,
          rating: rating ? Number(rating) : null,
        });
      }
      return out;
    });

    return rows.map((row) => ({
      imdbId: row.imdbId,
      title: row.title,
      rating: row.rating,
      sourceRef: row.imdbId,
    }));
  } finally {
    await page.close().catch(() => {});
  }
}

/** The old route: drive a signed-in browser to IMDb's export flow. */
async function syncViaBrowser(ctx: SyncContext): Promise<WatchEvent[]> {
  return withBrowser(
    async (context) => {
      if (!(await isSignedIn(context))) {
        throw new Error('IMDb session has expired. Run:  npm run login');
      }
      try {
        const csv = await downloadRatingsCsv(context, ctx.log);
        const parsed = parseImdbRatingsCsv(csv);
        ctx.log(`  export contained ${parsed.length} rated titles`);
        return parsed;
      } catch (err) {
        ctx.log(`  export flow failed: ${err instanceof Error ? err.message : String(err)}`);
        return scrapeRatings(context, ctx.log);
      }
    },
    // Headless gets a 403 from IMDb's WAF now, session or no session.
    { headed: true },
  );
}

export const imdbSource: WatchSource = {
  id: SOURCE_ID,
  label: 'IMDb',
  requiresAuth: false,

  isConfigured: () => Boolean(config.imdbUserId) || hasBrowserProfile(),

  describe: () => {
    if (config.imdbUserId) {
      return (
        `Reading ${config.imdbUserId}'s public watch history — no login needed. ` +
        'Needs "Watch history" set to public in your IMDb privacy settings; making "Ratings" public too ' +
        'adds your scores and dates.'
      );
    }
    if (hasBrowserProfile()) {
      return 'Using the saved browser session. Set IMDB_USER_ID in .env for the no-login route instead.';
    }
    return 'Set IMDB_USER_ID in your .env file to your `ur…` id, and make your IMDb watch history public.';
  },

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!config.imdbUserId && !hasBrowserProfile()) {
      return {
        ...emptyResult(),
        message: 'IMDB_USER_ID is not set — add your `ur…` id to .env.',
      };
    }

    markSync(SOURCE_ID, 'running');
    try {
      const events = config.imdbUserId
        ? await fetchPublicLibrary(config.imdbUserId, ctx.log)
        : await syncViaBrowser(ctx);

      if (events.length === 0) {
        throw new Error(
          'IMDb returned nothing. Check that your watch history is public, or export the CSV from imdb.com and drop it on the Library page.',
        );
      }

      const result = await ingestEvents(events, SOURCE_ID, ctx.log);
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
