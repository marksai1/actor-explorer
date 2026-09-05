import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ROOT, DATA_DIR } from '../config.ts';
import { buildSnapshot } from '../snapshot.ts';
import { encryptSnapshot, decryptSnapshot, saltFor } from '../snapshot-crypto.ts';

/**
 * Builds the offline snapshot and encrypts it for publishing.
 *
 *   npm run snapshot                 prompts for the passphrase
 *   SNAPSHOT_PASSPHRASE=... npm run snapshot     for CI
 *   npm run snapshot -- --plain      unencrypted, into .data/ only, for debugging
 *
 * The encrypted file lands in client/public/data/, which `npm run build` copies
 * into dist/. That is the one piece of your data that gets committed, and it is
 * ciphertext.
 */

const OUT_DIR = path.join(ROOT, 'client', 'public', 'data');
const OUT_FILE = path.join(OUT_DIR, 'library.enc');
const META_FILE = path.join(OUT_DIR, 'meta.json');

const args = process.argv.slice(2);
const plainOnly = args.includes('--plain');

/** Reads a passphrase without echoing it. */
function prompt(question: string): Promise<string> {
  const input = process.stdin;
  const rl = readline.createInterface({ input, output: process.stdout, terminal: true });

  return new Promise((resolve) => {
    // @ts-expect-error _writeToOutput is internal, but it is the only hook for
    // suppressing the echo, and readline has no supported alternative.
    rl._writeToOutput = function (chunk: string) {
      if (chunk.includes(question)) process.stdout.write(chunk);
    };
    rl.question(question, (answer) => {
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

const size = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;

const snapshot = buildSnapshot();
const json = JSON.stringify(snapshot);

console.log(
  `\n  ${snapshot.counts.movies} films · ${snapshot.counts.shows} shows · ` +
    `${snapshot.people.length.toLocaleString()} people · ` +
    `${snapshot.credits.length.toLocaleString()} credits`,
);
console.log(`  Snapshot JSON: ${size(Buffer.byteLength(json))}`);

if (plainOnly) {
  const target = path.join(DATA_DIR, 'snapshot.json');
  fs.writeFileSync(target, json);
  console.log(`\n  Wrote ${target} (unencrypted — .data/ is gitignored)\n`);
  process.exit(0);
}

let passphrase = process.env.SNAPSHOT_PASSPHRASE?.trim() ?? '';

if (!passphrase) {
  passphrase = (await prompt('  Passphrase: ')).trim();
  const again = (await prompt('  Again:      ')).trim();
  if (passphrase !== again) {
    console.error('\n  Those did not match. Nothing was written.\n');
    process.exit(1);
  }
}

if (passphrase.length < 8) {
  console.error('\n  Use at least 8 characters — this is the only thing guarding the file.\n');
  process.exit(1);
}

// Reusing the previous build's salt keeps the key an installed phone already
// holds valid, so a refreshed snapshot unlocks itself.
const previous = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE) : null;
const encrypted = encryptSnapshot(json, passphrase, saltFor(previous));

// Fail here rather than on the phone.
if (decryptSnapshot(encrypted, passphrase) !== json) {
  console.error('\n  Round-trip check failed. Nothing was written.\n');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, encrypted);
fs.writeFileSync(
  META_FILE,
  // Deliberately says nothing about what is inside — only how to read it.
  `${JSON.stringify({ version: snapshot.version, generatedAt: snapshot.generatedAt }, null, 2)}\n`,
);

console.log(`  Encrypted:     ${size(encrypted.length)}`);
console.log(`\n  Wrote ${path.relative(ROOT, OUT_DIR)} — both files, both safe to commit:`);
console.log('    library.enc   your library, encrypted');
console.log('    meta.json     just a timestamp, so the phone can spot a refresh\n');
