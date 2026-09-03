/**
 * Song library — the persistent collection of imported songs (IndexedDB) plus discovery of the
 * songs bundled with the game under /songs/<slug>/.
 */
import type { SongListEntry, SongMeta, SongPackage } from '@/types';
import { loadSongFromUrl, parseSongMeta, SONG_META_FILENAME, type FetchFn } from './package';

// ─────────────────────────── Backend ───────────────────────────

export interface LibraryRecord {
  id: string;
  meta: SongMeta;
  files: Record<string, Blob>;
  addedAt: number;
}

export interface LibraryBackend {
  put(id: string, record: LibraryRecord): Promise<void>;
  get(id: string): Promise<LibraryRecord | undefined>;
  list(): Promise<LibraryRecord[]>;
  delete(id: string): Promise<void>;
}

/** In-memory backend for tests and for browsers without IndexedDB. */
export class MemoryBackend implements LibraryBackend {
  private records = new Map<string, LibraryRecord>();

  async put(id: string, record: LibraryRecord): Promise<void> {
    this.records.set(id, record);
  }
  async get(id: string): Promise<LibraryRecord | undefined> {
    return this.records.get(id);
  }
  async list(): Promise<LibraryRecord[]> {
    return [...this.records.values()];
  }
  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

export const LIBRARY_DB_NAME = 'drumkiller';
export const LIBRARY_STORE_NAME = 'songs';
export const LIBRARY_DB_VERSION = 1;

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** IndexedDB backend: database "drumkiller", object store "songs" keyed by song id. */
export class IndexedDbBackend implements LibraryBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly dbName = LIBRARY_DB_NAME,
    private readonly storeName = LIBRARY_STORE_NAME,
    private readonly version = LIBRARY_DB_VERSION,
  ) {}

  static isAvailable(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        if (!IndexedDbBackend.isAvailable()) {
          reject(new Error('IndexedDB is not available in this environment'));
          return;
        }
        const req = indexedDB.open(this.dbName, this.version);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            this.dbPromise = null;
          };
          resolve(db);
        };
        req.onerror = () => reject(req.error ?? new Error('Could not open IndexedDB'));
        req.onblocked = () => reject(new Error('IndexedDB open was blocked by another tab'));
      });
      this.dbPromise.catch(() => {
        this.dbPromise = null;
      });
    }
    return this.dbPromise;
  }

  private async store(mode: IDBTransactionMode): Promise<{ store: IDBObjectStore; tx: IDBTransaction }> {
    const db = await this.open();
    const tx = db.transaction(this.storeName, mode);
    return { store: tx.objectStore(this.storeName), tx };
  }

  async put(id: string, record: LibraryRecord): Promise<void> {
    const { store, tx } = await this.store('readwrite');
    store.put({ ...record, id });
    await txDone(tx);
  }

  async get(id: string): Promise<LibraryRecord | undefined> {
    const { store } = await this.store('readonly');
    const rec = await reqToPromise(store.get(id));
    return (rec as LibraryRecord | undefined) ?? undefined;
  }

  async list(): Promise<LibraryRecord[]> {
    const { store } = await this.store('readonly');
    return (await reqToPromise(store.getAll())) as LibraryRecord[];
  }

  async delete(id: string): Promise<void> {
    const { store, tx } = await this.store('readwrite');
    store.delete(id);
    await txDone(tx);
  }
}

/** Best available backend for the current environment. */
export function defaultLibraryBackend(): LibraryBackend {
  return IndexedDbBackend.isAvailable() ? new IndexedDbBackend() : new MemoryBackend();
}

// ─────────────────────────── Library ───────────────────────────

export const BUNDLED_INDEX_URL = '/songs/index.json';

function byTitle(a: SongListEntry, b: SongListEntry): number {
  return (
    a.meta.title.localeCompare(b.meta.title, undefined, { sensitivity: 'base' }) ||
    a.meta.artist.localeCompare(b.meta.artist, undefined, { sensitivity: 'base' })
  );
}

function objectUrlFor(blob: Blob | undefined): string | undefined {
  if (!blob) return undefined;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined;
  return URL.createObjectURL(blob);
}

export class SongLibrary {
  private artworkUrls = new Map<string, string>();

  constructor(private readonly backend: LibraryBackend = defaultLibraryBackend()) {}

