import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, CLIENT_DIST } from './config.ts';
import type { MediaType } from './db.ts';
import { getSetting, setSetting } from './db.ts';
import {
  getIndexProgress,
  queueUnindexedLibrary,
  queueForIndexing,
  rebuildIndex,
} from './indexer.ts';
import { importFile, findExports, importFromDisk } from './import.ts';
import { resolveManually } from './ingest.ts';
import { markWatched } from './sources/manual.ts';
import { runSync, getSyncState, sourceStatuses } from './sources/index.ts';
import { checkImdbSession } from './browser.ts';
import { searchByType, nameOf, yearOf } from './tmdb.ts';
import { img } from './config.ts';
import { db } from './db.ts';
import {
  search,
  searchPersons,
  getTitle,
  getPersonPage,
  libraryStats,
  recentlyWatched,
  libraryTitles,
  unresolvedRows,
} from './queries.ts';

const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });

await app.register(multipart, { limits: { fileSize: 256 * 1024 * 1024, files: 10 } });

const asMediaType = (value: string): MediaType => {
  if (value !== 'movie' && value !== 'tv') throw new Error(`Bad media type: ${value}`);
  return value;
};

// ---------------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------------

app.get('/api/health', async () => ({
  ok: true,
  tmdbKey: Boolean(config.tmdbKey),
  letterboxdUser: config.letterboxdUser || null,
}));

app.get('/api/stats', async () => ({
  ...libraryStats(),
  indexing: getIndexProgress(),
}));

app.get('/api/recent', async () => recentlyWatched(24));

app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
  const query = (req.query.q ?? '').trim();
  if (!query) return { titles: [], people: [] };
  return search(query);
});

app.get<{ Querystring: { q?: string } }>('/api/search/people', async (req) => {
  const query = (req.query.q ?? '').trim();
  if (!query) return [];
  return searchPersons(query);
});

app.get<{ Params: { mediaType: string; id: string } }>(
  '/api/title/:mediaType/:id',
  async (req) => getTitle(Number(req.params.id), asMediaType(req.params.mediaType)),
);

app.get<{ Params: { id: string } }>('/api/person/:id', async (req) =>
  getPersonPage(Number(req.params.id)),
);

app.get<{ Querystring: { type?: string; q?: string; offset?: string } }>(
  '/api/library',
  async (req) => {
    const type = req.query.type === 'movie' || req.query.type === 'tv' ? req.query.type : undefined;
    return libraryTitles({
      mediaType: type,
      query: req.query.q?.trim() || undefined,
      offset: Number(req.query.offset ?? 0),
      limit: 60,
    });
  },
);

// ---------------------------------------------------------------------------
// Library mutations
// ---------------------------------------------------------------------------

app.post<{ Body: { tmdbId: number; mediaType: string; watched: boolean } }>(
  '/api/watched',
  async (req) => {
    const { tmdbId, mediaType, watched } = req.body;
    await markWatched(Number(tmdbId), asMediaType(mediaType), Boolean(watched));
    return { ok: true };
  },
);

