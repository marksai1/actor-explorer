# Actor Explorer

*Where do I know them from?* — answered against only the things you've actually watched.

Search a film or show, tap a face in the cast, and get their filmography with everything
you've seen pulled to the top and ranked by how likely it is to be the connection. The
other 84 credits you don't care about stay dimmed and collapsed underneath.

Your library keeps itself current with no logins anywhere: films sync from your public
Letterboxd feed, shows from your public IMDb watch history. Setup is three lines in a
config file.

---

## Setup

Needs [Node.js](https://nodejs.org) 22.13 or newer — `node:sqlite` sits behind a flag
before that. Nothing else to install.

```bash
npm install
cp .env.example .env     # then fill it in
```

Edit `.env`:

| Variable | Needed? | What it is |
|---|---|---|
| `TMDB_API_KEY` | **required** | v3 key from [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) — the short one, not the long v4 bearer token |
| `LETTERBOXD_USER` | for films | your handle, e.g. `marks` from `letterboxd.com/marks` |
| `IMDB_USER_ID` | for shows | your `ur…` id from [imdb.com/profile](https://www.imdb.com/profile) — the whole profile URL works too |

Then, on IMDb, **Account Settings → Privacy**, set both to public:

- **Watch history** — this is what makes show sync work at all
- **Ratings** — optional, but it adds your scores and rating dates, which the ranking uses

Check it all landed with `npm run doctor`, which tells you exactly which piece is wrong.

Then:

```bash
npm run build      # build the UI
npm start          # http://localhost:8787
```

For development with hot reload, `npm run dev` instead (UI on :5173, API on :8787).

---

## On your phone

Two ways in, and they are independent of each other. The first needs your PC awake on
the same Wi-Fi. The second needs nothing at all — not the PC, not even a connection.

### Over your network

The server listens on your whole network, so `npm start` prints a second address:

```
  Actor Explorer running at http://localhost:8787
  On your phone:            http://192.168.4.28:8787
```

Open that in Safari on the same Wi-Fi. It is the full app — sync, imports, marking
things as seen — but it lives and dies with the terminal window, and there is no
offline cache, because a service worker needs HTTPS and this is plain HTTP over your
LAN. There is also no login on it: anyone on the same network can read your library,
which is usually fine at home. On a network you do not trust, set `HOST=127.0.0.1`.

If the phone cannot connect, it is almost always Windows Firewall — allow `node.exe`
on inbound connections for your current network profile.

### Published, and genuinely offline

`npm run snapshot` flattens the library — every title, the whole cast index, your
ratings and watch dates — into a single file, encrypts it, and writes it to
`client/public/data/library.enc`. GitHub Pages serves that next to the app; your phone
decrypts it once and keeps it. After that the app runs entirely on the device. No
server, no laptop, no connection.

```bash
npm run sync         # pull Letterboxd + IMDb, and index the new casts
npm run snapshot     # asks for a passphrase, encrypts the result
git add client/public/data     # both files: the snapshot and its timestamp
git commit -m "Refresh snapshot"
git push             # the Action builds and publishes
```

Then open the Pages URL on the phone, enter the passphrase once, and **Share → Add to
Home Screen**. It installs as a standalone app the same way, and launches offline.

**Why it is encrypted.** GitHub Pages sites are public — private Pages needs an
Enterprise plan — and this repository is meant to be public. The code is fine to
publish; a file listing everything you have watched and what you scored it is a
different matter. So the app travels in the clear and the library travels as
AES-256-GCM ciphertext under a key stretched from your passphrase with 600,000 rounds
of PBKDF2. What is published is the app plus an opaque blob.

**The passphrase is asked for once.** The derived key is kept in IndexedDB, not the
passphrase, and it is stored non-extractable — usable for decryption, never readable
back out. The salt is deliberately carried over from the previous build, which is what
lets a phone that already holds the key open tomorrow's snapshot with no prompt.

**What does not come along.** Two things in the app are live TMDB calls with no local
equivalent: an actor's biography, and the dimmed "rest of their work" section. Offline
they are simply absent, and the UI already handles that. Posters are TMDB CDN URLs, so
they need a connection the first time — the service worker keeps every one you have
looked at, so pages you revisit are complete offline. Everything the ranking depends
on is local, and the phone imports the very same `server/scoring.ts` the desktop uses,
so the two cannot disagree about where you know someone from.

**It is read-only.** Sync, imports, "needs a look" and *Mark as seen* all belong to the
machine that holds the database; the published copy hides them rather than offering
buttons that cannot work.

**Refreshing takes two commands, not one.** `npm run snapshot` only exports what is
already in the database — it does not sync. `npm run sync` is what pulls from
Letterboxd and IMDb, and it waits for the cast indexer before it exits, so the two in
that order give you a complete refresh. While `npm start` is running, sync happens on
its own and the snapshot step alone is enough; with the server stopped, skipping the
sync publishes stale data without saying so. The phone then picks the new snapshot up
on its next launch and swaps itself over without asking for anything.

**Sizes.** 227 titles, 18,642 people and 23,180 credits come to 1.8 MB of JSON, 847 KB
once gzipped and encrypted. The 28 MB in `.data/db.sqlite` is mostly the TMDB response
cache, which is a build-time convenience and does not travel.

### First-time setup for the published copy

1. Push this repository to GitHub. It is safe to make public — `.env` and `.data/` are
   gitignored, and nothing else contains a key, a handle or an id.
2. **Settings → Pages → Source: GitHub Actions.**
3. `npm run snapshot`, commit `client/public/data/library.enc`, push.
4. The workflow builds and deploys. Your URL is `https://<you>.github.io/<repo>/`.

`BASE_PATH` is taken from the repository name automatically, so a rename needs no
edit. On a custom domain or a `<you>.github.io` user site, set `BASE_PATH=/`.

---

## Getting your library in

### Films — ongoing sync needs no login

Set `LETTERBOXD_USER` and routine syncing works immediately. Your public RSS feed hands
over a TMDB id per diary entry, so new films need no matching at all. It's polled every
30 minutes and Cloudflare never challenges it.

For your **whole history**, do this once:

1. Export your data from [letterboxd.com/settings/data](https://letterboxd.com/settings/data/)
   in your normal browser
2. On the Library page, hit **Check my Downloads** and click Import

That reads the official export — complete, with ratings and real diary dates attached.

**Why it's manual:** two automated routes were tried and neither is dependable.

- *Scraping the public films grid.* Cloudflare blocks paginated grid URLs after page one —
  not only for headless clients, but for a real visible browser doing genuine in-site
  navigation, and it does not clear however long you wait.
- *Downloading the export through a logged-in session.* The sign-in page itself loads fine,
  but Letterboxd runs a Cloudflare check on the **login submission** that automated browsers
  can't clear; you get bounced back to a fresh sign-in screen forever.

`npm run login letterboxd` and the session-based `downloadExportZip` are still in the code
and will be used if a Letterboxd session ever exists, so if Cloudflare relaxes this starts
working with no changes. Until then, exporting in your own browser takes under a minute and
**Check my Downloads** removes the drag-and-drop step. Ongoing sync never needed any of
this — RSS handles it automatically.

### Shows — no login either

Set `IMDB_USER_ID` and make your watch history public, and that's the whole setup. Sync
reads your history straight from IMDb's own GraphQL API as an anonymous caller, the same
way a public Letterboxd profile can be read. Nothing to sign into, nothing to re-do when
a session expires.

Two things make this work, and both are worth knowing if it ever breaks:

- **`www.imdb.com` is unusable to a script.** It sits behind an Amazon WAF that serves a
  CAPTCHA to anything automated — signed in or not, headless or headed, real Chrome or
  bundled Chromium. `api.graphql.imdb.com` has no such gate and answers a plain anonymous
  `fetch`.
- **The API can be asked about a named user.** Its title search takes
  `singleUserWatchedConstraint { userId }` — someone else's id, not the caller's — with
  matching sort orders. Your `ur…` id is genuinely all it needs.

The one gate is IMDb's privacy setting, and the API says so in as many words when it's
off ("User's watch history is not public"). Those refusals are translated into the
setting to go and change, so a failed sync tells you which toggle to flip.

Watch history is IMDb's superset — everything you've watched, rated, reviewed or checked
into — so one request gets every title, with your score attached to the ones you rated.
If watch history is private but ratings aren't, sync falls back to ratings alone.

**Maintenance: none.** No session to refresh, no export to redo. If IMDb ever moves the
endpoint, `npm run doctor` will say so and the file-drop path below still works.

### Files — always available

Drag an IMDb ratings CSV or a Letterboxd export ZIP onto the Library page anytime, or hit
**Check my Downloads** to have the app find one you've already downloaded and import it
with a click. Same parsers, same dedupe. Nothing here depends on the automated sync
working, so you are never locked out of your own data.

### Anything you never rated

You rate what you enjoyed, so plenty of things you've watched aren't in either export.
**Mark as seen** on any title page patches those holes. It writes under its own source
and never fights with what IMDb or Letterboxd report.

---

## Setting this up for someone else

Zip the folder **excluding `node_modules/`, `dist/`, `.data/` and `.env`** — `.data/`
holds your database and a browser profile with your own session cookies in it, so it must
not travel. Everything personal is in those two, which is the whole reason this is
portable. Ship a blank `.env` (a copy of `.env.example`) so there's one less step at the
other end.

### What to install first

**[Node.js](https://nodejs.org) 22.13 or newer** — the current LTS is fine, and `npm`
comes with it. That is the only install: no Python, no database, no VSCode, no browser
downloads. VSCode is worth having if you want to edit code, but nothing here requires it.

### Opening a terminal in the folder

Every command below is typed into a terminal that is *pointed at this folder*. There is
no need to install one — both Windows and macOS ship with it.

1. Unzip somewhere permanent — Documents, not Downloads
2. Open the folder until you can see `package.json` sitting in it
3. **Windows:** right-click blank space inside the folder → **Open in Terminal**.
   **macOS:** right-click the folder → Services → **New Terminal at Folder**
4. Type `node --version`. A number means you're set; "not recognised" means Node didn't install

### Then

1. `npm install` — about 45 seconds
2. Get a free TMDB key at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) — about two minutes
3. Open `.env` in any text editor (right-click → Open with → Notepad is fine) and fill in
   three lines: TMDB key, Letterboxd handle, IMDb `ur…` id
4. On IMDb, **Account Settings → Privacy**, set **Watch history** and **Ratings** to public
5. `npm run doctor` — a PASS/FAIL line per piece, naming whichever one is wrong
6. `npm run build`, then `npm start`

No step involves a password, a browser window, or an export file. If the doctor is green,
sync is green.

### The three things that actually go wrong

- **`ENOENT: package.json`** — the terminal is one folder too high. Unzipping often nests
  a folder inside a folder. `dir` (or `ls`) should list `package.json`, `server`,
  `client`; if it doesn't, go one level in and try again.
- **Closing the terminal window stops the app.** `npm start` runs until stopped. That
  window stays open the whole time the app is in use — minimised is fine, closed is not.
  The phone URL dies with it too.
- **`npm start` on a fresh copy shows nothing.** Steps 1 and 6 are once-only: without
  `npm install` there are no dependencies, without `npm run build` there is no UI to
  serve. After that first run, `npm start` on its own is genuinely all it takes.

**Keeping it running.** Nothing expires, so there's no routine maintenance. Sync runs
every 30 minutes on its own while `npm start` is going. Two things they might hit:

- *A show they watched isn't there.* IMDb only knows what was rated or checked in. Use
  **Mark as seen** on the title page for the rest.
- *Sync starts failing.* Run `npm run doctor`. If it reports a privacy problem, a toggle
  got flipped back. If it reports the API moved, use the CSV drop on the Library page
  until it's fixed — that path has no dependency on any of this.

---

## How it works

The interesting problem is speed. Asking *"how many things I've watched is this actor
in?"* would cost one TMDB call per face — unusable for a 30-person cast grid.

So the cost is paid once, at import: **when a title enters your library, its cast is
fetched and stored as person↔title rows.** Overlap then becomes a local SQL count.
Cast grids and actor pages render with zero network calls; only the dimmed "rest of
their career" section hits TMDB live. Browsing a title indexes it too, so the data
keeps improving as you use the app.

### What gets indexed

Billing order is a bad ranking for television. TMDB's aggregate credits bury recurring
guests — Scott Adsit sits **538th** in Veep despite nine episodes, and 501st in The
Office — so any billing-based cutoff at a sane depth throws away exactly the connections
this app exists to find.

So TV casts are ranked by **episode count first**, billing only as a tiebreak, and cut at
500. Films have no episode count, so billing is all there is; they cut at 80. Re-indexing
replaces a title's rows rather than merging, so a rule change actually takes effect.

If you change these rules, rebuild: `npm run reindex -- --all`.

### Ranking

Sorting an actor's overlap by date or popularity answers the wrong question. What makes
a face recognisable is how much screen time you spent with it, weighted by how memorable
the thing was to you. `server/scoring.ts` blends:

- **time on screen** — episode count for TV, billing position for film. A 60-episode
  series regular is tens of hours with a face, more than any single film gives, so a long
  run reaches the top of the scale on its own; billing can help a short run but never
  caps a long one.
- **memorability** — your rating of the title, and how recently you watched it
- **reach** — title popularity, log-scaled, as a gentle tiebreak only

The top card is flagged *most likely* only when it wins by a clear margin. When two
credits are genuinely a toss-up, the UI doesn't pretend otherwise.

This is the part most worth tuning to you. If a result feels wrong, the weights are all
in one small file.

### Matching

Resolution runs in descending order of certainty:

1. a TMDB id the source already knew (Letterboxd RSS)
2. an IMDb `tt` const, resolved exactly via TMDB's find endpoint
3. title + year search, accepted **only** when unambiguous

Anything that falls through lands in the **Needs a look** queue on the Library page for
one-click fixing. That's deliberate — a wrong auto-match quietly pollutes the library and
is much more annoying to discover later than a row waiting for a click. Rating a single
episode on IMDb resolves up to its parent series.

---

## Commands

| Command | Does |
|---|---|
| `npm run dev` | dev servers with hot reload |
| `npm start` | production server |
| `npm run build` | build the UI |
| `npm run snapshot` | build and encrypt the offline snapshot for publishing |
| `npm run build:static` | build the offline app into `dist-static/` |
| `npm run preview:static` | serve that build locally, to check it before pushing |
| `npm run icons` | redraw the home-screen icons from the brand mark |
| `npm run doctor` | check your key, feeds and IMDb privacy settings; says which one broke |
| `npm run login letterboxd` | optional sign-in, only for Letterboxd export backfill |
| `npm run sync` | incremental sync from the command line |
| `npm run sync -- --full` | full backfill |
| `npm run sync -- --source letterboxd` | sync one source |
| `npm run reindex` | index any titles that were missed |
| `npm run reindex -- --all` | re-pull every cast from scratch |
| `npm run verify` | check the parsers, index and ranking still behave |
| `npm run typecheck` | typecheck server and client |

Press `/` anywhere in the UI to jump to search. The search box takes **actor names** as
well as titles — people you've seen come first, badged with how many of your watched
titles they appear in.

---

## Layout

```
server/
  db.ts            SQLite schema (node:sqlite — no native build)
  tmdb.ts          TMDB client: disk cache, rate limit, retry
  indexer.ts       the cast index — the thing that makes it fast
  scoring.ts       "where do I know them from" ranking
  match.ts         conservative title/year matching
  ingest.ts        watch events -> library rows
  queries.ts       the read side
  snapshot.ts      flattens the database into the offline snapshot
  snapshot-crypto.ts  AES-GCM envelope for publishing it
  sources/
    letterboxd.ts  public RSS + films-grid backfill, no auth
    imdb-api.ts    public watch history via IMDb's GraphQL, no auth
    imdb.ts        source adapter; legacy browser export kept as a fallback
    parsers.ts     IMDb CSV + Letterboxd ZIP
    manual.ts      the "seen it" toggle
    trakt.ts       stub — see below
client/            React + Vite, hand-written CSS
  src/static/      the same read side, offline: decrypt, index, serve the pages
  public/sw.js     service worker — app shell and poster cache
.data/             database, browser profile, downloads (gitignored)
```

### Trakt

Stremio can scrobble everything you watch to Trakt automatically, and Trakt has a real
OAuth API returning both IMDb and TMDB ids — no scraping, no session to expire. The
adapter is written against the source interface but switched off. Turning it on is config
plus the fetch calls in `server/sources/trakt.ts`, not a refactor: `ingestEvents` already
accepts the shape Trakt returns.

---

## Notes

- Everything runs locally. The only outbound calls are TMDB, Letterboxd and IMDb.
- TMDB responses are cached on disk with per-endpoint TTLs, so repeat browsing is free
  and re-syncs are cheap.
- On IMDb's API: it's an internal endpoint rather than a documented product, and its
  responses carry a non-commercial-use disclaimer. Reading your own history a couple of
  times an hour is well within that, but it can move without notice — which is why the
  CSV drop stays in the code as the backstop.
- The Playwright dependency is now optional. Nothing in the default setup launches a
  browser; it's only used by `npm run login letterboxd` and the legacy IMDb fallback. If
  you never touch either, you can skip `npx playwright install chromium` entirely.