  /**
   * Discover bundled songs: `indexUrl` is a JSON array of slugs (or `{ "songs": [...] }`),
   * each living at `<dir of indexUrl>/<slug>/song.json`. Missing or broken entries are skipped.
   */
  async listBundled(indexUrl = BUNDLED_INDEX_URL, fetchFn?: FetchFn): Promise<SongListEntry[]> {
    const doFetch: FetchFn = fetchFn ?? ((input, init) => fetch(input, init));
    const dir = indexUrl.replace(/\/[^/]*$/, '') || '';

    let slugs: string[];
    try {
      const res = await doFetch(indexUrl);
      if (!res.ok) return [];
      const json: unknown = await res.json();
      const arr = Array.isArray(json)
        ? json
        : json && typeof json === 'object' && Array.isArray((json as { songs?: unknown }).songs)
          ? (json as { songs: unknown[] }).songs
          : [];
      slugs = arr.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
    } catch {
      return [];
    }

    const entries = await Promise.all(
      slugs.map(async (slug): Promise<SongListEntry | null> => {
        const baseUrl = `${dir}/${slug.replace(/^\/+|\/+$/g, '')}`;
        try {
          const res = await doFetch(`${baseUrl}/${SONG_META_FILENAME}`);
          if (!res.ok) return null;
          const meta = parseSongMeta(await res.text());
          const entry: SongListEntry = { meta, source: 'bundled', baseUrl };
          if (meta.artwork) entry.artworkUrl = `${baseUrl}/${meta.artwork}`;
          return entry;
        } catch {
          return null;
        }
      }),
    );
    return entries.filter((e): e is SongListEntry => e !== null).sort(byTitle);
  }

  /** Songs the player has imported into the library. */
  async listImported(): Promise<SongListEntry[]> {
    const records = await this.backend.list();
    return records.map((r) => this.entryFromRecord(r)).sort(byTitle);
  }

  /** Bundled songs first, then imported ones; each group sorted by title. Imported ids shadow bundled ones. */
  async listAll(indexUrl = BUNDLED_INDEX_URL, fetchFn?: FetchFn): Promise<SongListEntry[]> {
    const [bundled, imported] = await Promise.all([this.listBundled(indexUrl, fetchFn), this.listImported()]);
    const importedIds = new Set(imported.map((e) => e.meta.id));
    return [...bundled.filter((e) => !importedIds.has(e.meta.id)), ...imported];
  }

  /** Store a package in the library (replaces any existing song with the same id). */
  async import(pkg: SongPackage): Promise<SongListEntry> {
    const files: Record<string, Blob> = {};
    for (const [path, blob] of pkg.files) files[path] = blob;
    const record: LibraryRecord = { id: pkg.meta.id, meta: pkg.meta, files, addedAt: Date.now() };
    await this.backend.put(record.id, record);
    this.dropArtworkUrl(record.id);
    return this.entryFromRecord(record);
  }

  async has(id: string): Promise<boolean> {
    return (await this.backend.get(id)) !== undefined;
  }

  async remove(id: string): Promise<void> {
    await this.backend.delete(id);
    this.dropArtworkUrl(id);
  }

  /** Load the full package for a list entry. */
  async load(entry: SongListEntry, fetchFn?: FetchFn): Promise<SongPackage> {
    switch (entry.source) {
      case 'bundled': {
        if (!entry.baseUrl) throw new Error(`Bundled song "${entry.meta.title}" has no baseUrl`);
        return loadSongFromUrl(entry.baseUrl, fetchFn ? { fetchFn } : {});
      }
      case 'library': {
        const rec = await this.backend.get(entry.meta.id);
        if (!rec) throw new Error(`Song "${entry.meta.title}" is no longer in the library`);
        return recordToPackage(rec);
      }
      default:
        throw new Error(`Cannot load a song entry with source "${entry.source}" from the library`);
    }
  }

  private entryFromRecord(r: LibraryRecord): SongListEntry {
    const entry: SongListEntry = { meta: r.meta, source: 'library' };
    const url = this.artworkUrl(r);
    if (url) entry.artworkUrl = url;
    return entry;
  }

  private artworkUrl(r: LibraryRecord): string | undefined {
    const cached = this.artworkUrls.get(r.id);
    if (cached) return cached;
    if (!r.meta.artwork) return undefined;
    const url = objectUrlFor(r.files[r.meta.artwork]);
    if (url) this.artworkUrls.set(r.id, url);
    return url;
  }

  private dropArtworkUrl(id: string): void {
    const url = this.artworkUrls.get(id);
    if (!url) return;
    this.artworkUrls.delete(id);
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  }
}

export function recordToPackage(rec: LibraryRecord): SongPackage {
  return { meta: rec.meta, files: new Map(Object.entries(rec.files)), source: 'library' };
}
