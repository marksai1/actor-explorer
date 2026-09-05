import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { MediaType, TitleDetail } from '../api';
import { Empty, Icon, Loading, Poster, formatRating, useToast } from '../components';

export function TitlePage() {
  const { mediaType, id } = useParams<{ mediaType: string; id: string }>();
  const toast = useToast();

  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!mediaType || !id) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .title(mediaType as MediaType, Number(id))
      .then((data) => !cancelled && setDetail(data))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [mediaType, id]);

  async function toggleWatched() {
    if (!detail) return;
    setSaving(true);
    try {
      await api.setWatched(detail.tmdbId, detail.mediaType, !detail.watched);
      setDetail({ ...detail, watched: !detail.watched });
      toast.show(detail.watched ? 'Removed from your library' : 'Marked as seen');
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <main className="page">
        <div className="wrap">
          <Empty icon="⚠" title="Couldn't load that title">{error}</Empty>
        </div>
      </main>
    );
  }
  if (!detail) return <Loading />;

  const known = detail.cast.filter((member) => member.seenCount > 0).length;

  return (
    <main>
      <div className="hero">
        {detail.backdrop && (
          <div className="hero-bg">
            <img src={detail.backdrop} alt="" />
          </div>
        )}
        <div className="wrap">
          <div className="hero-inner">
            <div className="hero-poster">
              <Poster src={detail.poster} alt={detail.name} />
            </div>
            <div className="hero-meta">
              <h1>{detail.name}</h1>
              <div className="hero-line">
                <span>{detail.year ?? '—'}</span>
                <span className="dot" />
                <span>{detail.mediaType === 'tv' ? 'TV series' : 'Film'}</span>
                {detail.watched && (
                  <>
                    <span className="dot" />
                    <span className="pill pill-good">{Icon.check(12)} In your library</span>
                  </>
                )}
                {detail.rating != null && (
                  <span className="pill pill-accent">
                    {Icon.star(12)} You rated {formatRating(detail.rating)}
                  </span>
                )}
              </div>

              {detail.overview && <p className="hero-overview">{detail.overview}</p>}

              <div className="hero-actions">
                <button
                  className={`btn${detail.watched ? '' : ' btn-accent'}`}
                  onClick={toggleWatched}
                  disabled={saving}
                >
                  {detail.watched ? (
                    <>{Icon.check(15)} Seen it</>
                  ) : (
                    <>{Icon.plus(15)} Mark as seen</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="wrap page-tail">
        <div className="section-head">
          <h2>Cast</h2>
          <span className="count">
            {known > 0
              ? `${known} of ${detail.cast.length} appear elsewhere in your library`
              : `${detail.cast.length} listed`}
          </span>
        </div>

        {detail.cast.length === 0 ? (
          <Empty icon="👤" title="No cast listed">
            TMDB doesn't have cast data for this title yet.
          </Empty>
        ) : (
          <div className="cast-grid">
            {detail.cast.map((member) => (
              <Link
                key={member.personId}
                to={`/person/${member.personId}`}
                className={`cast-card ${member.seenCount > 0 ? 'cast-known' : 'cast-unknown'}`}
                title={
                  member.seenCount > 0
                    ? `You've seen ${member.name} in ${member.seenCount} other title${
                        member.seenCount === 1 ? '' : 's'
                      }`
                    : member.name
                }
              >
                {/* The badge sits outside .cast-photo — that element clips to a
                    circle, which would slice the badge in half. */}
                <div className="cast-photo-wrap">
                  <div className="cast-photo">
                    {member.photo ? (
                      <img src={member.photo} alt={member.name} loading="lazy" />
                    ) : (
                      <div className="poster-empty">👤</div>
                    )}
                  </div>
                  {member.seenCount > 0 && (
                    <span className="cast-badge">{member.seenCount}</span>
                  )}
                </div>
                <div className="cast-name">{member.name}</div>
                {member.character && <div className="cast-role">{member.character}</div>}
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
