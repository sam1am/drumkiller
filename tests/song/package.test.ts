import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  availableDifficulties,
  createSongPackage,
  exportSongZip,
  getArtworkUrl,
  getAudioBlob,
  getChartBlob,
  getFile,
  hardestAvailable,
  playableDifficulties,
  loadSongFromFiles,
  loadSongFromUrl,
  loadSongFromZip,
  missingFiles,
  normalizePath,
  parseSongMeta,
  serializeSongMeta,
  slugify,
  type FetchFn,
} from '@/song';
import type { SongPackage } from '@/types';

const bytes = (s: string) => new TextEncoder().encode(s);
const blob = (s: string, type = 'application/octet-stream') => new Blob([bytes(s)], { type });

async function text(b: Blob | undefined): Promise<string | undefined> {
  return b ? b.text() : undefined;
}

function samplePkg(): SongPackage {
  return createSongPackage({
    meta: { title: 'Thunder Road', artist: 'The Test Band', bpm: 128, offset: 0.25, charter: 'me' },
    audio: blob('AUDIO-BYTES', 'audio/mpeg'),
    audioFileName: 'Thunder Road (drumless).MP3',
    charts: { expert: blob('MIDI-EXPERT'), easy: blob('MIDI-EASY') },
    samples: { kick: { blob: blob('KICK'), fileName: 'kick.wav' }, crash: { blob: blob('CRASH'), fileName: 'c.flac' } },
    artwork: { blob: blob('PNG', 'image/png'), fileName: 'cover.png' },
  });
}

async function expectSamePackage(a: SongPackage, b: SongPackage) {
  expect(b.meta).toEqual(a.meta);
  const aKeys = [...a.files.keys()].filter((k) => k !== 'song.json').sort();
  const bKeys = [...b.files.keys()].filter((k) => k !== 'song.json').sort();
  expect(bKeys).toEqual(aKeys);
  for (const k of aKeys) expect(await text(b.files.get(k))).toBe(await text(a.files.get(k)));
}

describe('slugify / normalizePath', () => {
  it('slugifies text', () => {
    expect(slugify('Thunder Road — The Test Band!')).toBe('thunder-road-the-test-band');
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu');
    expect(slugify('already-a-slug')).toBe('already-a-slug');
    expect(slugify('___')).toBe('');
  });
  it('normalizes paths', () => {
    expect(normalizePath('./charts\\expert.mid')).toBe('charts/expert.mid');
    expect(normalizePath('/a//b/./c')).toBe('a/b/c');
  });
});

