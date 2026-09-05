import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { OverlapEntry, PersonDetail } from '../api';
import { Empty, Icon, Loading, TitleTile, formatRating, relativeDate } from '../components';

/**
 * The payoff page. Everything you've watched them in comes first, ranked by how
 * likely it is to be the connection; the rest of the career sits dimmed and
 * collapsed underneath.
 */

function SeenCard({ entry, top }: { entry: OverlapEntry; top: boolean }) {
  return (
    <Link
      to={`/title/${entry.mediaType}/${entry.tmdbId}`}
      className={`seen-card${top ? ' seen-card-top' : ''}`}
    >
      <div className="seen-poster">
        {entry.poster ? (
          <img src={entry.poster} alt={entry.name} loading="lazy" />
        ) : (
          <div className="poster-empty">🎬</div>
        )}
      </div>
      <div className="seen-body">
        {top && <div className="seen-flag">{Icon.star(11)} Most likely</div>}
        <div className="seen-name">
          {entry.name} <span className="seen-year">{entry.year ?? ''}</span>
        </div>
        {entry.character && <div className="seen-role">as {entry.character}</div>}
        <div className="seen-foot">
          <span className="basis">{entry.basis}</span>
          {entry.rating != null && (
            <span className="pill pill-accent" style={{ padding: '1px 8px', fontSize: 11.5 }}>
              {formatRating(entry.rating)}
            </span>
          )}
          {entry.watchedAt && <span>{relativeDate(entry.watchedAt)}</span>}
        </div>
      </div>
    </Link>
  );
}

export function PersonPage() {
  const { id } = useParams<{ id: string }>();
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRest, setShowRest] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setPerson(null);
    setError(null);
    setShowRest(false);
    api
      .person(Number(id))
      .then((data) => !cancelled && setPerson(data))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <main className="page">
        <div className="wrap">
          <Empty icon="⚠" title="Couldn't load that person">{error}</Empty>
        </div>
      </main>
    );
  }
  if (!person) return <Loading />;

  const count = person.seen.length;

  return (
    <main className="page">
      <div className="wrap">
        <div className="person-head">
          <div className="person-photo">
            {person.photo ? (
              <img src={person.photo} alt={person.name} />
            ) : (
              <div className="poster-empty">👤</div>
            )}
          </div>
          <div>
            <h1>{person.name}</h1>
            <div className="person-verdict">
              {count === 0 ? (
                <>Nothing in your library yet — this one's new to you.</>
              ) : (
                <>
                  You've seen them in <strong>{count}</strong>{' '}
                  {count === 1 ? 'thing' : 'things'} you've watched.
                </>
              )}
            </div>
            {person.knownFor && (
              <div className="hint" style={{ marginTop: 6 }}>
                Known for {person.knownFor.toLowerCase()}
              </div>
            )}
          </div>
        </div>

        {count > 0 && (
          <>
            <div className="section-head">
              <h2>Where you know them from</h2>
              <span className="count">{count}</span>
            </div>
            <div className="seen-list">
              {person.seen.map((entry, index) => (
                <SeenCard
                  key={`${entry.mediaType}-${entry.tmdbId}`}
                  entry={entry}
                  // Only flag a clear winner, not a coin-flip between two.
                  top={
                    index === 0 &&
                    count > 1 &&
                    entry.score - (person.seen[1]?.score ?? 0) > 0.04
                  }
                />
              ))}
            </div>
          </>
        )}

        {count === 0 && (
          <Empty icon="🎭" title="No overlap with your library">
            You haven't watched anything they're credited in — at least nothing that's synced
            yet. Their full filmography is below.
          </Empty>
        )}

        {person.rest.length > 0 && (
          <div className="disclosure">
            <button className="disclosure-btn" onClick={() => setShowRest((open) => !open)}>
              <span className={`chev${showRest ? ' chev-open' : ''}`}>{Icon.chevron(15)}</span>
              Rest of their work
              <span className="count">({person.rest.length})</span>
            </button>
            {showRest && (
              <div className="disclosure-body">
                <div className="grid grid-sm">
                  {person.rest.map((item) => (
                    <TitleTile key={`${item.mediaType}-${item.tmdbId}`} item={item} dim />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
