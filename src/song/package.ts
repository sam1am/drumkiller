/**
 * Song package handling — a "song" is a self-contained folder (song.json + audio + chart MIDIs +
 * optional samples/artwork). This module loads such folders from zips, directory pickers and
 * bundled URLs into an in-memory {@link SongPackage}, and writes them back out as zips.
 */
import JSZip from 'jszip';
import type { Difficulty, DrumVoice, SongMeta, SongPackage } from '@/types';
import { DIFFICULTIES, DRUM_VOICES } from '@/types';

// ─────────────────────────── Constants ───────────────────────────

export const SONG_META_FILENAME = 'song.json';

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'] as const;
export const SAMPLE_EXTENSIONS = ['wav', 'mp3', 'flac', 'aac', 'm4a', 'ogg'] as const;
export const ARTWORK_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] as const;

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  mid: 'audio/midi',
  midi: 'audio/midi',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
};

/** Minimal fetch signature so loaders can be tested without a network. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

// ─────────────────────────── Small helpers ───────────────────────────

/** Lower-case, ASCII-only, dash-separated identifier. Idempotent on existing slugs. */
export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Forward slashes, no leading "./" or "/", no duplicate slashes, no "." segments. */
export function normalizePath(p: string): string {
  const parts = p
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.');
  return parts.join('/');
}

export function fileExtension(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function mimeForPath(path: string): string {
  return MIME_BY_EXT[fileExtension(path)] ?? 'application/octet-stream';
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** Files that zip tools and OSes sprinkle into folders, never part of a song. */
function isJunkPath(path: string): boolean {
  return (
    path.startsWith('__MACOSX/') ||
    path.includes('/__MACOSX/') ||
    basename(path) === '.DS_Store' ||
    basename(path) === 'Thumbs.db' ||
    basename(path).startsWith('._')
  );
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

// ─────────────────────────── song.json ───────────────────────────

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(msg: string): never {
  throw new Error(`song.json: ${msg}`);
}

function optString(obj: JsonObject, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fail(`"${key}" must be a string`);
  return v;
}

function reqString(obj: JsonObject, key: string): string {
  const v = optString(obj, key);
  if (v === undefined || v.trim() === '') fail(`"${key}" is required and must be a non-empty string`);
  return v.trim();
}

function optNumber(obj: JsonObject, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`"${key}" must be a finite number`);
  return v;
}

function optRelPath(obj: JsonObject, key: string): string | undefined {
  const v = optString(obj, key);
  if (v === undefined) return undefined;
  const p = normalizePath(v);
  if (p === '') fail(`"${key}" must be a non-empty relative path`);
  if (p.split('/').includes('..')) fail(`"${key}" must not contain ".." segments`);
  return p;
}

/**
 * Validate a parsed song.json value and fill in defaults.
 * Throws an Error with a human-readable message on any problem.
 */
export function parseSongMeta(json: unknown): SongMeta {
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json);
    } catch (e) {
      fail(`not valid JSON (${(e as Error).message})`);
    }
  }
  if (!isObject(json)) fail('must be a JSON object');
  const obj = json;

  // format
  const format = obj.format === undefined ? 1 : obj.format;
  if (format !== 1) fail(`unsupported "format" ${JSON.stringify(format)} (expected 1)`);

  // identity
  const title = reqString(obj, 'title');
  const artist = optString(obj, 'artist')?.trim() || 'Unknown Artist';
  let id: string;
  if (obj.id === undefined || obj.id === null || obj.id === '') {
    id = slugify(`${title} ${artist}`);
  } else {
    if (typeof obj.id !== 'string') fail('"id" must be a string');
    id = slugify(obj.id);
  }
  if (id === '') fail('could not derive a usable "id" — give the song a title with letters or digits, or set "id" explicitly');

  // timing
  const bpm = optNumber(obj, 'bpm');
  if (bpm === undefined) fail('"bpm" is required');
  if (bpm <= 0) fail(`"bpm" must be > 0 (got ${bpm})`);
  const offset = optNumber(obj, 'offset') ?? 0;

  // audio
  const audio = optRelPath(obj, 'audio');
  if (audio === undefined) fail('"audio" is required (relative path to the drum-less mix, e.g. "audio.mp3")');

  // charts
  const charts: Partial<Record<Difficulty, string>> = {};
  if (obj.charts !== undefined && obj.charts !== null) {
    if (!isObject(obj.charts)) fail('"charts" must be an object mapping difficulty → MIDI path');
    for (const [key, value] of Object.entries(obj.charts)) {
      if (!(DIFFICULTIES as readonly string[]).includes(key)) {
        fail(`"charts" has unknown difficulty "${key}" (expected one of ${DIFFICULTIES.join(', ')})`);
      }
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || normalizePath(value) === '') fail(`"charts.${key}" must be a relative path`);
      charts[key as Difficulty] = normalizePath(value);
    }
  }

  // samples
  let samples: Partial<Record<DrumVoice, string>> | undefined;
  if (obj.samples !== undefined && obj.samples !== null) {
    if (!isObject(obj.samples)) fail('"samples" must be an object mapping drum voice → audio path');
    samples = {};
    for (const [key, value] of Object.entries(obj.samples)) {
      if (!(DRUM_VOICES as readonly string[]).includes(key)) {
        fail(`"samples" has unknown voice "${key}" (expected one of ${DRUM_VOICES.join(', ')})`);
      }
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || normalizePath(value) === '') fail(`"samples.${key}" must be a relative path`);
      samples[key as DrumVoice] = normalizePath(value);
    }
    if (Object.keys(samples).length === 0) samples = undefined;
  }

  const sampleGain = optNumber(obj, 'sampleGain');
  if (sampleGain !== undefined && sampleGain < 0) fail('"sampleGain" must be >= 0');

  const artwork = optRelPath(obj, 'artwork');

  let preview: SongMeta['preview'];
  if (obj.preview !== undefined && obj.preview !== null) {
    if (!isObject(obj.preview)) fail('"preview" must be an object { start, length }');
    const start = optNumber(obj.preview, 'start') ?? 0;
    const length = optNumber(obj.preview, 'length') ?? 20;
    if (start < 0) fail('"preview.start" must be >= 0');
    if (length <= 0) fail('"preview.length" must be > 0');
    preview = { start, length };
  }

  const accent = optString(obj, 'accent')?.trim() || undefined;
  const length = optNumber(obj, 'length');
  if (length !== undefined && length <= 0) fail('"length" must be > 0');

  const year = optNumber(obj, 'year');
  if (year !== undefined && !Number.isInteger(year)) fail('"year" must be an integer');

  const meta: SongMeta = {
    format: 1,
    id,
    title,
    artist,
    bpm,
    offset,
    audio,
    charts,
  };
  const album = optString(obj, 'album')?.trim();
  const charter = optString(obj, 'charter')?.trim();
  const genre = optString(obj, 'genre')?.trim();
  if (album) meta.album = album;
  if (year !== undefined) meta.year = year;
  if (charter) meta.charter = charter;
  if (genre) meta.genre = genre;
  if (samples) meta.samples = samples;
  if (sampleGain !== undefined) meta.sampleGain = sampleGain;
  if (artwork) meta.artwork = artwork;
  if (preview) meta.preview = preview;
  if (accent) meta.accent = accent;
  if (length !== undefined) meta.length = length;
  return meta;
}

