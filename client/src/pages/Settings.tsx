import { useEffect, useState } from 'react';
import { api, IS_STATIC } from '../api';
import type { SourceStatus } from '../api';
import { Icon, useToast } from '../components';
import { setLibrary, snapshotGeneratedAt } from '../static/api';
import { forget, refresh } from '../static/snapshot';

export function SettingsPage() {
  const toast = useToast();
  const [settings, setSettings] = useState<{
    tmdbKey: boolean;
    letterboxdUser: string;
    imdbUserId: string;
    autoSync: boolean;
  } | null>(null);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
    api.sources().then((data) => setSources(data.sources)).catch(() => {});
  }, []);

  async function toggleAutoSync(value: boolean) {
    if (!settings) return;
    setSettings({ ...settings, autoSync: value });
    await api.saveSettings({ autoSync: value }).catch(() => {});
    toast.show(value ? 'Automatic sync on' : 'Automatic sync paused');
  }

  const code: React.CSSProperties = {
    fontFamily: 'ui-monospace, Consolas, monospace',
    background: 'var(--bg-elev)',
    border: '1px solid var(--border-soft)',
    borderRadius: 6,
    padding: '2px 7px',
    fontSize: 12.5,
  };

  async function checkForUpdate() {
    setChecking(true);
    try {
      const updated = await refresh(snapshotGeneratedAt());
      if (updated) {
        setLibrary(updated);
        toast.show('A newer snapshot is in — reloading');
        window.location.reload();
      } else {
        toast.show('Already on the latest snapshot');
      }
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setChecking(false);
    }
  }

  const takenAt = IS_STATIC ? snapshotGeneratedAt() : null;

  return (
    <main className="page">
      <div className="wrap" style={{ maxWidth: 860 }}>
        <h1 className="mb-20">Settings</h1>

        {IS_STATIC && (
          <div className="panel">
            <div className="panel-head">
              <h2>This device</h2>
              <button className="btn btn-sm" onClick={checkForUpdate} disabled={checking}>
                {checking ? <span className="spinner" /> : Icon.refresh(14)}
                Check for a new snapshot
              </button>
            </div>
            <p className="hint">
              You are reading an offline copy of your library, taken{' '}
              <strong>{takenAt ? new Date(takenAt).toLocaleString() : 'at an unknown time'}</strong>
              . It lives on this phone, so the app works with no connection at all — only posters
              need the network, and the ones you have already looked at are kept too.
            </p>
            <p className="hint" style={{ marginTop: 8 }}>
              Syncing, importing and marking things as seen happen on the machine that holds the
              database; this copy is read-only and refreshes itself when a new snapshot is
              published.
            </p>
            <button
              className="btn btn-sm btn-ghost"
              style={{ marginTop: 12 }}
              onClick={async () => {
                await forget();
                window.location.reload();
              }}
            >
              Forget this library
            </button>
          </div>
        )}

        {!IS_STATIC && (
        <>
        <div className="panel">
          <div className="panel-head">
            <h2>TMDB</h2>
            <span className={`pill ${settings?.tmdbKey ? 'pill-good' : ''}`}>
              {settings?.tmdbKey ? 'Key configured' : 'Missing key'}
            </span>
          </div>
          <p className="hint">
            Cast lists, photos and filmographies all come from TMDB. The key lives in{' '}
            <span style={code}>.env</span> as <span style={code}>TMDB_API_KEY</span>. Changing it
            needs a server restart.
          </p>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Letterboxd</h2>
            <span className={`pill ${settings?.letterboxdUser ? 'pill-good' : ''}`}>
              {settings?.letterboxdUser ? `@${settings.letterboxdUser}` : 'Not set'}
            </span>
          </div>
          <p className="hint">
            Films sync automatically from your public RSS feed every 30 minutes — no login, no
            password, nothing to expire. Set <span style={code}>LETTERBOXD_USER</span> in{' '}
            <span style={code}>.env</span> to your handle.
          </p>
          <p className="hint" style={{ marginTop: 8 }}>
            The feed covers recent activity. For your whole history, run a{' '}
            <strong>Full backfill</strong> from the Library page once — it walks your public films
            grid and fills in everything.
          </p>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>IMDb</h2>
            <span className={`pill ${settings?.imdbUserId ? 'pill-good' : ''}`}>
              {settings?.imdbUserId || 'Not set'}
            </span>
          </div>
          <p className="hint">
            Shows sync from your public IMDb watch history every 30 minutes — no login, no
            password, nothing to expire. Set <span style={code}>IMDB_USER_ID</span> in{' '}
            <span style={code}>.env</span> to your <span style={code}>ur…</span> id, from{' '}
            <a href="https://www.imdb.com/profile" target="_blank" rel="noreferrer">
              imdb.com/profile
            </a>
            .
          </p>
          <p className="hint" style={{ marginTop: 10 }}>
            Then, in IMDb's <strong>Account Settings → Privacy</strong>, set{' '}
            <strong>Watch history</strong> to public — that's what makes the sync work at all.
            Setting <strong>Ratings</strong> public too is optional, but it adds your scores and
            dates, which the ranking uses. Run <span style={code}>npm run doctor</span> to see
            which of the two is currently readable.
          </p>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Automatic sync</h2>
            <button
              className={`btn btn-sm${settings?.autoSync ? ' btn-accent' : ''}`}
              onClick={() => toggleAutoSync(!settings?.autoSync)}
            >
              {settings?.autoSync ? <>{Icon.check(14)} On</> : 'Off'}
            </button>
          </div>
          <p className="hint">
            Letterboxd is polled every 30 minutes and IMDb once a day, plus a Letterboxd check
            shortly after the server starts. Turn this off to sync only when you press the button.
          </p>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Cast index</h2>
            <div className="row">
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const { queued } = await api.reindex();
                  toast.show(
                    queued > 0
                      ? `Queued ${queued} title${queued === 1 ? '' : 's'}`
                      : 'Everything is indexed',
                  );
                }}
              >
                Index missing titles
              </button>
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const { queued } = await api.reindexAll();
                  toast.show(`Rebuilding the cast index for ${queued} titles…`);
                }}
              >
                Rebuild from scratch
              </button>
            </div>
          </div>
          <p className="hint">
            Every title in your library gets its cast pulled once, which is what makes actor lookups
            instant instead of a network round-trip per face. <strong>Index missing titles</strong>{' '}
            catches anything that was skipped; <strong>rebuild from scratch</strong> re-pulls
            everything, which is what you want after the cast-selection rules change.
          </p>
        </div>

        </>
        )}

        <div className="panel">
          <div className="panel-head">
            <h2>All sources</h2>
          </div>
          {sources.map((source) => (
            <div className="source-row" key={source.id}>
              <span
                className={`status-dot${
                  source.status === 'ok' ? ' status-ok' : source.status === 'error' ? ' status-error' : ''
                }`}
              />
              <div className="source-info">
                <div className="source-name">{source.label}</div>
                <div className="source-desc">{source.description}</div>
              </div>
              <span className="count">{source.titleCount.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
