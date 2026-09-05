import { gunzipSync } from 'fflate';

/**
 * The browser half of `server/snapshot-crypto.ts`. The layout is documented
 * there; this file must not drift from it.
 */

const HEADER_BYTES = 37;
const MAGIC = 'AEX1';

export interface Envelope {
  iterations: number;
  salt: Uint8Array;
  iv: Uint8Array;
  body: Uint8Array;
}

export function parseEnvelope(buffer: ArrayBuffer): Envelope {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < HEADER_BYTES) throw new Error('That snapshot file is truncated.');

  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== MAGIC) throw new Error('That is not a snapshot file.');

  const view = new DataView(buffer);
  return {
    iterations: view.getUint32(5, false),
    salt: bytes.subarray(9, 25),
    iv: bytes.subarray(25, 37),
    body: bytes.subarray(HEADER_BYTES),
  };
}

/**
 * Stretches the passphrase into an AES key.
 *
 * Non-extractable on purpose: it gets stored in IndexedDB so a refreshed
 * snapshot can decrypt itself silently, and this way what is stored can be used
 * but never read back out as a passphrase.
 */
export async function deriveKey(passphrase: string, envelope: Envelope): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: envelope.salt as BufferSource,
      iterations: envelope.iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

/** Throws `WrongPassphrase` when the tag doesn't check out — which is the common case. */
export class WrongPassphrase extends Error {
  constructor() {
    super("That passphrase doesn't open this snapshot.");
    this.name = 'WrongPassphrase';
  }
}

export async function decryptEnvelope(envelope: Envelope, key: CryptoKey): Promise<string> {
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.iv as BufferSource },
      key,
      envelope.body as BufferSource,
    );
  } catch {
    // AES-GCM authenticates before it decrypts, so a failure here is a wrong
    // key or a corrupted file and nothing else.
    throw new WrongPassphrase();
  }
  return new TextDecoder().decode(gunzipSync(new Uint8Array(plain)));
}