/** Pretty-printed song.json with a stable, human-friendly key order. */
export function serializeSongMeta(meta: SongMeta): string {
  const ordered: Record<string, unknown> = {
    format: 1,
    id: meta.id,
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    year: meta.year,
    charter: meta.charter,
    genre: meta.genre,
    bpm: meta.bpm,
    offset: meta.offset,
    length: meta.length,
    audio: meta.audio,
    charts: meta.charts,
    samples: meta.samples,
    sampleGain: meta.sampleGain,
    artwork: meta.artwork,
    preview: meta.preview,
    accent: meta.accent,
  };
  for (const k of Object.keys(ordered)) if (ordered[k] === undefined) delete ordered[k];
  return JSON.stringify(ordered, null, 2) + '\n';
}

// ─────────────────────────── Package assembly ───────────────────────────

interface RawEntry {
  path: string;
  blob: Blob;
}

/**
 * Turn a flat list of (path, blob) entries into a SongPackage: locate song.json (shallowest wins),
 * treat its directory as the folder root, and drop everything outside it.
 */
async function assemblePackage(entries: RawEntry[], source: SongPackage['source']): Promise<SongPackage> {
  const clean = entries
    .map((e) => ({ path: normalizePath(e.path), blob: e.blob }))
    .filter((e) => e.path !== '' && !isJunkPath(e.path));

  const candidates = clean
    .filter((e) => basename(e.path) === SONG_META_FILENAME)
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const metaEntry = candidates[0];
  if (!metaEntry) throw new Error(`No ${SONG_META_FILENAME} found in the song folder`);

  const root = dirname(metaEntry.path);
  const prefix = root === '' ? '' : root + '/';

  const files = new Map<string, Blob>();
  for (const e of clean) {
    if (prefix && !e.path.startsWith(prefix)) continue;
    files.set(e.path.slice(prefix.length), e.blob);
  }

  const meta = parseSongMeta(await metaEntry.blob.text());
  const pkg: SongPackage = { meta, files, source };
  const missing = missingFiles(pkg);
  if (missing.includes(meta.audio)) {
    throw new Error(`Song "${meta.title}" references audio file "${meta.audio}" but it is not in the folder`);
  }
  return pkg;
}

