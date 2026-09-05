/**
 * Verifies the parts that don't need a TMDB key: CSV parsing, the cast
 * inverted index, the overlap SQL, and the "where do I know them from" ranking.
 */
import { db, nowIso } from '../db.ts';
import { scoreCredit } from '../scoring.ts';
import { parseImdbRatingsCsv, parseLetterboxdZip } from '../sources/parsers.ts';
import { zipSync, strToU8 } from 'fflate';

console.log('=== 1. IMDb ratings CSV parser ===');
const imdbCsv = [
  'Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors',
  'tt0903747,10,2024-03-11,Breaking Bad,Breaking Bad,https://www.imdb.com/title/tt0903747/,TV Series,9.5,49,2008,"Crime, Drama, Thriller",2100000,2008-01-20,',
  'tt0068646,9,2023-11-02,"Godfather, The","Godfather, The",https://www.imdb.com/title/tt0068646/,Movie,9.2,175,1972,"Crime, Drama",1900000,1972-03-24,Francis Ford Coppola',
  'tt1234567,7,2022-01-05,"A Title, With ""Quotes"" In It",X,https://www.imdb.com/title/tt1234567/,TV Mini Series,7.1,60,2019,Drama,500,2019-05-01,',
  'tt9999999,5,2021-01-01,Some Game,Some Game,https://www.imdb.com/title/tt9999999/,Video Game,6.0,0,2015,Action,100,2015-01-01,',
].join('\n');

const imdbEvents = parseImdbRatingsCsv(imdbCsv);
console.log(`parsed ${imdbEvents.length} rows (video game correctly skipped: ${imdbEvents.length === 3})`);
for (const e of imdbEvents) {
  console.log(`  ${e.imdbId}  ${e.mediaType?.padEnd(5)}  rating=${e.rating}  "${e.title}"  (${e.year})`);
}

console.log('\n=== 2. Letterboxd export ZIP parser ===');
const zip = zipSync({
  'watched.csv': strToU8(
    ['Date,Name,Year,Letterboxd URI',
     '2024-01-02,Dune: Part Two,2024,https://boxd.it/aaa',
     '2023-06-11,"Three Billboards Outside Ebbing, Missouri",2017,https://boxd.it/bbb'].join('\n'),
  ),
  'ratings.csv': strToU8(
    ['Date,Name,Year,Letterboxd URI,Rating',
     '2024-01-02,Dune: Part Two,2024,https://boxd.it/aaa,4.5'].join('\n'),
  ),
  'diary.csv': strToU8(
    ['Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date',
     '2024-01-03,Dune: Part Two,2024,https://boxd.it/aaa,4.5,No,,2024-01-01'].join('\n'),
  ),
});
const lbEvents = parseLetterboxdZip(zip);
for (const e of lbEvents) {
  console.log(`  "${e.title}" (${e.year})  rating=${e.rating}  watched=${e.watchedAt}  ref=${e.sourceRef}`);
}
console.log(`comma-in-title survived quoting: ${lbEvents.some((e) => e.title.includes(','))}`);
console.log(`ratings + diary overlaid onto watched.csv: ${lbEvents.find((e) => e.sourceRef.endsWith('aaa'))?.rating === 9}`);

console.log('\n=== 3. Cast index + overlap SQL + ranking ===');
db.exec(`
  DELETE FROM credits WHERE person_id = -1;
  DELETE FROM watched WHERE tmdb_id < 0;
  DELETE FROM titles  WHERE tmdb_id < 0;
`);

const titles = [
  { id: -1, type: 'tv',    name: 'The Long Series',   year: 2011, pop: 90, eps: 62,   order: 3, rating: 9.5, when: '2024-06-01' },
  { id: -2, type: 'movie', name: 'The Big Film',      year: 2019, pop: 120, eps: null, order: 0, rating: 8,   when: '2025-02-14' },
  { id: -3, type: 'tv',    name: 'One Episode Guest', year: 2015, pop: 40, eps: 1,    order: 12, rating: 7,   when: '2019-01-01' },
  { id: -4, type: 'movie', name: 'Background Extra',  year: 2013, pop: 30, eps: null, order: 24, rating: null, when: '2016-03-03' },
];

for (const t of titles) {
  db.prepare(
    `INSERT INTO titles (tmdb_id, media_type, name, year, popularity, updated_at) VALUES (?,?,?,?,?,?)`,
  ).run(t.id, t.type, t.name, t.year, t.pop, nowIso());
  db.prepare(
    `INSERT INTO watched (tmdb_id, media_type, source, rating, watched_at, source_ref, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(t.id, t.type, 'verify', t.rating, t.when, `v${t.id}`, nowIso());
  db.prepare(
    `INSERT INTO credits (person_id, tmdb_id, media_type, character_name, episode_count, billing_order) VALUES (?,?,?,?,?,?)`,
  ).run(-1, t.id, t.type, 'Someone', t.eps, t.order);
}

// The exact query the person page runs.
const rows = db
  .prepare(
    `SELECT t.name, t.media_type, t.popularity, c.episode_count, c.billing_order, l.rating, l.watched_at
       FROM credits c
       JOIN titles  t ON t.tmdb_id = c.tmdb_id AND t.media_type = c.media_type
       JOIN library l ON l.tmdb_id = c.tmdb_id AND l.media_type = c.media_type
      WHERE c.person_id = ?`,
  )
  .all(-1) as any[];

const ranked = rows
  .map((r) => ({
    name: r.name,
    ...scoreCredit({
      mediaType: r.media_type,
      billingOrder: r.billing_order,
      episodeCount: r.episode_count,
      rating: r.rating,
      watchedAt: r.watched_at,
      popularity: r.popularity,
    }),
  }))
  .sort((a, b) => b.score - a.score);

console.log('ranked "where do I know them from":');
ranked.forEach((r, i) => {
  console.log(`  ${i + 1}. ${r.name.padEnd(20)} score=${r.score.toFixed(3)}  ${r.basis}`);
});

// The overlap count the cast grid badge uses.
const overlap = db
  .prepare(
    `SELECT COUNT(*) AS n FROM credits c
       JOIN watched w ON w.tmdb_id = c.tmdb_id AND w.media_type = c.media_type
      WHERE c.person_id = ?`,
  )
  .get(-1) as { n: number };
console.log(`\noverlap count for cast badge: ${overlap.n} (expected 4)`);

db.exec(`
  DELETE FROM credits WHERE person_id = -1;
  DELETE FROM watched WHERE tmdb_id < 0;
  DELETE FROM titles  WHERE tmdb_id < 0;
`);
console.log('\ncleaned up test rows.');

