import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import fs from 'node:fs';
import { BROWSER_PROFILE_DIR, DOWNLOAD_DIR, config } from './config.ts';

/**
 * A single persistent Chromium profile, reused across runs.
 *
 * This is what keeps you logged into IMDb without the app ever handling your
 * password: you sign in once in a real browser window, and the cookies live in
 * `.data/browser-profile/` exactly as they would in any browser.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function hasBrowserProfile(): boolean {
  return fs.existsSync(BROWSER_PROFILE_DIR);
}

export async function withBrowser<T>(
  fn: (context: BrowserContext) => Promise<T>,
  options: { headed?: boolean; channel?: string } = {},
): Promise<T> {
  const channel = options.channel ?? config.browserChannel;

  const launch = (useChannel: string) =>
    chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      headless: !options.headed,
      acceptDownloads: true,
      downloadsPath: DOWNLOAD_DIR,
      viewport: { width: 1440, height: 900 },
      // Real Chrome ships its own correct UA; overriding it would undo the
      // point of using it.
      ...(useChannel ? { channel: useChannel } : { userAgent: UA }),
      locale: 'en-US',
      args: ['--disable-blink-features=AutomationControlled'],
    });

  let context: BrowserContext;
  try {
    context = await launch(channel);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Asked for a real browser that isn't installed — fall back rather than die.
    if (channel && /channel|Executable doesn't exist/i.test(message)) {
      console.warn(`  (${channel} not available, using bundled Chromium instead)`);
      context = await launch('');
    } else if (/Executable doesn't exist|browserType.launch/i.test(message)) {
      throw new Error(
        'Chromium is not installed for Playwright. Run:  npx playwright install chromium',
      );
    } else {
      throw err;
    }
  }

  try {
    return await fn(context);
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Is a given browser context signed in to IMDb?
 *
 * The `at-main` auth cookie is the signal, not the URL. IMDb's profile URL has
 * already moved once — it now lands on an opaque `/user/p.<hash>` rather than
 * `/user/ur…` — and checking the cookie survives that kind of change.
 */
export async function isSignedIn(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies('https://www.imdb.com');
  return cookies.some((cookie) => cookie.name === 'at-main' && Boolean(cookie.value));
}

/** Is the profile signed in to Letterboxd? */
export async function isLetterboxdSignedIn(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies('https://letterboxd.com');
  return cookies.some(
    (cookie) => cookie.name === 'letterboxd.signed.in.as' && Boolean(cookie.value),
  );
}

/**
 * Your numeric `ur…` id. It no longer appears in the profile URL, so it has to
 * be read out of the page body.
 */
export async function findImdbUserId(context: BrowserContext): Promise<string | null> {
  const page = await context.newPage();
  try {
    await page.goto('https://www.imdb.com/profile', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForTimeout(1200);
    return /\b(ur\d{6,})\b/.exec(await page.content())?.[1] ?? null;
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

/** True when the profile currently holds a valid IMDb session. */
export async function checkImdbSession(): Promise<{ signedIn: boolean; userId: string | null }> {
  if (!hasBrowserProfile()) return { signedIn: false, userId: null };

  return withBrowser(async (context) => {
    if (!(await isSignedIn(context))) return { signedIn: false, userId: null };
    return { signedIn: true, userId: await findImdbUserId(context) };
  });
}
