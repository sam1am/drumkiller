import { describe, expect, it } from 'vitest';
import { MemoryBackend, SongLibrary, createSongPackage, getAudioBlob, type FetchFn } from '@/song';

const blob = (s: string) => new Blob([new TextEncoder().encode(s)]);

function pkg(title: string, artist = 'A', extra: Record<string, unknown> = {}) {
  return createSongPackage({
    meta: { title, artist, bpm: 100, ...extra },
    audio: blob(`audio-${title}`),
    audioFileName: 'a.wav',
    charts: { expert: blob('mid') },
  });
}

function bundledFetch(songs: Record<string, object | null>, index: unknown = Object.keys(songs)): FetchFn {
  return async (url) => {
    if (url === '/songs/index.json') return new Response(JSON.stringify(index), { status: 200 });
    const m = url.match(/^\/songs\/([^/]+)\/(.+)$/);
    if (!m) return new Response('', { status: 404 });
    const [, slug, rel] = m;
    const song = songs[slug];
    if (!song) return new Response('', { status: 404 });
    if (rel === 'song.json') return new Response(JSON.stringify(song), { status: 200 });
    return new Response(`bundled-${slug}-${rel}`, { status: 200 });
  };
}

describe('SongLibrary', () => {
  it('imports, lists, loads and removes songs', async () => {
    const lib = new SongLibrary(new MemoryBackend());
    expect(await lib.listImported()).toEqual([]);

    const entry = await lib.import(pkg('Zeta'));
    expect(entry.source).toBe('library');
    expect(entry.meta.id).toBe('zeta-a');
    await lib.import(pkg('alpha'));
    await lib.import(pkg('Mid'));

    const list = await lib.listImported();
    expect(list.map((e) => e.meta.title)).toEqual(['alpha', 'Mid', 'Zeta']);
    expect(await lib.has('zeta-a')).toBe(true);

    const loaded = await lib.load(list[2]);
    expect(loaded.source).toBe('library');
    expect(loaded.meta).toEqual(entry.meta);
    expect(await getAudioBlob(loaded)?.text()).toBe('audio-Zeta');
    expect(loaded.files.get('expert.mid')).toBeDefined();

    await lib.remove('zeta-a');
    expect((await lib.listImported()).map((e) => e.meta.id)).toEqual(['alpha-a', 'mid-a']);
    await expect(lib.load(list[2])).rejects.toThrow(/no longer in the library/);
  });

  it('re-importing the same id replaces it', async () => {
    const lib = new SongLibrary(new MemoryBackend());
    await lib.import(pkg('Same', 'X', { id: 'fixed' }));
    await lib.import(pkg('Same v2', 'X', { id: 'fixed' }));
    const list = await lib.listImported();
    expect(list).toHaveLength(1);
    expect(list[0].meta.title).toBe('Same v2');
  });

  it('discovers bundled songs, tolerating missing ones', async () => {
    const lib = new SongLibrary(new MemoryBackend());
    const fetchFn = bundledFetch(
      {
        demo: { title: 'Demo Song', artist: 'Dev', bpm: 120, audio: 'a.mp3', charts: { expert: 'expert.mid' }, artwork: 'art.png' },
        broken: { title: 'no bpm', audio: 'a.mp3' },
        missing: null,
        another: { title: 'Another', artist: 'Dev', bpm: 90, audio: 'a.mp3' },
      },
      ['demo', 'broken', 'missing', 'another', 42],
    );
    const bundled = await lib.listBundled('/songs/index.json', fetchFn);
    expect(bundled.map((e) => e.meta.title)).toEqual(['Another', 'Demo Song']);
    expect(bundled[1]).toMatchObject({ source: 'bundled', baseUrl: '/songs/demo', artworkUrl: '/songs/demo/art.png' });

    const loaded = await lib.load(bundled[1], fetchFn);
    expect(loaded.source).toBe('bundled');
    expect(await loaded.files.get('expert.mid')?.text()).toBe('bundled-demo-expert.mid');

    // Unreachable index → empty, not an error.
    expect(await lib.listBundled('/songs/index.json', async () => new Response('', { status: 500 }))).toEqual([]);
    expect(await lib.listBundled('/songs/index.json', async () => { throw new Error('offline'); })).toEqual([]);
  });

  it('listAll puts bundled first, then imported, and imported ids shadow bundled ones', async () => {
    const lib = new SongLibrary(new MemoryBackend());
    const fetchFn = bundledFetch({
      demo: { id: 'demo', title: 'Demo Song', artist: 'Dev', bpm: 120, audio: 'a.mp3' },
      zzz: { title: 'Aardvark', artist: 'Dev', bpm: 120, audio: 'a.mp3' },
    });
    await lib.import(pkg('Beta'));
    await lib.import(pkg('Demo Song (my edit)', 'Me', { id: 'demo' }));

    const all = await lib.listAll('/songs/index.json', fetchFn);
    expect(all.map((e) => [e.meta.title, e.source])).toEqual([
      ['Aardvark', 'bundled'],
      ['Beta', 'library'],
      ['Demo Song (my edit)', 'library'],
    ]);
  });
});
