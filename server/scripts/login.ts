import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { withBrowser, isSignedIn, isLetterboxdSignedIn, findImdbUserId } from '../browser.ts';
import { setSetting } from '../db.ts';
import { ROOT, BROWSER_PROFILE_DIR } from '../config.ts';

/**
 * One-time interactive sign-in.
 *
 *   npm run login              both services
 *   npm run login imdb         just IMDb
 *   npm run login letterboxd   just Letterboxd
 *
 * Opens a real browser window and waits for you to log in yourself — password
 * managers, 2FA, CAPTCHAs and all. Nothing is typed by the script and no
 * credentials are stored; the session cookies simply persist in the profile
 * directory the way they would in any browser you leave signed in.
 */

const args = process.argv.slice(2).map((a) => a.toLowerCase().replace(/^--/, ''));
const services = args.filter((a) => a === 'imdb' || a === 'letterboxd');
const wantImdb = services.length === 0 || services.includes('imdb');
const wantLetterboxd = services.length === 0 || services.includes('letterboxd');

/**
 * `--chrome` drives your real installed Chrome instead of Playwright's bundled
 * Chromium. Cloudflare's Turnstile fingerprints the bundled build and traps it
 * in a CAPTCHA loop that never completes — which is exactly what Letterboxd's
 * sign-in hits. A genuine Chrome build normally sails through.
 *
 * Your session carries over between the two: cookies are encrypted against your
 * Windows account, not the browser binary.
 */
const channel = args.includes('chrome')
  ? 'chrome'
  : args.includes('edge')
    ? 'msedge'
    : undefined;

/** Wait for a sign-in to show up in the cookie jar. */
async function waitForSignIn(
  context: BrowserContext,
  label: string,
  check: (context: BrowserContext) => Promise<boolean>,
  minutes = 10,
): Promise<boolean> {
  const deadline = Date.now() + minutes * 60_000;
  let ticks = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await check(context)) return true;
    if (context.pages().length === 0) {
      console.log(`  Browser closed before ${label} sign-in completed.`);
      return false;
    }
    if (++ticks % 15 === 0) console.log(`  …still waiting for ${label} sign-in`);
  }
  console.log(`  Timed out waiting for ${label} sign-in.`);
  return false;
}

function writeEnv(key: string, value: string): void {
  const envPath = path.join(ROOT, '.env');
  try {
    let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const line = `${key}=${value}`;
    if (new RegExp(`^${key}=.*$`, 'm').test(text)) {
      text = text.replace(new RegExp(`^${key}=.*$`, 'm'), line);
    } else {
      text += `${text.endsWith('\n') || text === '' ? '' : '\n'}${line}\n`;
    }
    fs.writeFileSync(envPath, text);
    console.log(`  Saved ${key} to .env`);
  } catch {
    console.log(`  (Couldn't write .env — add ${key}=${value} yourself.)`);
  }
}

console.log(`
  Opening ${channel === 'chrome' ? 'your installed Chrome' : channel === 'msedge' ? 'your installed Edge' : "Playwright's Chromium"} for sign-in.

  Log in as you normally would. The window closes on its own once each
  sign-in is detected.${
    channel
      ? ''
      : `

  If Letterboxd traps you in a Cloudflare CAPTCHA that keeps reloading, retry
  with your real browser instead — it usually passes:
      npm run login letterboxd --chrome`
  }

  Your password is never seen or stored by this app — only the session
  cookies, which live in:
    ${BROWSER_PROFILE_DIR}
`);

await withBrowser(
  async (context) => {
    const page = context.pages()[0] ?? (await context.newPage());

    if (wantImdb) {
      if (await isSignedIn(context)) {
        console.log('IMDb: already signed in.');
      } else {
        console.log('IMDb: waiting for you to sign in…');
        await page.goto('https://www.imdb.com/registration/signin', {
          waitUntil: 'domcontentloaded',
        });
        if (await waitForSignIn(context, 'IMDb', isSignedIn)) {
          console.log('IMDb: signed in.');
        }
      }

      const userId = await findImdbUserId(context);
      if (userId) {
        setSetting('imdb_user_id', userId);
        console.log(`IMDb: user id ${userId}`);
        writeEnv('IMDB_USER_ID', userId);
      }
    }

    if (wantLetterboxd) {
      if (await isLetterboxdSignedIn(context)) {
        console.log('\nLetterboxd: already signed in.');
      } else {
        console.log('\nLetterboxd: waiting for you to sign in…');
        console.log('  (This is what lets the app download your full history export.)');
        await page.goto('https://letterboxd.com/sign-in/', { waitUntil: 'domcontentloaded' });
        if (await waitForSignIn(context, 'Letterboxd', isLetterboxdSignedIn)) {
          console.log('Letterboxd: signed in.');
        }
      }
    }

    console.log('\n  Done. Future syncs run without a login step.\n');
  },
  { headed: true, channel },
);

process.exit(0);
