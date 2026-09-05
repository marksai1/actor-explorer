import { rebuildIndex, queueUnindexedLibrary, waitForIndexer, getIndexProgress } from '../indexer.ts';
import { libraryStats } from '../queries.ts';

/**
 * Rebuild the cast index.
 *
 *   npm run reindex            index anything missing
 *   npm run reindex -- --all   re-pull every cast from scratch
 *
 * The `--all` form is what you want after the cast-selection rules change,
 * since existing rows were written under the old ones.
 */

const all = process.argv.includes('--all');
const queued = all ? rebuildIndex() : queueUnindexedLibrary();

if (queued === 0) {
  console.log('Nothing to index.');
  process.exit(0);
}

console.log(`${all ? 'Rebuilding' : 'Indexing'} cast for ${queued} titles…\n`);

let last = '';
const ticker = setInterval(() => {
  const p = getIndexProgress();
  if (!p.running) return;
  const line = `  ${p.done}/${p.total}  ${p.current ?? ''}`;
  if (line !== last) {
    last = line;
    console.log(line);
  }
}, 1500);

await waitForIndexer();
clearInterval(ticker);

const stats = libraryStats();
console.log(
  `\nDone. ${stats.indexed} titles indexed, ${stats.people} distinct people.\n`,
);
process.exit(0);