/** Referenced-but-absent relative paths (audio, charts, samples, artwork). */
export function missingFiles(pkg: SongPackage): string[] {
  const refs: string[] = [pkg.meta.audio];
  for (const p of Object.values(pkg.meta.charts)) if (p) refs.push(p);
  for (const p of Object.values(pkg.meta.samples ?? {})) if (p) refs.push(p);
  if (pkg.meta.artwork) refs.push(pkg.meta.artwork);
  return refs.filter((p) => !pkg.files.has(p));
}

// ─────────────────────────── Loaders ───────────────────────────

/** Load a song from a .zip. The song folder may sit at the root or nested inside one top-level folder. */
export async function loadSongFromZip(data: Blob | ArrayBuffer | Uint8Array): Promise<SongPackage> {
  const bytes = data instanceof Blob ? await blobToArrayBuffer(data) : data;
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (e) {
    throw new Error(`Not a valid zip file (${(e as Error).message})`);
  }
  const entries: RawEntry[] = [];
  for (const [rawPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const path = normalizePath(rawPath);
    if (path === '' || isJunkPath(path)) continue;
    const buf = await entry.async('arraybuffer');
    entries.push({ path, blob: new Blob([buf], { type: mimeForPath(path) }) });
  }
  return assemblePackage(entries, 'zip');
}

/** A File from `<input webkitdirectory>` (has webkitRelativePath) or an explicit (blob, path) pair. */
export type FolderInput = File | { file: Blob; path: string };

/** Load a song from a directory picker selection. The top-level folder name is stripped. */
export async function loadSongFromFiles(files: Iterable<FolderInput>): Promise<SongPackage> {
  const entries: RawEntry[] = [];
  for (const f of files) {
    if (f instanceof Blob) {
      const file = f as File & { webkitRelativePath?: string };
      const path = file.webkitRelativePath && file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name;
      entries.push({ path, blob: file });
    } else {
      entries.push({ path: f.path, blob: f.file });
    }
  }
  if (entries.length === 0) throw new Error('No files were selected');
  return assemblePackage(entries, 'folder');
}

export interface LoadFromUrlOptions {
  fetchFn?: FetchFn;
}

/** Load a bundled song folder served over HTTP: `${baseUrl}/song.json` plus every referenced file. */
export async function loadSongFromUrl(baseUrl: string, opts: LoadFromUrlOptions = {}): Promise<SongPackage> {
  const fetchFn: FetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const base = baseUrl.replace(/\/+$/, '');
  const urlFor = (rel: string) => `${base}/${rel.split('/').map(encodeURIComponent).join('/')}`;

  const metaRes = await fetchFn(urlFor(SONG_META_FILENAME));
  if (!metaRes.ok) throw new Error(`Could not fetch ${urlFor(SONG_META_FILENAME)} (HTTP ${metaRes.status})`);
  const meta = parseSongMeta(await metaRes.text());

  const files = new Map<string, Blob>();
  const fetchInto = async (rel: string, required: boolean): Promise<void> => {
    if (files.has(rel)) return;
    let res: Response;
    try {
      res = await fetchFn(urlFor(rel));
    } catch (e) {
      if (required) throw new Error(`Could not fetch "${rel}" for song "${meta.title}": ${(e as Error).message}`);
      return;
    }
    if (!res.ok) {
      if (required) throw new Error(`Could not fetch "${rel}" for song "${meta.title}" (HTTP ${res.status})`);
      return;
    }
    const buf = await res.arrayBuffer();
    const type = res.headers.get('content-type')?.split(';')[0].trim() || mimeForPath(rel);
    files.set(rel, new Blob([buf], { type }));
  };

  const jobs: Promise<void>[] = [fetchInto(meta.audio, true)];
  for (const p of Object.values(meta.charts)) if (p) jobs.push(fetchInto(p, true));
  for (const p of Object.values(meta.samples ?? {})) if (p) jobs.push(fetchInto(p, false));
  if (meta.artwork) jobs.push(fetchInto(meta.artwork, false));
  await Promise.all(jobs);

  return { meta, files, source: 'bundled', baseUrl: base };
}

// ─────────────────────────── Export ───────────────────────────

/** Zip the package as `<id>/song.json` + `<id>/<every file>`. song.json is regenerated from `meta`. */
export async function exportSongZip(pkg: SongPackage): Promise<Blob> {
  const zip = new JSZip();
  const folder = pkg.meta.id;
  zip.file(`${folder}/${SONG_META_FILENAME}`, serializeSongMeta(pkg.meta));
  for (const [path, blob] of pkg.files) {
    if (path === SONG_META_FILENAME) continue;
    zip.file(`${folder}/${path}`, await blobToArrayBuffer(blob), { binary: true });
  }
  const out = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return new Blob([out], { type: 'application/zip' });
}

// ─────────────────────────── Accessors ───────────────────────────

export function getFile(pkg: SongPackage, relPath: string): Blob | undefined {
  return pkg.files.get(normalizePath(relPath));
}

export function getAudioBlob(pkg: SongPackage): Blob | undefined {
  return getFile(pkg, pkg.meta.audio);
}

export function getChartBlob(pkg: SongPackage, difficulty: Difficulty): Blob | undefined {
  const p = pkg.meta.charts[difficulty];
  return p ? getFile(pkg, p) : undefined;
}

/** Difficulties that have a chart file actually present, in easy→expert order. */
export function availableDifficulties(pkg: SongPackage): Difficulty[] {
  return DIFFICULTIES.filter((d) => getChartBlob(pkg, d) !== undefined);
}

export function hardestAvailable(pkg: SongPackage): Difficulty | null {
  const avail = availableDifficulties(pkg);
  return avail.length ? avail[avail.length - 1] : null;
}

/**
 * Difficulties a song can be played on, from its metadata alone: every difficulty up to and
 * including the hardest chart listed. Easier ones are derived from that chart; harder ones would
 * only be a copy of it, so they are not offered. Empty when the song lists no charts.
 */
export function playableDifficulties(meta: Pick<SongMeta, 'charts'>): Difficulty[] {
  const listed = DIFFICULTIES.filter((d) => !!meta.charts?.[d]);
  if (!listed.length) return [];
  const top = DIFFICULTIES.indexOf(listed[listed.length - 1]);
  return DIFFICULTIES.slice(0, top + 1);
}

const artworkUrlCache = new WeakMap<SongPackage, string>();

/** Object URL for the artwork (cached per package). Undefined when there is no artwork. */
export function getArtworkUrl(pkg: SongPackage): string | undefined {
  const cached = artworkUrlCache.get(pkg);
  if (cached) return cached;
  if (!pkg.meta.artwork) return undefined;
  const blob = getFile(pkg, pkg.meta.artwork);
  if (!blob) return undefined;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined;
  const url = URL.createObjectURL(blob);
  artworkUrlCache.set(pkg, url);
  return url;
}

/** Release the cached artwork object URL (call when the package is discarded). */
export function revokeArtworkUrl(pkg: SongPackage): void {
  const url = artworkUrlCache.get(pkg);
  if (url) {
    artworkUrlCache.delete(pkg);
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  }
}

// ─────────────────────────── Creation (recorder / studio) ───────────────────────────

export interface CreateSongPackageOptions {
  meta: Partial<SongMeta> & { title: string; artist: string; bpm: number };
  audio: Blob;
  audioFileName: string;
  charts?: Partial<Record<Difficulty, Blob>>;
  samples?: Partial<Record<DrumVoice, { blob: Blob; fileName: string }>>;
  artwork?: { blob: Blob; fileName: string };
}

function extOrThrow(fileName: string, allowed: readonly string[], what: string): string {
  const ext = fileExtension(fileName);
  if (!allowed.includes(ext)) {
    throw new Error(`Unsupported ${what} file "${fileName}" (expected one of: ${allowed.join(', ')})`);
  }
  return ext;
}

/**
 * Build a brand-new song folder in memory. Layout produced:
 *   audio.<ext>, <difficulty>.mid, samples/<voice>.<ext>, artwork.<ext>, song.json (virtual — from meta)
 */
export function createSongPackage(opts: CreateSongPackageOptions): SongPackage {
  const files = new Map<string, Blob>();

  const audioExt = extOrThrow(opts.audioFileName, AUDIO_EXTENSIONS, 'audio');
  const audioPath = `audio.${audioExt}`;
  files.set(audioPath, opts.audio);

  const charts: Partial<Record<Difficulty, string>> = {};
  for (const d of DIFFICULTIES) {
    const blob = opts.charts?.[d];
    if (!blob) continue;
    const p = `${d}.mid`;
    charts[d] = p;
    files.set(p, blob);
  }

  let samples: Partial<Record<DrumVoice, string>> | undefined;
  for (const v of DRUM_VOICES) {
    const s = opts.samples?.[v];
    if (!s) continue;
    const ext = extOrThrow(s.fileName, SAMPLE_EXTENSIONS, `sample (${v})`);
    const p = `samples/${v}.${ext}`;
    (samples ??= {})[v] = p;
    files.set(p, s.blob);
  }

  let artwork: string | undefined;
  if (opts.artwork) {
    const ext = extOrThrow(opts.artwork.fileName, ARTWORK_EXTENSIONS, 'artwork');
    artwork = `artwork.${ext}`;
    files.set(artwork, opts.artwork.blob);
  }

  const meta = parseSongMeta({
    ...opts.meta,
    format: 1,
    audio: audioPath,
    charts,
    samples,
    artwork,
  });

  return { meta, files, source: 'folder' };
}
