// Local library: book records and PDF files in IndexedDB, settings in localStorage.

import type { Theme } from './protocol';

export interface Position {
  chunk: number; // chunk (= starting page) index
  offset: number; // CSS px from the chunk's top (fallback when anchors are unknown)
  page: number; // source page of the text at the top of the screen
  srcY: number; // its baseline on that page (pt)
}

export interface BookRecord {
  id: string;
  title: string;
  fileName: string;
  size: number;
  pageCount: number;
  addedAt: number;
  openedAt: number;
  position?: Position;
}

export interface Settings {
  fontPx: number;
  lineSpacing: number;
  margin: number;
  justify: boolean;
  theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = { fontPx: 18, lineSpacing: 1.1, margin: 18, justify: true, theme: 'light' };

const SETTINGS_KEY = 'inkwrap.settings';

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('inkwrap', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const listBooks = async (): Promise<BookRecord[]> =>
  ((await tx('books', 'readonly', (s) => s.getAll())) as BookRecord[]).sort((a, b) => b.openedAt - a.openedAt);
export const getBook = (id: string) => tx('books', 'readonly', (s) => s.get(id)) as Promise<BookRecord | undefined>;
export const putBook = (b: BookRecord) => tx('books', 'readwrite', (s) => s.put(b));
export const getFile = (id: string) => tx('files', 'readonly', (s) => s.get(id)) as Promise<Blob | undefined>;
export const putFile = (id: string, blob: Blob) => tx('files', 'readwrite', (s) => s.put(blob, id));
export async function deleteBook(id: string) {
  await tx('books', 'readwrite', (s) => s.delete(id));
  await tx('files', 'readwrite', (s) => s.delete(id));
}

/** Stable id for a file's contents (so re-adding the same book keeps its reading position). */
export async function fileId(bytes: ArrayBuffer): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(d).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // insecure contexts (plain-http dev server): FNV-1a over a sample of the bytes
  const u = new Uint8Array(bytes);
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(u.length / 65536));
  for (let i = 0; i < u.length; i += step) h = Math.imul(h ^ u[i], 0x01000193);
  return (h >>> 0).toString(16) + '-' + u.length.toString(16);
}
