import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { TitleCard, PersonCard } from './api';

// --- icons -----------------------------------------------------------------

const svg = (path: ReactNode, size = 16) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {path}
  </svg>
);

export const Icon = {
  search: (size?: number) =>
    svg(
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </>,
      size,
    ),
  check: (size?: number) => svg(<path d="M20 6 9 17l-5-5" />, size),
  plus: (size?: number) => svg(<path d="M12 5v14M5 12h14" />, size),
  chevron: (size?: number) => svg(<path d="m9 18 6-6-6-6" />, size),
  back: (size?: number) => svg(<path d="m15 18-6-6 6-6" />, size),
  refresh: (size?: number) =>
    svg(
      <>
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <path d="M21 3v6h-6" />
      </>,
      size,
    ),
  star: (size?: number) =>
    svg(
      <path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-2.9L6.7 19.6l1.1-6L3.4 9.4l6-.8L12 3Z" />,
      size,
    ),
  library: (size?: number) =>
    svg(
      <>
        <rect x="3" y="4" width="6" height="16" rx="1.5" />
        <rect x="11" y="4" width="6" height="16" rx="1.5" />
        <path d="m19.5 6.5 2 12" />
      </>,
      size,
    ),
  settings: (size?: number) =>
    svg(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
      </>,
      size,
    ),
  home: (size?: number) =>
    svg(
      <>
        <path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        <path d="M9 21v-8h6v8" />
      </>,
      size,
    ),
  upload: (size?: number) =>
    svg(
      <>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="M7 9l5-5 5 5M12 4v12" />
      </>,
      size,
    ),
};

// --- toast -----------------------------------------------------------------

interface ToastValue {
  show: (message: string, tone?: 'ok' | 'bad') => void;
}

const ToastContext = createContext<ToastValue>({ show: () => {} });
export const useToast = () => useContext(ToastContext);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: 'ok' | 'bad' } | null>(null);

  const show = useCallback((message: string, tone: 'ok' | 'bad' = 'ok') => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), tone === 'bad' ? 6000 : 3400);
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast && (
        <div className={`toast${toast.tone === 'bad' ? ' toast-bad' : ''}`} role="status">
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

// --- primitives ------------------------------------------------------------

export function Loading() {
  return (
    <div className="loading-center">
      <span className="spinner" />
    </div>
  );
}

export function Empty({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      {children && <div className="hint">{children}</div>}
    </div>
  );
}

export function Poster({ src, alt }: { src: string | null; alt: string }) {
  if (!src) return <div className="poster-empty">🎬</div>;
  return <img src={src} alt={alt} loading="lazy" />;
}

export function TitleTile({ item, dim = false }: { item: TitleCard; dim?: boolean }) {
  return (
    <Link
      to={`/title/${item.mediaType}/${item.tmdbId}`}
      className={`card${dim ? ' card-dim' : ''}`}
    >
      <div className="poster">
        <Poster src={item.poster} alt={item.name} />
        <span className="chip-type">{item.mediaType === 'tv' ? 'TV' : 'Film'}</span>
        {item.rating != null && (
          <span className="chip-rating">{formatRating(item.rating)}</span>
        )}
        {item.watched && item.rating == null && (
          <span className="chip-seen">{Icon.check(11)} Seen</span>
        )}
      </div>
      <div className="card-title">{item.name}</div>
      <div className="card-sub">{item.year ?? '—'}</div>
    </Link>
  );
}

export function PersonTile({ person }: { person: PersonCard }) {
  const known = person.seenCount > 0;
  return (
    <Link
      to={`/person/${person.personId}`}
      className={`cast-card ${known ? 'cast-known' : 'cast-unknown'}`}
      title={
        known
          ? `You've seen ${person.name} in ${person.seenCount} title${
              person.seenCount === 1 ? '' : 's'
            }`
          : person.name
      }
    >
      <div className="cast-photo-wrap">
        <div className="cast-photo">
          {person.photo ? (
            <img src={person.photo} alt={person.name} loading="lazy" />
          ) : (
            <div className="poster-empty">👤</div>
          )}
        </div>
        {known && <span className="cast-badge">{person.seenCount}</span>}
      </div>
      <div className="cast-name">{person.name}</div>
      <div className="cast-role">
        {known
          ? `seen in ${person.seenCount}`
          : person.knownFor
            ? person.knownFor.toLowerCase()
            : 'not in your library'}
      </div>
    </Link>
  );
}

/** Ratings are stored 0–10; show one decimal only when it carries information. */
export function formatRating(rating: number): string {
  return Number.isInteger(rating) ? String(rating) : rating.toFixed(1);
}

export function relativeDate(iso: string | null): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((Date.now() - then) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
