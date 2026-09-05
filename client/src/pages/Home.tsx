import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { PersonCard, Stats, TitleCard } from '../api';
import { Empty, Icon, Loading, PersonTile, TitleTile } from '../components';

const hasPointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

export function HomePage() {
  const [params] = useSearchParams();
  const query = params.get('q')?.trim() ?? '';
  const navigate = useNavigate();

  const [results, setResults] = useState<{ titles: TitleCard[]; people: PersonCard[] } | null>(
    null,
  );
  const [recent, setRecent] = useState<TitleCard[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heroQuery, setHeroQuery] = useState('');

  useEffect(() => {
    if (!query) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setResults(null);
    setError(null);
    api
      .search(query)
      .then((items) => !cancelled && setResults(items))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [query]);

  useEffect(() => {
    api.stats().then(setStats).catch(() => {});
    api.recent().then(setRecent).catch(() => {});
  }, []);

  // --- search results ---
  if (query) {
    const nothing = results && results.titles.length === 0 && results.people.length === 0;

    return (
      <main className="page">
        <div className="wrap">
          {error && <Empty icon="⚠" title="Search failed">{error}</Empty>}
          {!results && !error && <Loading />}
          {nothing && (
            <Empty icon="🔍" title={`Nothing found for “${query}”`}>
              Try a different spelling, or the original-language title.
            </Empty>
          )}

          {results && results.people.length > 0 && (
            <>
              <div className="section-head">
                <h2>People</h2>
                <span className="count">{results.people.length}</span>
              </div>
              <div className="cast-grid mb-20">
                {results.people.slice(0, 18).map((person) => (
                  <PersonTile key={person.personId} person={person} />
                ))}
              </div>
            </>
          )}

          {results && results.titles.length > 0 && (
            <>
              <div className={`section-head${results.people.length > 0 ? ' mt-32' : ''}`}>
                <h2>Films &amp; shows</h2>
                <span className="count">{results.titles.length}</span>
              </div>
              <div className="grid">
                {results.titles.map((item) => (
                  <TitleTile key={`${item.mediaType}-${item.tmdbId}`} item={item} />
                ))}
              </div>
            </>
          )}
        </div>
      </main>
    );
  }

  // --- landing ---
  const empty = stats && stats.movies + stats.shows === 0;

  return (
    <main className="page">
      <div className="wrap">
        <div style={{ maxWidth: 640, margin: '36px auto 44px', textAlign: 'center' }}>
          <h1 style={{ fontSize: 32 }}>Where do I know them from?</h1>
          <p className="hint" style={{ marginTop: 10, fontSize: 15 }}>
            Search a film, show, or actor by name — then see every title you've watched them in.
          </p>

          <form
            className="search search-hero"
            style={{ marginTop: 26 }}
            onSubmit={(event) => {
              event.preventDefault();
              const value = heroQuery.trim();
              if (value) navigate(`/?q=${encodeURIComponent(value)}`);
            }}
          >
            <span className="search-icon">{Icon.search(19)}</span>
            <input
              value={heroQuery}
              onChange={(event) => setHeroQuery(event.target.value)}
              placeholder="Search a film, show, or actor…"
              aria-label="Search films, shows and actors"
              // On a phone this only puts a focus ring on an empty field —
              // iOS won't raise the keyboard without a tap either way.
              autoFocus={hasPointer}
            />
          </form>
        </div>

        {stats && (
          <div className="stat-row mb-20">
            <div className="stat">
              <div className="stat-n">{stats.movies.toLocaleString()}</div>
              <div className="stat-label">films watched</div>
            </div>
            <div className="stat">
              <div className="stat-n">{stats.shows.toLocaleString()}</div>
              <div className="stat-label">shows watched</div>
            </div>
            <div className="stat">
              <div className="stat-n">{stats.people.toLocaleString()}</div>
              <div className="stat-label">people indexed</div>
            </div>
            {stats.indexing.running && (
              <div className="stat">
                <div className="stat-n" style={{ fontSize: 19 }}>
                  {stats.indexing.done}/{stats.indexing.total}
                </div>
                <div className="stat-label">indexing cast…</div>
              </div>
            )}
          </div>
        )}

        {empty && (
          <Empty icon="🎬" title="Your library is empty">
            Head to <Link to="/library" style={{ color: 'var(--accent)' }}>Library</Link> to sync
            from Letterboxd and IMDb, or drop in an export file.
          </Empty>
        )}

        {recent.length > 0 && (
          <>
            <div className="section-head mt-32">
              <h2>Recently watched</h2>
            </div>
            <div className="grid">
              {recent.map((item) => (
                <TitleTile key={`${item.mediaType}-${item.tmdbId}`} item={item} />
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
