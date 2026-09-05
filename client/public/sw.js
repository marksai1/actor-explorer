/**
 * Offline for the published build.
 *
 * The app shell is served from cache and refreshed behind you, so a launch with
 * no connection is the same launch as any other. Posters can't be shipped —
 * there are eighteen thousand faces in the index and they live on TMDB's CDN —
 * so instead every one you actually look at is kept, and the pages you revisit
 * are complete offline while the ones you never opened fall back to the
 * placeholder the UI already draws.
 *
 * The library snapshot itself is not cached here: it is decrypted once and kept
 * in IndexedDB, which is where the app reads it from.
 */

const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const IMAGES = `tmdb-images-${VERSION}`;

/** Roughly a few hundred posters and faces — a handful of megabytes. */
const IMAGE_LIMIT = 600;

const BASE = new URL(self.registration.scope).pathname;
const INDEX = `${BASE}index.html`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll([INDEX, `${BASE}manifest.webmanifest`]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== SHELL && name !== IMAGES)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Keeps the image cache from growing without bound; keys come back oldest first. */
async function trim(cache, limit) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - limit))) {
    await cache.delete(key);
  }
}

async function cacheFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  // Opaque cross-origin responses are fine to keep: they still render.
  if (response.ok || response.type === 'opaque') {
    await cache.put(request, response.clone());
    if (limit) void trim(cache, limit);
  }
  return response;
}

/**
 * Serve what we have, replace it in the background. A deploy is therefore
 * picked up on the launch after the one that noticed it, which is the right
 * trade for an app that has to open instantly and offline.
 */
async function staleWhileRevalidate(request, cacheName, fallbackTo) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(fallbackTo ?? request);

  const network = fetch(request)
    .then((response) => {
      if (response.ok) void cache.put(fallbackTo ?? request, response.clone());
      return response;
    })
    .catch(() => null);

  return hit ?? (await network) ?? Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.hostname === 'image.tmdb.org') {
    event.respondWith(cacheFirst(request, IMAGES, IMAGE_LIMIT));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Every in-app route is the same document; the router takes it from there.
  if (request.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(request, SHELL, INDEX));
    return;
  }

  // Vite fingerprints these, so a hit is always the right build.
  if (url.pathname.startsWith(`${BASE}assets/`)) {
    event.respondWith(cacheFirst(request, SHELL));
    return;
  }

  // The snapshot is deliberately not cached here. meta.json has to be fresh or
  // a refresh can never be noticed, and library.enc is decrypted into IndexedDB
  // the moment it arrives — caching the ciphertext as well would mean holding
  // the same library twice and risk handing back the copy we just replaced.
  if (url.pathname.startsWith(`${BASE}data/`)) return;

  if (url.pathname.startsWith(BASE)) {
    event.respondWith(staleWhileRevalidate(request, SHELL));
  }
});
