import { useCallback, useEffect, useRef, useState } from 'react';
import { api, IS_STATIC } from '../api';
import type {
  Candidate,
  IndexProgress,
  MediaType,
  SourceStatus,
  Stats,
  SyncState,
  TitleCard,
  UnresolvedRow,
} from '../api';
import { Empty, Icon, TitleTile, useToast } from '../components';

function statusClass(source: SourceStatus, syncing: boolean): string {
  if (syncing) return 'status-dot status-running';
  if (source.status === 'error') return 'status-dot status-error';
  if (source.status === 'ok') return 'status-dot status-ok';
  return 'status-dot';
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes)) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// --- unresolved fixer -------------------------------------------------------

function FixRow({ row, onDone }: { row: UnresolvedRow; onDone: () => void }) {
  const toast = useToast();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .candidates(row.id)
      .then(setCandidates)
      .catch(() => setCandidates([]));
  }, [row.id]);

  async function choose(candidate: Candidate) {
    setBusy(true);
    try {
      await api.resolve(row.id, candidate.tmdbId, candidate.mediaType);
      toast.show(`Linked “${row.raw_title}” to ${candidate.name}`);
      onDone();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'bad');
      setBusy(false);
    }
  }

  return (
    <div className="fix-row" style={busy ? { opacity: 0.5 } : undefined}>
      <div className="fix-head">
        <span className="fix-title">
          {row.raw_title} {row.raw_year && <span className="muted">({row.raw_year})</span>}
        </span>
        <span className="pill">{row.source}</span>
        <div className="fix-actions">
          <button
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api.ignore(row.id).catch(() => {});
              onDone();
            }}
          >
            Ignore
          </button>
        </div>
      </div>

      {candidates === null && <div className="hint" style={{ marginTop: 8 }}>Looking for matches…</div>}
      {candidates?.length === 0 && (
        <div className="hint" style={{ marginTop: 8 }}>
          No TMDB matches found for this title.
        </div>
      )}
      {candidates && candidates.length > 0 && (
        <div className="cand-row">
          {candidates.map((candidate) => (
            <button
              key={`${candidate.mediaType}-${candidate.tmdbId}`}
              className="cand"
              onClick={() => choose(candidate)}
              disabled={busy}
            >
              {candidate.poster ? (
                <img src={candidate.poster} alt={candidate.name} loading="lazy" />
              ) : (
                <div style={{ aspectRatio: '2/3', background: 'var(--surface-2)', borderRadius: 5 }} />
              )}
              <div className="cand-name">{candidate.name}</div>
              <div className="card-sub" style={{ fontSize: 11 }}>
                {candidate.year ?? '—'} · {candidate.mediaType === 'tv' ? 'TV' : 'Film'}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- page -------------------------------------------------------------------

export function LibraryPage() {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [stats, setStats] = useState<Stats | null>(null);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [indexing, setIndexing] = useState<IndexProgress | null>(null);
  const [unresolved, setUnresolved] = useState<UnresolvedRow[]>([]);

  const [items, setItems] = useState<TitleCard[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<'' | MediaType>('');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [found, setFound] = useState<
    { file: string; kind: 'letterboxd' | 'imdb'; modified: number }[]
  >([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await api.sources();
      setSources(data.sources);
      setSync(data.sync);
      setIndexing(data.indexing);
    } catch {
      /* server may be restarting */
    }
    api.stats().then(setStats).catch(() => {});
  }, []);

  const refreshUnresolved = useCallback(() => {
    api.unresolved().then(setUnresolved).catch(() => {});
  }, []);

  const refreshItems = useCallback(() => {
    api
      .library({ type: filter || undefined })
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
      })
      .catch(() => {});
  }, [filter]);

  useEffect(() => {
    refreshStatus();
    refreshUnresolved();
  }, [refreshStatus, refreshUnresolved]);

  useEffect(() => {
    refreshItems();
  }, [refreshItems]);

  // Poll while anything is in flight so progress stays live.
  useEffect(() => {
    const active = sync?.running || indexing?.running;
    const timer = window.setInterval(refreshStatus, active ? 1500 : 15_000);
    return () => window.clearInterval(timer);
  }, [sync?.running, indexing?.running, refreshStatus]);

  // When a run finishes, pull in whatever it produced.
  const wasBusy = useRef(false);
  useEffect(() => {
    const busy = Boolean(sync?.running || indexing?.running);
    if (wasBusy.current && !busy) {
      refreshItems();
      refreshUnresolved();
    }
    wasBusy.current = busy;
  }, [sync?.running, indexing?.running, refreshItems, refreshUnresolved]);

  async function startSync(source?: string, full?: boolean) {
    try {
      const state = await api.sync(source, full);
      setSync(state);
      toast.show(full ? 'Full backfill started' : 'Sync started');
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'bad');
    }
  }

  async function scanDownloads() {
    setScanning(true);
    try {
      const { files } = await api.foundExports();
      setFound(files);
      setScanned(true);
      if (files.length === 0) toast.show('No export files found in Downloads or Desktop');
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setScanning(false);
    }
  }

  async function importFound(file: string) {
    setUploading(true);
    try {
      const { result } = await api.importFound(file);
      toast.show(
        `Imported ${result.added} new title${result.added === 1 ? '' : 's'}` +
          (result.unresolved ? ` · ${result.unresolved} need a look` : ''),
      );
      setFound((current) => current.filter((f) => f.file !== file));
      refreshStatus();
      refreshItems();
      refreshUnresolved();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setUploading(false);
    }
  }

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      const { results } = await api.upload(list);
      const added = results.reduce((sum, r) => sum + r.added, 0);
      const needing = results.reduce((sum, r) => sum + r.unresolved, 0);
      toast.show(
        `Imported ${added} new title${added === 1 ? '' : 's'}` +
          (needing ? ` · ${needing} need a look` : ''),
      );
      refreshStatus();
      refreshItems();
      refreshUnresolved();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setUploading(false);
    }
  }

  const busy = Boolean(sync?.running);

  return (
    <main className="page">
      <div className="wrap">
        <h1 className="mb-20">Library</h1>

        {stats && (
          <div className="stat-row mb-20">
            <div className="stat">
              <div className="stat-n">{stats.movies.toLocaleString()}</div>
              <div className="stat-label">films</div>
            </div>
            <div className="stat">
              <div className="stat-n">{stats.shows.toLocaleString()}</div>
              <div className="stat-label">shows</div>
            </div>
            <div className="stat">
              <div className="stat-n">{stats.people.toLocaleString()}</div>
              <div className="stat-label">people indexed</div>
            </div>
            {!IS_STATIC && (
              <div className="stat">
                <div className="stat-n">{stats.unresolved.toLocaleString()}</div>
                <div className="stat-label">need a look</div>
              </div>
            )}
          </div>
        )}

        {/* --- sources --- */}
        <div className="panel">
          <div className="panel-head">
            <h2>Sources</h2>
            {!IS_STATIC && (
              <div className="row">
                <button className="btn btn-sm" onClick={() => startSync(undefined, true)} disabled={busy}>
                  Full backfill
                </button>
                <button className="btn btn-sm btn-accent" onClick={() => startSync()} disabled={busy}>
                  {busy ? <span className="spinner" /> : Icon.refresh(14)}
                  {busy ? 'Syncing…' : 'Sync now'}
                </button>
              </div>
            )}
          </div>

          {sources.map((source) => (
            <div className="source-row" key={source.id}>
              <span className={statusClass(source, busy && sync?.source === source.id)} />
              <div className="source-info">
                <div className="source-name">
                  {source.label}
                  {source.titleCount > 0 && (
                    <span className="count">{source.titleCount.toLocaleString()} titles</span>
                  )}
                </div>
                <div className="source-desc">
                  {source.message || source.description}
                  {source.lastOkAt && ` · last synced ${ago(source.lastOkAt)}`}
                </div>
              </div>
              {source.configured && !IS_STATIC && (
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => startSync(source.id)}
                  disabled={busy}
                >
                  Sync
                </button>
              )}
            </div>
          ))}

          {indexing?.running && (
            <div style={{ marginTop: 16 }}>
              <div className="row spread">
                <span className="hint">
                  Indexing cast — {indexing.current ?? '…'}
                </span>
                <span className="count">
                  {indexing.done}/{indexing.total}
                </span>
              </div>
              <div className="bar">
                <div
                  className="bar-fill"
                  style={{
                    width: `${indexing.total ? (indexing.done / indexing.total) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          )}

          {sync && sync.lines.length > 0 && (
            <div className="log">{sync.lines.slice(-60).join('\n')}</div>
          )}
          {sync?.error && (
            <div className="hint" style={{ color: 'var(--bad)', marginTop: 10 }}>
              {sync.error}
            </div>
          )}
        </div>

        {/* --- import --- */}
        {!IS_STATIC && (
        <div className="panel">
          <div className="panel-head">
            <h2>Import a file</h2>
            <button className="btn btn-sm btn-ghost" onClick={scanDownloads} disabled={scanning}>
              {scanning ? <span className="spinner" /> : Icon.search(14)}
              Check my Downloads
            </button>
          </div>

          {found.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <p className="hint" style={{ marginBottom: 8 }}>
                Found {found.length === 1 ? 'an export' : 'exports'} you've already downloaded:
              </p>
              {found.map((entry) => (
                <div className="source-row" key={entry.file}>
                  <span className="status-dot status-ok" />
                  <div className="source-info">
                    <div className="source-name">{entry.file.split(/[\\/]/).pop()}</div>
                    <div className="source-desc">
                      {entry.kind === 'letterboxd' ? 'Letterboxd export' : 'IMDb ratings'} ·{' '}
                      {new Date(entry.modified).toLocaleString()}
                    </div>
                  </div>
                  <button
                    className="btn btn-sm btn-accent"
                    disabled={uploading}
                    onClick={() => importFound(entry.file)}
                  >
                    Import
                  </button>
                </div>
              ))}
            </div>
          )}
          {scanned && found.length === 0 && (
            <p className="hint" style={{ marginBottom: 14 }}>
              Nothing found in your Downloads or Desktop. Export from{' '}
              <a
                href="https://letterboxd.com/settings/data/"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                Letterboxd
              </a>{' '}
              in your normal browser, then check again.
            </p>
          )}
          <div
            className={`drop${dragging ? ' drop-over' : ''}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              upload(event.dataTransfer.files);
            }}
          >
            <div style={{ color: 'var(--muted)', marginBottom: 8 }}>
              {uploading ? <span className="spinner" /> : Icon.upload(22)}
            </div>
            <div className="drop-title">
              {uploading ? 'Importing…' : 'Drop your IMDb ratings CSV or Letterboxd export ZIP'}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              Always available as a fallback — nothing here depends on the automated sync working.
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.zip"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) upload(event.target.files);
                event.target.value = '';
              }}
            />
          </div>
        </div>
        )}

        {/* --- unresolved --- */}
        {unresolved.length > 0 && (
          <div className="panel">
            <div className="panel-head">
              <h2>Needs a look</h2>
              <span className="count">{unresolved.length}</span>
            </div>
            <p className="hint" style={{ marginTop: -6, marginBottom: 6 }}>
              These didn't match a TMDB entry with enough confidence to guess. Pick the right one
              and it joins your library.
            </p>
            {unresolved.slice(0, 25).map((row) => (
              <FixRow
                key={row.id}
                row={row}
                onDone={() => {
                  setUnresolved((rows) => rows.filter((r) => r.id !== row.id));
                  refreshStatus();
                }}
              />
            ))}
          </div>
        )}

        {/* --- titles --- */}
        <div className="section-head mt-32">
          <h2>Everything you've watched</h2>
          <span className="count">{total.toLocaleString()}</span>
          <div style={{ marginLeft: 'auto' }}>
            <div className="tabs">
              {(['', 'movie', 'tv'] as const).map((value) => (
                <button
                  key={value || 'all'}
                  className={`tab${filter === value ? ' tab-active' : ''}`}
                  onClick={() => setFilter(value)}
                >
                  {value === '' ? 'All' : value === 'movie' ? 'Films' : 'Shows'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {items.length === 0 ? (
          <Empty icon="📼" title="Nothing here yet">
            {IS_STATIC
              ? 'This snapshot is empty. Rebuild it on the machine that syncs.'
              : 'Run a sync above, or drop in an export file.'}
          </Empty>
        ) : (
          <div className="grid">
            {items.map((item) => (
              <TitleTile key={`${item.mediaType}-${item.tmdbId}`} item={item} />
            ))}
          </div>
        )}

        {items.length > 0 && items.length < total && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 26 }}>
            <button
              className="btn"
              onClick={() =>
                api
                  .library({ type: filter || undefined, offset: items.length })
                  .then((data) => setItems((current) => [...current, ...data.items]))
                  .catch(() => {})
              }
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
