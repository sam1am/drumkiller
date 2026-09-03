/** Tiny synchronous string key-value abstraction so stores can run on localStorage or in memory. */
export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** In-memory KV (tests, private-mode fallbacks). */
export function memoryKV(initial: Record<string, string> = {}): KV {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return null;
    const probe = '__dk_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * KV backed by window.localStorage. Every call is guarded: if storage is unavailable
 * (SSR, sandboxed iframes, quota exceeded, privacy modes) it degrades to an in-memory map.
 */
export function localStorageKV(): KV {
  const fallback = memoryKV();
  return {
    get: (key) => {
      const ls = safeLocalStorage();
      if (!ls) return fallback.get(key);
      try {
        return ls.getItem(key);
      } catch {
        return fallback.get(key);
      }
    },
    set: (key, value) => {
      fallback.set(key, value);
      const ls = safeLocalStorage();
      if (!ls) return;
      try {
        ls.setItem(key, value);
      } catch {
        /* quota exceeded or blocked — keep the in-memory copy */
      }
    },
    remove: (key) => {
      fallback.remove(key);
      const ls = safeLocalStorage();
      if (!ls) return;
      try {
        ls.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Read and JSON-parse a key; returns `fallback` on missing or corrupt data. */
export function readJson<T>(kv: KV, key: string, fallback: T): T {
  const raw = kv.get(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(kv: KV, key: string, value: unknown): void {
  kv.set(key, JSON.stringify(value));
}