describe('parseSongMeta', () => {
  it('fills defaults', () => {
    const meta = parseSongMeta({ title: 'My Song', artist: 'Someone', bpm: 120, audio: './audio.mp3' });
    expect(meta).toEqual({
      format: 1,
      id: 'my-song-someone',
      title: 'My Song',
      artist: 'Someone',
      bpm: 120,
      offset: 0,
      audio: 'audio.mp3',
      charts: {},
    });
  });

  it('keeps explicit fields and normalizes paths', () => {
    const meta = parseSongMeta({
      id: 'custom-id',
      title: 'T',
      artist: 'A',
      bpm: 90,
      offset: -0.1,
      audio: 'song.ogg',
      charts: { expert: 'charts\\expert.mid', easy: 'easy.mid' },
      samples: { kick: './samples/kick.wav' },
      sampleGain: 0.8,
      artwork: 'art.jpg',
      preview: { start: 30, length: 15 },
      accent: '#ff0000',
      length: 200,
      year: 1999,
      album: 'Alb',
      genre: 'Rock',
    });
    expect(meta.id).toBe('custom-id');
    expect(meta.charts).toEqual({ expert: 'charts/expert.mid', easy: 'easy.mid' });
    expect(meta.samples).toEqual({ kick: 'samples/kick.wav' });
    expect(meta.preview).toEqual({ start: 30, length: 15 });
    expect(meta.sampleGain).toBe(0.8);
    expect(meta.year).toBe(1999);
  });

  it('accepts a JSON string', () => {
    expect(parseSongMeta('{"title":"x","bpm":100,"audio":"a.wav"}').artist).toBe('Unknown Artist');
  });

  it('rejects bad input with descriptive errors', () => {
    expect(() => parseSongMeta(null)).toThrow(/JSON object/);
    expect(() => parseSongMeta({ artist: 'a', bpm: 1, audio: 'x' })).toThrow(/"title"/);
    expect(() => parseSongMeta({ title: 't', bpm: 0, audio: 'x' })).toThrow(/"bpm" must be > 0/);
    expect(() => parseSongMeta({ title: 't', bpm: 'fast', audio: 'x' })).toThrow(/"bpm"/);
    expect(() => parseSongMeta({ title: 't', bpm: 100 })).toThrow(/"audio" is required/);
    expect(() => parseSongMeta({ title: 't', bpm: 100, audio: 'x', format: 2 })).toThrow(/format/);
    expect(() => parseSongMeta({ title: 't', bpm: 100, audio: 'x', charts: { insane: 'i.mid' } })).toThrow(/unknown difficulty "insane"/);
    expect(() => parseSongMeta({ title: 't', bpm: 100, audio: 'x', samples: { cowbell: 'c.wav' } })).toThrow(/unknown voice "cowbell"/);
    expect(() => parseSongMeta({ title: 't', bpm: 100, audio: '../x.mp3' })).toThrow(/\.\./);
    expect(() => parseSongMeta({ title: 't', bpm: 100, audio: 'x', preview: { start: -1 } })).toThrow(/preview.start/);
    expect(() => parseSongMeta('{not json')).toThrow(/not valid JSON/);
  });

  it('round-trips through serializeSongMeta', () => {
    const meta = samplePkg().meta;
    const json = serializeSongMeta(meta);
    expect(json.startsWith('{\n  "format": 1,\n  "id":')).toBe(true);
    expect(parseSongMeta(JSON.parse(json))).toEqual(meta);
  });
});

describe('createSongPackage + accessors', () => {
  it('lays out files and meta', async () => {
    const pkg = samplePkg();
    expect(pkg.source).toBe('folder');
    expect(pkg.meta.id).toBe('thunder-road-the-test-band');
    expect(pkg.meta.audio).toBe('audio.mp3');
    expect(pkg.meta.charts).toEqual({ easy: 'easy.mid', expert: 'expert.mid' });
    expect(pkg.meta.samples).toEqual({ kick: 'samples/kick.wav', crash: 'samples/crash.flac' });
    expect(pkg.meta.artwork).toBe('artwork.png');
    expect([...pkg.files.keys()].sort()).toEqual(
      ['artwork.png', 'audio.mp3', 'easy.mid', 'expert.mid', 'samples/crash.flac', 'samples/kick.wav'].sort(),
    );
    expect(await text(getAudioBlob(pkg))).toBe('AUDIO-BYTES');
    expect(await text(getChartBlob(pkg, 'expert'))).toBe('MIDI-EXPERT');
    expect(getChartBlob(pkg, 'hard')).toBeUndefined();
    expect(getFile(pkg, './samples/kick.wav')).toBeDefined();
    expect(availableDifficulties(pkg)).toEqual(['easy', 'expert']);
    expect(hardestAvailable(pkg)).toBe('expert');
    expect(missingFiles(pkg)).toEqual([]);
    const url = getArtworkUrl(pkg);
    expect(url).toMatch(/^blob:/);
    expect(getArtworkUrl(pkg)).toBe(url);
  });

  it('rejects unknown audio extensions', () => {
    expect(() =>
      createSongPackage({ meta: { title: 't', artist: 'a', bpm: 100 }, audio: blob('x'), audioFileName: 'x.wma' }),
    ).toThrow(/Unsupported audio/);
  });

  it('playableDifficulties runs up to the hardest chart listed and no further', () => {
    expect(playableDifficulties({ charts: {} })).toEqual([]);
    expect(playableDifficulties({ charts: { expert: 'expert.mid' } })).toEqual(['easy', 'medium', 'hard', 'expert']);
    expect(playableDifficulties({ charts: { medium: 'medium.mid' } })).toEqual(['easy', 'medium']);
    expect(playableDifficulties({ charts: { easy: 'e.mid', hard: 'h.mid' } })).toEqual(['easy', 'medium', 'hard']);
  });

  it('hardestAvailable is null with no charts', () => {
    const pkg = createSongPackage({ meta: { title: 't', artist: 'a', bpm: 100 }, audio: blob('x'), audioFileName: 'x.wav' });
    expect(hardestAvailable(pkg)).toBeNull();
    expect(getArtworkUrl(pkg)).toBeUndefined();
  });
});

