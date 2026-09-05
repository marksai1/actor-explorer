import { unzipSync, strFromU8 } from 'fflate';
import { parseCsv, field, toNumber, toIsoDate } from '../csv.ts';
import type { WatchEvent } from './types.ts';
import type { MediaType } from '../db.ts';

/**
 * Parsers for the two export formats. Deliberately shared between the manual
 * drag-and-drop path and the automated sync — the browser automation downloads
 * exactly the same CSV a human would, so there is only ever one parser to keep
 * working.
 */

/** IMDb "Title Type" values that aren't screen performances worth indexing. */
const SKIP_TITLE_TYPES = new Set([
  'video game',
  'podcast series',
  'podcast episode',
  'music video',
]);

function imdbMediaHint(titleType: string): MediaType | undefined {
  const t = titleType.toLowerCase();
  if (!t) return undefined;
  if (t.includes('episode') || t.includes('series') || t === 'tv special') return 'tv';
  if (t.includes('movie') || t === 'short' || t === 'video') return 'movie';
  return undefined;
}

export function parseImdbRatingsCsv(text: string): WatchEvent[] {
  const rows = parseCsv(text);
  const events: WatchEvent[] = [];

  for (const row of rows) {
    const constId = field(row, 'Const', 'const');
    if (!/^tt\d+$/.test(constId)) continue;

    const titleType = field(row, 'Title Type', 'TitleType');
    if (SKIP_TITLE_TYPES.has(titleType.toLowerCase())) continue;

    events.push({
      imdbId: constId,
      mediaType: imdbMediaHint(titleType),
      title: field(row, 'Title', 'Original Title', 'Primary Title') || constId,
      year: toNumber(field(row, 'Year')),
      // IMDb ratings are already on a 1–10 scale.
      rating: toNumber(field(row, 'Your Rating', 'YourRating')),
      watchedAt: toIsoDate(field(row, 'Date Rated', 'DateRated', 'Created', 'Modified')),
      sourceRef: constId,
    });
  }

  return events;
}

/** Letterboxd stars are 0.5–5; the library stores everything on a 0–10 scale. */
function letterboxdRating(raw: string): number | null {
  const stars = toNumber(raw);
  return stars === null ? null : Math.round(stars * 2 * 10) / 10;
}

function letterboxdRow(row: Record<string, string>): WatchEvent | null {
  const name = field(row, 'Name', 'Film', 'Title');
  if (!name) return null;
  const uri = field(row, 'Letterboxd URI', 'LetterboxdURI', 'URI', 'URL');

  return {
    mediaType: 'movie', // Letterboxd is films only
    title: name,
    year: toNumber(field(row, 'Year')),
    rating: letterboxdRating(field(row, 'Rating')),
    watchedAt:
      toIsoDate(field(row, 'Watched Date', 'WatchedDate')) ??
      toIsoDate(field(row, 'Date')),
    // The boxd.it URI is stable and unique; fall back to title+year if absent.
    sourceRef: uri || `lb:${name.toLowerCase()}:${field(row, 'Year')}`,
  };
}

export function parseLetterboxdCsv(text: string): WatchEvent[] {
  return parseCsv(text)
    .map(letterboxdRow)
    .filter((e): e is WatchEvent => e !== null);
}

/**
 * Merge the CSVs inside a Letterboxd export ZIP.
 *
 * `watched.csv` is the authoritative set of films seen; `ratings.csv` and
 * `diary.csv` layer on scores and actual watch dates where they exist.
 */
export function parseLetterboxdZip(buffer: Uint8Array): WatchEvent[] {
  const files = unzipSync(buffer);
  const byRef = new Map<string, WatchEvent>();

  const read = (candidates: string[]): string | null => {
    for (const [name, bytes] of Object.entries(files)) {
      const base = name.split('/').pop()?.toLowerCase() ?? '';
      if (candidates.includes(base)) return strFromU8(bytes);
    }
    return null;
  };

  const merge = (text: string | null, overlay: boolean) => {
    if (!text) return;
    for (const event of parseLetterboxdCsv(text)) {
      const existing = byRef.get(event.sourceRef);
      if (!existing) {
        byRef.set(event.sourceRef, event);
      } else if (overlay) {
        existing.rating = event.rating ?? existing.rating;
        existing.watchedAt = event.watchedAt ?? existing.watchedAt;
        existing.year = existing.year ?? event.year;
      }
    }
  };

  merge(read(['watched.csv']), false);
  merge(read(['ratings.csv']), true);
  merge(read(['diary.csv']), true);

  return [...byRef.values()];
}

/** Sniff which parser a dropped file needs, by name and by header shape. */
export function parseDroppedFile(
  filename: string,
  bytes: Uint8Array,
): { events: WatchEvent[]; source: string } {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.zip')) {
    return { events: parseLetterboxdZip(bytes), source: 'letterboxd' };
  }

  const text = strFromU8(bytes);
  const header = text.slice(0, 500).toLowerCase();

  if (header.includes('const') && header.includes('your rating')) {
    return { events: parseImdbRatingsCsv(text), source: 'imdb' };
  }
  if (header.includes('letterboxd uri')) {
    return { events: parseLetterboxdCsv(text), source: 'letterboxd' };
  }
  if (lower.includes('imdb') || header.includes('const')) {
    return { events: parseImdbRatingsCsv(text), source: 'imdb' };
  }
  return { events: parseLetterboxdCsv(text), source: 'letterboxd' };
}
