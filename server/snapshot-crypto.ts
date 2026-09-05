import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

/**
 * Encryption for the published snapshot.
 *
 * The repository is public, so the snapshot cannot be. This wraps it in
 * AES-256-GCM under a key stretched from a passphrase, which means the file can
 * sit in the repo and be served by GitHub Pages while reading it still needs
 * something only you know. The browser side of this is `client/src/static/decrypt.ts`
 * and the two must agree on the layout below.
 *
 *   0..3    magic "AEX1"
 *   4       format version
 *   5..8    PBKDF2 iterations, uint32 big-endian
 *   9..24   salt, 16 bytes
 *   25..36  IV, 12 bytes
 *   37..    gzipped JSON, AES-256-GCM, 16-byte tag appended
 *
 * Everything is fixed-width so the browser can slice it without a parser, and
 * the parameters travel with the file so raising the iteration count later
 * doesn't strand an already-installed app.
 */

export const HEADER_BYTES = 37;
export const MAGIC = 'AEX1';
export const FORMAT_VERSION = 1;

/**
 * 600k matches OWASP's current PBKDF2-SHA256 floor. It costs about a second on
 * a phone, paid once at unlock rather than on every launch — the decrypted
 * snapshot is kept locally afterwards.
 */
export const ITERATIONS = 600_000;

/**
 * The salt from an existing snapshot, or a fresh one.
 *
 * Reusing it is what lets an installed app decrypt tomorrow's rebuild without
 * asking for the passphrase again: the phone keeps the derived key, which is
 * only stable while the salt is. A salt is not a secret — it exists to stop one
 * precomputed table covering every user of this code — so a per-repo constant
 * still does its job. The IV is random on every build regardless, which is the
 * part that actually must never repeat.
 */
export function saltFor(existing: Uint8Array | null): Buffer {
  const file = existing ? Buffer.from(existing) : null;
  if (file && file.length >= HEADER_BYTES && file.subarray(0, 4).toString('ascii') === MAGIC) {
    return Buffer.from(file.subarray(9, 25));
  }
  return crypto.randomBytes(16);
}

export function encryptSnapshot(
  json: string,
  passphrase: string,
  salt: Uint8Array = crypto.randomBytes(16),
): Buffer {
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, Buffer.from(salt), ITERATIONS, 32, 'sha256');

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const packed = gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  const body = Buffer.concat([cipher.update(packed), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt8(FORMAT_VERSION, 4);
  header.writeUInt32BE(ITERATIONS, 5);
  Buffer.from(salt).copy(header, 9);
  iv.copy(header, 25);

  return Buffer.concat([header, body]);
}

/** Round-trip check, so a bad build fails here rather than on the phone. */
export function decryptSnapshot(file: Buffer, passphrase: string): string {
  if (file.subarray(0, 4).toString('ascii') !== MAGIC) {
    throw new Error('Not a snapshot file.');
  }
  const iterations = file.readUInt32BE(5);
  const salt = file.subarray(9, 25);
  const iv = file.subarray(25, 37);
  const body = file.subarray(HEADER_BYTES);

  const key = crypto.pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(body.subarray(body.length - 16));

  const packed = Buffer.concat([
    decipher.update(body.subarray(0, body.length - 16)),
    decipher.final(),
  ]);
  return gunzipSync(packed).toString('utf8');
}
