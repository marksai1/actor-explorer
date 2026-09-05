import { runSync } from '../sources/index.ts';
import { waitForIndexer, getIndexProgress } from '../indexer.ts';
import { libraryStats } from '../queries.ts';

/**
 * Command-line sync. `npm run sync` for an incremental pull,
 * `npm run sync -- --full` for a complete backfill,
 * `npm run sync -- --source letterboxd` to target one source.
 */

const args = process.argv.slice(2);
const full = args.includes('--full');
const sourceIndex = args.indexOf('--source');
const sourceId = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;

console.log(`Running ${full ? 'full backfill' : 'incremental sync'}${sourceId ? ` for ${sourceId}` : ''}…\n`);

const state = await runSync({ sourceId, full });

if (state.error) console.error(`\n${state.error}`);

console.log('\nIndexing cast…');
let lastLine = '';
const ticker = setInterval(() => {
  const progress = getIndexProgress();
  if (!progress.running) return;
  const line = `  ${progress.done}/${progress.total} — ${progress.current ?? ''}`;
  if (line !== lastLine) {
    lastLine = line;
    console.log(line);
  }
}, 2000);

await waitForIndexer();
clearInterval(ticker);

const stats = libraryStats();
console.log(
  `\nLibrary: ${stats.movies} films, ${stats.shows} shows, ` +
    `${stats.people} people indexed, ${stats.unresolved} needing a look.\n`,
);

process.exit(0);
