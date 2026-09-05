import { letterboxdSource } from './letterboxd.ts';
import { imdbSource } from './imdb.ts';
import { traktSource } from './trakt.ts';
import type { SyncResult, WatchSource } from './types.ts';
import { db } from '../db.ts';
import { queueUnindexedLibrary } from '../indexer.ts';

export const sources: WatchSource[] = [letterboxdSource, imdbSource, traktSource];

export function getSource(id: string): WatchSource | undefined {
  return sources.find((s) => s.id === id);
}

/** Rolling log of the current or most recent sync, surfaced in the UI. */
const LOG_LIMIT = 300;

export interface SyncRunState {
  running: boolean;
  source: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lines: string[];
  error: string | null;
  results: Record<string, SyncResult>;
}

const state: SyncRunState = {
  running: false,
  source: null,
  startedAt: null,
  finishedAt: null,
  lines: [],
  error: null,
  results: {},
};

function log(message: string): void {
  state.lines.push(message);
  if (state.lines.length > LOG_LIMIT) state.lines.splice(0, state.lines.length - LOG_LIMIT);
  console.log(message);
}

export function getSyncState(): SyncRunState {
  return { ...state, lines: [...state.lines] };
}

/**
 * Run one source, or every configured source when `sourceId` is omitted.
 * Serialised — concurrent syncs would fight over the browser profile and the
 * TMDB rate limit for no benefit.
 */
export async function runSync(options: {
  sourceId?: string;
  full?: boolean;
}): Promise<SyncRunState> {
  if (state.running) return getSyncState();

  const targets = options.sourceId
    ? [getSource(options.sourceId)].filter((s): s is WatchSource => Boolean(s))
    : sources.filter((s) => s.isConfigured());

  state.running = true;
  state.source = options.sourceId ?? 'all';
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.lines = [];
  state.error = null;
  state.results = {};

  try {
    if (targets.length === 0) {
      log('No sources are configured yet. Add LETTERBOXD_USER and IMDB_USER_ID to .env.');
    }

    for (const source of targets) {
      if (!source.isConfigured()) {
        log(`${source.label}: skipped — ${source.describe()}`);
        continue;
      }
      try {
        const result = await source.sync({ full: options.full ?? false, log });
        state.results[source.id] = result;
        log(
          `${source.label}: ${result.added} added, ${result.updated} updated, ` +
            `${result.unresolved} needing a look (${result.scanned} scanned)`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.error = `${source.label}: ${message}`;
        log(`${source.label}: FAILED — ${message}`);
      }
    }

    const queued = queueUnindexedLibrary();
    if (queued > 0) log(`Indexing cast for ${queued} new title${queued === 1 ? '' : 's'}…`);
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }

  return getSyncState();
}

export interface SourceStatus {
  id: string;
  label: string;
  configured: boolean;
  requiresAuth: boolean;
  description: string;
  lastRunAt: string | null;
  lastOkAt: string | null;
  status: string | null;
  message: string | null;
  titleCount: number;
}

export function sourceStatuses(): SourceStatus[] {
  return sources.map((source) => {
    const row = db
      .prepare('SELECT last_run_at, last_ok_at, status, message FROM sync_state WHERE source = ?')
      .get(source.id) as
      | { last_run_at: string | null; last_ok_at: string | null; status: string | null; message: string | null }
      | undefined;

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM watched WHERE source = ?')
      .get(source.id) as { n: number };

    return {
      id: source.id,
      label: source.label,
      configured: source.isConfigured(),
      requiresAuth: source.requiresAuth,
      description: source.describe(),
      lastRunAt: row?.last_run_at ?? null,
      lastOkAt: row?.last_ok_at ?? null,
      status: row?.status ?? null,
      message: row?.message ?? null,
      titleCount: count.n,
    };
  });
}
