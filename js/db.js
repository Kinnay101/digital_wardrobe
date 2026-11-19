// Lokale Datenbank (IndexedDB). Bilder werden als Blob gespeichert.
// Stores: items (Kleidungsstücke), outfits (gespeicherte Kombinationen),
//         outbox (noch nicht hochgeladene Änderungen), meta (Sync-Zustand, Schlüssel)

const DB_NAME = 'kleiderschrank';
const DB_VERSION = 2;
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('outfits')) db.createObjectStore('outfits', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const getAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const put = (store, value) => run(store, 'readwrite', (s) => s.put(value));
export const remove = (store, id) => run(store, 'readwrite', (s) => s.delete(id));

/* Kleiner Schlüssel-Wert-Speicher für Sync-Zustand (auch CryptoKey-Objekte lassen sich speichern) */
export const getMeta = async (key) => (await get('meta', key))?.value;
export const setMeta = (key, value) => put('meta', { key, value });
export const delMeta = (key) => remove('meta', key);

/** Echte UUID v4 (die Datenbank verlangt dieses Format), auch ohne crypto.randomUUID (z. B. über http im WLAN). */
export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Bittet den Browser, die Daten nicht automatisch zu löschen (wichtig v. a. auf iOS).
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* nicht unterstützt */ }
}
