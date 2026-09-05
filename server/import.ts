import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseDroppedFile } from './sources/parsers.ts';
import { ingestEvents } from './ingest.ts';
import { queueUnindexedLibrary } from './indexer.ts';
import { markSync } from './db.ts';
import type { SyncResult } from './sources/types.ts';

/**
 * The drag-and-drop path. Always available, regardless of whether the automated
 * sync is working — the point is that you are never locked out of your own data.
 */
export async function importFile(
  filename: string,
  bytes: Uint8Array,
  log: (message: string) => void = () => {},
): Promise<SyncResult & { source: string; filename: string }> {
  const { events, source } = parseDroppedFile(filename, bytes);

  if (events.length === 0) {
    throw new Error(
      `Couldn't find any watch records in ${filename}. Expected an IMDb ratings CSV or a Letterboxd export ZIP.`,
    );
  }

  log(`${filename}: ${events.length} rows, importing as ${source}…`);
  const result = await ingestEvents(events, source, log);

  markSync(
    source,
    'ok',
    `Imported ${filename}: ${result.added} added, ${result.updated} updated`,
  );
  queueUnindexedLibrary();

  return { ...result, source, filename };
}

/**
 * Places *your* browser is likely to have put a downloaded export.
 *
 * Deliberately excludes the app's own download folder — anything the sync put
 * there has already been imported, so offering it back would just be noise.
 */
function downloadDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Downloads'),
    path.join(home, 'OneDrive', 'Desktop'),
  ];
}

export interface FoundExport {
  file: string;
  kind: 'letterboxd' | 'imdb';
  modified: number;
}

/**
 * Look for export files the user downloaded themselves.
 *
 * Letterboxd's sign-in runs a Cloudflare check that automated browsers can't
 * clear, so downloading the export through this app isn't dependable. Exporting
 * in your own browser always works — this closes the gap so the only step left
 * is a click, not a drag.
 */
export function findExports(): FoundExport[] {
  const found: FoundExport[] = [];
  const seen = new Set<string>();

  for (const dir of downloadDirs()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      const lower = name.toLowerCase();
      const full = path.join(dir, name);
      if (seen.has(full)) continue;

      const isLetterboxd = lower.endsWith('.zip') && lower.includes('letterboxd');
      const isImdb =
        lower.endsWith('.csv') && (lower.includes('ratings') || lower.includes('imdb'));
      if (!isLetterboxd && !isImdb) continue;

      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        seen.add(full);
        found.push({
          file: full,
          kind: isLetterboxd ? 'letterboxd' : 'imdb',
          modified: stat.mtimeMs,
        });
      } catch {
        /* unreadable, skip */
      }
    }
  }

  return found.sort((a, b) => b.modified - a.modified).slice(0, 10);
}

/** Import a file already on disk, by absolute path. */
export async function importFromDisk(
  file: string,
  log: (message: string) => void = () => {},
) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  return importFile(path.basename(file), bytes, log);
}
