/**
 * The phone's copy of the library.
 *
 * IndexedDB rather than localStorage because the snapshot is megabytes and a
 * CryptoKey can only be stored somewhere that structured-clones. Installed to
 * the home screen, iOS exempts this from the seven-day eviction it applies to
 * ordinary Safari tabs, so an app that is used stays put.
 */

const DB_NAME = 'actor-explorer';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const idb = {
  get: <T,>(key: string) => tx<T | undefined>('readonly', (store) => store.get(key)),
  set: (key: string, value: unknown) =>
    tx<void>('readwrite', (store) => store.put(value, key)),
  delete: (key: string) => tx<void>('readwrite', (store) => store.delete(key)),
};

export const KEYS = {
  /** Non-extractable AES key, so a refreshed snapshot needs no passphrase. */
  cryptoKey: 'crypto-key',
  snapshot: 'snapshot',
  generatedAt: 'generated-at',
} as const;
