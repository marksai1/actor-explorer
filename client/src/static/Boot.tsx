import { useEffect, useState, type ReactNode } from 'react';
import { setLibrary } from './api';
import { forget, loadCached, refresh, unlock } from './snapshot';
import { idb, KEYS } from './store';

/**
 * The gate in front of the published build.
 *
 * The snapshot in the repository is encrypted, so the app needs the passphrase
 * once. After that the derived key lives in IndexedDB and every later launch —
 * including ones with no connection at all — goes straight through. A snapshot
 * rebuilt by the workflow decrypts itself with the key already held, so this
 * screen is genuinely a one-time thing rather than a login.
 */

type Phase = 'loading' | 'locked' | 'ready';

export function Boot({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped when a newer snapshot lands, to remount the pages against it.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const cached = await loadCached().catch(() => null);
      if (cancelled) return;

      if (!cached) {
        setPhase('locked');
        return;
      }

      setLibrary(cached);
      setPhase('ready');

      // Offline, or nothing new published — either way, not worth saying so.
      const cachedAt = await idb.get<string>(KEYS.generatedAt).catch(() => undefined);
      const updated = await refresh(cachedAt ?? null).catch(() => null);
      if (updated && !cancelled) {
        setLibrary(updated);
        setGeneration((n) => n + 1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!passphrase.trim()) return;

    setBusy(true);
    setError(null);
    try {
      const opened = await unlock(passphrase.trim());
      setLibrary(opened);
      setPassphrase('');
      setPhase('ready');
    } catch (err) {
      // A stale half-written attempt would block the retry.
      await forget().catch(() => {});
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'loading') {
    return (
      <div className="page">
        <div className="wrap" style={{ maxWidth: 460, paddingTop: 80 }}>
          <p className="hint">Opening your library…</p>
        </div>
      </div>
    );
  }

  if (phase === 'locked') {
    return (
      <div className="page">
        <div className="wrap" style={{ maxWidth: 460, paddingTop: 64 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>◎</div>
          <h1 className="mb-20">Actor Explorer</h1>

          <div className="panel">
            <div className="panel-head">
              <h2>Unlock your library</h2>
            </div>
            <p className="hint">
              Your library is published encrypted, so it needs the passphrase once on this
              device. It is remembered afterwards — including when the snapshot is refreshed.
            </p>

            <form onSubmit={submit} style={{ marginTop: 14 }}>
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder="Passphrase"
                aria-label="Snapshot passphrase"
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                style={{
                  width: '100%',
                  padding: '11px 13px',
                  fontSize: 16, // 16px or iOS zooms the page on focus.
                  borderRadius: 9,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-elev)',
                  color: 'inherit',
                }}
              />
              <button
                className="btn btn-accent"
                type="submit"
                disabled={busy}
                style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}
              >
                {busy ? 'Unlocking…' : 'Unlock'}
              </button>
            </form>

            {error && (
              <p className="hint" style={{ marginTop: 12, color: 'var(--bad, #f87171)' }}>
                {error}
              </p>
            )}
            {busy && (
              <p className="hint" style={{ marginTop: 10 }}>
                Stretching the key takes a second or two — that slowness is the point.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <div key={generation}>{children}</div>;
}