app.post('/api/import', async (req, reply) => {
  const files = req.files();
  const results = [];

  for await (const file of files) {
    const buffer = await file.toBuffer();
    try {
      results.push(await importFile(file.filename, new Uint8Array(buffer), console.log));
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (results.length === 0) {
    reply.code(400);
    return { error: 'No file was uploaded.' };
  }
  return { results };
});

/** Export files sitting in Downloads that we could import without a drag. */
app.get('/api/import/found', async () => ({ files: findExports() }));

app.post<{ Body: { file: string } }>('/api/import/found', async (req, reply) => {
  const wanted = req.body?.file;
  // Only ever import something we ourselves listed — never an arbitrary path.
  const allowed = findExports().some((f) => f.file === wanted);
  if (!allowed) {
    reply.code(400);
    return { error: 'That file is no longer available to import.' };
  }
  try {
    return { result: await importFromDisk(wanted, console.log) };
  } catch (err) {
    reply.code(400);
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

// ---------------------------------------------------------------------------
// Unresolved queue
// ---------------------------------------------------------------------------

app.get('/api/unresolved', async () => unresolvedRows());

app.get<{ Params: { id: string } }>('/api/unresolved/:id/candidates', async (req) => {
  const row = db
    .prepare('SELECT raw_title, raw_year, media_hint FROM unresolved WHERE id = ?')
    .get(Number(req.params.id)) as
    | { raw_title: string; raw_year: number | null; media_hint: string | null }
    | undefined;
  if (!row) return [];

  const types: MediaType[] =
    row.media_hint === 'movie' || row.media_hint === 'tv'
      ? [row.media_hint]
      : ['movie', 'tv'];

  const out = [];
  for (const type of types) {
    const results = await searchByType(row.raw_title, type, row.raw_year ?? undefined);
    for (const result of results.slice(0, 6)) {
      out.push({
        tmdbId: result.id,
        mediaType: type,
        name: nameOf(result),
        year: yearOf(result),
        poster: img(result.poster_path, 'w185'),
      });
    }
  }
  return out;
});

app.post<{ Params: { id: string }; Body: { tmdbId: number; mediaType: string } }>(
  '/api/unresolved/:id/resolve',
  async (req) => {
    await resolveManually(
      Number(req.params.id),
      Number(req.body.tmdbId),
      asMediaType(req.body.mediaType),
    );
    return { ok: true };
  },
);

app.post<{ Params: { id: string } }>('/api/unresolved/:id/ignore', async (req) => {
  db.prepare(`UPDATE unresolved SET status = 'ignored' WHERE id = ?`).run(
    Number(req.params.id),
  );
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Sync + settings
// ---------------------------------------------------------------------------

app.get('/api/sources', async () => ({
  sources: sourceStatuses(),
  sync: getSyncState(),
  indexing: getIndexProgress(),
}));

app.get('/api/sync/state', async () => ({
  sync: getSyncState(),
  indexing: getIndexProgress(),
}));

app.post<{ Body: { source?: string; full?: boolean } }>('/api/sync', async (req) => {
  const { source, full } = req.body ?? {};
  // Fire and forget — the UI polls /api/sync/state for progress.
  void runSync({ sourceId: source, full }).catch((err) => console.error('sync failed', err));
  await new Promise((r) => setTimeout(r, 150));
  return getSyncState();
});

app.post('/api/reindex', async () => {
  const queued = queueUnindexedLibrary();
  return { queued };
});

/** Full rebuild — re-pulls every cast, picking up changed selection rules. */
app.post('/api/reindex/all', async () => ({ queued: rebuildIndex() }));

app.post<{ Body: { tmdbId: number; mediaType: string } }>('/api/reindex/title', async (req) => {
  queueForIndexing(Number(req.body.tmdbId), asMediaType(req.body.mediaType), true);
  return { ok: true };
});

app.get('/api/session/imdb', async () => checkImdbSession());

app.get('/api/settings', async () => ({
  tmdbKey: Boolean(config.tmdbKey),
  letterboxdUser: config.letterboxdUser,
  imdbUserId: config.imdbUserId || getSetting('imdb_user_id'),
  autoSync: getSetting('auto_sync', 'on') === 'on',
}));

app.post<{ Body: { autoSync?: boolean } }>('/api/settings', async (req) => {
  if (typeof req.body?.autoSync === 'boolean') {
    setSetting('auto_sync', req.body.autoSync ? 'on' : 'off');
  }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Static client (production build). In dev, Vite serves the UI and proxies here.
// ---------------------------------------------------------------------------

if (fs.existsSync(CLIENT_DIST)) {
  await app.register(fastifyStatic, { root: CLIENT_DIST });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404);
      return { error: 'Not found' };
    }
    return reply.sendFile('index.html');
  });
}

app.setErrorHandler((err: FastifyError, _req, reply) => {
  console.error(err);
  reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500);
  return { error: err.message };
});

// ---------------------------------------------------------------------------
// Background schedule
// ---------------------------------------------------------------------------

const MINUTE = 60_000;

function startSchedule(): void {
  // Catch up on anything imported but never indexed (e.g. after a crash).
  const queued = queueUnindexedLibrary();
  if (queued > 0) console.log(`Indexing cast for ${queued} title(s) from a previous run…`);

  const autoSyncOn = () => getSetting('auto_sync', 'on') === 'on';

  // Letterboxd RSS is cheap and needs no auth, so poll it often.
  setInterval(() => {
    if (autoSyncOn() && config.letterboxdUser) {
      void runSync({ sourceId: 'letterboxd', full: false }).catch(() => {});
    }
  }, 30 * MINUTE);

  // IMDb drives a browser, so once a day is plenty.
  setInterval(
    () => {
      if (autoSyncOn()) void runSync({ sourceId: 'imdb' }).catch(() => {});
    },
    24 * 60 * MINUTE,
  );

  // A first pull shortly after boot so a freshly opened app is current.
  setTimeout(() => {
    if (autoSyncOn() && config.letterboxdUser) {
      void runSync({ sourceId: 'letterboxd', full: false }).catch(() => {});
    }
  }, 5000);
}

/** Addresses this machine can be reached on from other devices on the network. */
function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => net!.address);
}

const port = config.port;
await app.listen({ port, host: config.host });

console.log(`\n  Actor Explorer running at http://localhost:${port}`);
if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
  for (const address of lanAddresses()) {
    console.log(`  On your phone:            http://${address}:${port}`);
  }
}
console.log('');
if (!config.tmdbKey) {
  console.log('  ⚠ TMDB_API_KEY is not set. Copy .env.example to .env and add your key.\n');
}
startSchedule();