describe('zip round trip', () => {
  it('exportSongZip → loadSongFromZip preserves files and meta', async () => {
    const pkg = samplePkg();
    const zipBlob = await exportSongZip(pkg);
    expect(zipBlob.type).toBe('application/zip');

    const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer());
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    expect(names).toEqual(
      [
        'thunder-road-the-test-band/song.json',
        'thunder-road-the-test-band/audio.mp3',
        'thunder-road-the-test-band/easy.mid',
        'thunder-road-the-test-band/expert.mid',
        'thunder-road-the-test-band/samples/kick.wav',
        'thunder-road-the-test-band/samples/crash.flac',
        'thunder-road-the-test-band/artwork.png',
      ].sort(),
    );

    const loaded = await loadSongFromZip(zipBlob);
    expect(loaded.source).toBe('zip');
    await expectSamePackage(pkg, loaded);
    expect(loaded.files.has('song.json')).toBe(true);
    expect(loaded.files.get('audio.mp3')?.type).toBe('audio/mpeg');
  });

  it('accepts an ArrayBuffer and a differently named / deeper top folder, ignoring junk', async () => {
    const pkg = samplePkg();
    const original = await JSZip.loadAsync(await (await exportSongZip(pkg)).arrayBuffer());
    const renamed = new JSZip();
    for (const [name, entry] of Object.entries(original.files)) {
      if (entry.dir) continue;
      const rel = name.replace(/^thunder-road-the-test-band\//, '');
      renamed.file(`Downloads/Some Folder Name/${rel}`, await entry.async('arraybuffer'));
    }
    renamed.file('__MACOSX/Some Folder Name/._song.json', 'junk');
    renamed.file('Downloads/Some Folder Name/.DS_Store', 'junk');
    renamed.file('Downloads/README.txt', 'outside the song folder');
    const buf = await renamed.generateAsync({ type: 'arraybuffer' });

    const loaded = await loadSongFromZip(buf);
    await expectSamePackage(pkg, loaded);
    expect(loaded.files.has('README.txt')).toBe(false);
    expect(loaded.files.has('.DS_Store')).toBe(false);
  });

  it('works with song.json at the zip root', async () => {
    const zip = new JSZip();
    zip.file('song.json', JSON.stringify({ title: 'Root', artist: 'R', bpm: 100, audio: 'a.wav', charts: { expert: 'expert.mid' } }));
    zip.file('a.wav', 'wav');
    zip.file('expert.mid', 'mid');
    const loaded = await loadSongFromZip(await zip.generateAsync({ type: 'uint8array' }));
    expect(loaded.meta.id).toBe('root-r');
    expect([...loaded.files.keys()].sort()).toEqual(['a.wav', 'expert.mid', 'song.json']);
  });

  it('fails clearly on missing song.json, missing audio, or a non-zip', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'nothing here');
    await expect(loadSongFromZip(await zip.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow(/No song.json/);

    const zip2 = new JSZip();
    zip2.file('s/song.json', JSON.stringify({ title: 'x', bpm: 1, audio: 'missing.mp3' }));
    await expect(loadSongFromZip(await zip2.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow(/missing.mp3/);

    await expect(loadSongFromZip(bytes('definitely not a zip').buffer)).rejects.toThrow(/Not a valid zip/);
  });
});

describe('loadSongFromFiles', () => {
  it('accepts (blob, path) pairs and strips the top folder', async () => {
    const pkg = samplePkg();
    const inputs = [...pkg.files].map(([path, file]) => ({ file, path: `My Song Folder/${path}` }));
    inputs.push({ file: blob(serializeSongMeta(pkg.meta)), path: 'My Song Folder/song.json' });
    inputs.push({ file: blob('junk'), path: 'My Song Folder/.DS_Store' });
    const loaded = await loadSongFromFiles(inputs);
    expect(loaded.source).toBe('folder');
    await expectSamePackage(pkg, loaded);
  });

  it('accepts File objects (with or without webkitRelativePath)', async () => {
    const meta = parseSongMeta({ title: 'F', artist: 'G', bpm: 100, audio: 'a.wav' });
    const f1 = new File([serializeSongMeta(meta)], 'song.json');
    const f2 = new File(['wav'], 'a.wav');
    Object.defineProperty(f1, 'webkitRelativePath', { value: 'folder/song.json' });
    Object.defineProperty(f2, 'webkitRelativePath', { value: 'folder/a.wav' });
    const loaded = await loadSongFromFiles([f1, f2]);
    expect(loaded.meta.id).toBe('f-g');
    expect(await text(getAudioBlob(loaded))).toBe('wav');

    const plain = await loadSongFromFiles([new File([serializeSongMeta(meta)], 'song.json'), new File(['wav2'], 'a.wav')]);
    expect(await text(getAudioBlob(plain))).toBe('wav2');
  });

  it('rejects an empty selection', async () => {
    await expect(loadSongFromFiles([])).rejects.toThrow(/No files/);
  });
});

describe('loadSongFromUrl', () => {
  function fakeFetch(routes: Record<string, string>, log: string[] = []): FetchFn {
    return async (url) => {
      log.push(url);
      const body = routes[url];
      if (body === undefined) return new Response('nope', { status: 404 });
      const type = url.endsWith('.json') ? 'application/json' : url.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream';
      return new Response(body, { status: 200, headers: { 'content-type': type } });
    };
  }

  it('fetches song.json and all referenced files', async () => {
    const log: string[] = [];
    const fetchFn = fakeFetch(
      {
        '/songs/demo/song.json': JSON.stringify({
          title: 'Demo', artist: 'Dev', bpm: 100, audio: 'Audio File.mp3',
          charts: { expert: 'expert.mid' }, samples: { snare: 'samples/snare.wav' }, artwork: 'art.png',
        }),
        '/songs/demo/Audio%20File.mp3': 'AUDIO',
        '/songs/demo/expert.mid': 'MIDI',
        '/songs/demo/samples/snare.wav': 'SNARE',
        '/songs/demo/art.png': 'ART',
      },
      log,
    );
    const pkg = await loadSongFromUrl('/songs/demo/', { fetchFn });
    expect(pkg.source).toBe('bundled');
    expect(pkg.baseUrl).toBe('/songs/demo');
    expect([...pkg.files.keys()].sort()).toEqual(['Audio File.mp3', 'art.png', 'expert.mid', 'samples/snare.wav']);
    expect(await text(getAudioBlob(pkg))).toBe('AUDIO');
    expect(getAudioBlob(pkg)?.type).toBe('audio/mpeg');
    expect(log[0]).toBe('/songs/demo/song.json');
  });

  it('tolerates missing optional files but fails on missing audio/charts', async () => {
    const base = { title: 'Demo', artist: 'Dev', bpm: 100, audio: 'a.mp3', charts: { expert: 'x.mid' }, artwork: 'art.png' };
    const ok = await loadSongFromUrl('/s', {
      fetchFn: fakeFetch({ '/s/song.json': JSON.stringify(base), '/s/a.mp3': 'A', '/s/x.mid': 'M' }),
    });
    expect(ok.files.has('art.png')).toBe(false);
    expect(missingFiles(ok)).toEqual(['art.png']);

    await expect(
      loadSongFromUrl('/s', { fetchFn: fakeFetch({ '/s/song.json': JSON.stringify(base), '/s/a.mp3': 'A' }) }),
    ).rejects.toThrow(/x\.mid.*HTTP 404/);
    await expect(loadSongFromUrl('/s', { fetchFn: fakeFetch({}) })).rejects.toThrow(/song.json.*404/);
  });
});

describe('audioWithDrums (optional mix with drums)', () => {
  it('parses, serializes and is optional', () => {
    const meta = parseSongMeta({ title: 'T', bpm: 100, audio: 'audio.mp3', audioWithDrums: './audio-drums.mp3' });
    expect(meta.audioWithDrums).toBe('audio-drums.mp3');
    expect(parseSongMeta(JSON.parse(serializeSongMeta(meta)))).toEqual(meta);
    expect(parseSongMeta({ title: 'T', bpm: 100, audio: 'audio.mp3' }).audioWithDrums).toBeUndefined();
    expect(() => parseSongMeta({ title: 'T', bpm: 100, audio: 'a.mp3', audioWithDrums: '../x.mp3' })).toThrow(/\.\./);
  });

  it('createSongPackage lays it out as audio-drums.<ext> and missingFiles tracks it', () => {
    const pkg = createSongPackage({ meta: { title: 't', artist: 'a', bpm: 100 }, audio: blob('x'), audioFileName: 'x.wav', audioWithDrums: { blob: blob('with drums'), fileName: 'Full Mix.MP3' } });
    expect(pkg.meta.audioWithDrums).toBe('audio-drums.mp3');
    expect(getFile(pkg, 'audio-drums.mp3')).toBeDefined();
    expect(missingFiles(pkg)).toEqual([]);
    pkg.files.delete('audio-drums.mp3');
    expect(missingFiles(pkg)).toEqual(['audio-drums.mp3']);
    expect(() =>
      createSongPackage({ meta: { title: 't', artist: 'a', bpm: 100 }, audio: blob('x'), audioFileName: 'x.wav', audioWithDrums: { blob: blob('y'), fileName: 'y.wma' } }),
    ).toThrow(/Unsupported audio \(with drums\)/);
  });

  it('loadSongFromUrl fetches it when listed and drops the reference when the file is absent', async () => {
    const routes = (withDrums: boolean): Record<string, string> => ({
      'http://x/s/song.json': JSON.stringify({ title: 'S', bpm: 100, audio: 'a.mp3', audioWithDrums: 'd.mp3', charts: { expert: 'e.mid' } }),
      'http://x/s/a.mp3': 'A',
      'http://x/s/e.mid': 'E',
      ...(withDrums ? { 'http://x/s/d.mp3': 'D' } : {}),
    });
    const fetchFn = (r: Record<string, string>): FetchFn => async (url) => (url in r ? new Response(r[url], { status: 200 }) : new Response('nope', { status: 404 }));
    const withIt = await loadSongFromUrl('http://x/s', { fetchFn: fetchFn(routes(true)) });
    expect(withIt.meta.audioWithDrums).toBe('d.mp3');
    expect(await text(withIt.files.get('d.mp3'))).toBe('D');
    const without = await loadSongFromUrl('http://x/s', { fetchFn: fetchFn(routes(false)) });
    expect(without.meta.audioWithDrums).toBeUndefined();
    expect(missingFiles(without)).toEqual([]);
  });
});
