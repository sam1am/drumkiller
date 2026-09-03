import type { App, Screen } from '@/app';
import { DIFFICULTIES, type Difficulty, type SongListEntry, type SongPackage } from '@/types';
import { loadSongFromZip, loadSongFromFiles, availableDifficulties } from '@/song';
import { h, button, toast, pickFile, pickFolder, clear, fmtScore, fmtTime } from './dom';
import { topbar } from './topbar';
import { drawProceduralArt } from './artwork';
import { starString } from '@/game/scoring';
import { Transport } from '@/audio';

const DIFF_LABEL: Record<Difficulty, string> = { easy: 'EASY', medium: 'MEDIUM', hard: 'HARD', expert: 'EXPERT' };

export function songSelectScreen(app: App, params?: Record<string, unknown>): Screen {
  const practice = params?.practice === true;
  let entries: SongListEntry[] = [];
  let selected: SongListEntry | null = null;
  let difficulty: Difficulty = (localStorage.getItem('dk.lastDifficulty') as Difficulty) || 'medium';
  let previewTransport: Transport | null = null;
  let previewToken = 0;

  const list = h('div', { class: 'songlist' });
  const detail = h('div', { class: 'panel' }, h('div', { class: 'dim' }, 'Select a song'));

  async function refresh(): Promise<void> {
    entries = await app.library.listAll();
    clear(list);
    if (!entries.length) list.appendChild(h('div', { class: 'dim' }, 'No songs yet. Import a song zip or make one in the Studio.'));
    for (const e of entries) {
      const art = h('div', { class: 'art' });
      if (e.artworkUrl) art.style.backgroundImage = `url("${e.artworkUrl}")`;
      else {
        const c = h('canvas', { width: 400, height: 250 });
        drawProceduralArt(c, e.meta);
        art.appendChild(c);
      }
      const best = app.scores.getBestAllDifficulties(e.meta.id);
      const bestAny = Object.values(best).sort((a, b) => b.score - a.score)[0];
      const card = h(
        'div',
        { class: 'songcard', style: { '--sa': e.meta.accent ?? '' }, onClick: () => select(e, card) },
        art,
        h('div', { class: 'tags' }, h('span', { class: 'pill' }, `${Math.round(e.meta.bpm)} BPM`), e.source !== 'bundled' ? h('span', { class: 'pill accent' }, 'IMPORTED') : null),
        bestAny ? h('div', { class: 'stars' }, starString(bestAny.stars)) : null,
        h('div', { class: 'meta' }, h('div', { class: 'title' }, e.meta.title), h('div', { class: 'artist' }, e.meta.artist)),
      );
      list.appendChild(card);
      if (selected?.meta.id === e.meta.id) card.classList.add('selected');
    }
  }

  async function select(e: SongListEntry, card: HTMLElement): Promise<void> {
    selected = e;
    list.querySelectorAll('.songcard').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    renderDetail();
    startPreview(e);
  }

  async function startPreview(e: SongListEntry): Promise<void> {
    const token = ++previewToken;
    stopPreview();
    try {
      await app.boot();
      const pkg = await app.library.load(e);
      if (token !== previewToken) return;
      const audioBlob = pkg.files.get(pkg.meta.audio);
      if (!audioBlob) return;
      const buf = await app.engine.decode(await audioBlob.arrayBuffer());
      if (token !== previewToken) return;
      const t = new Transport(app.engine);
      t.load(buf);
      const start = e.meta.preview?.start ?? Math.min(30, buf.duration * 0.3);
      t.play(start);
      previewTransport = t;
      const len = e.meta.preview?.length ?? 20;
      setTimeout(() => {
        if (previewTransport === t) stopPreview();
      }, len * 1000);
    } catch (err) {
      console.warn('preview failed', err);
    }
  }

  function stopPreview(): void {
    previewTransport?.stop();
    previewTransport = null;
  }

  function renderDetail(): void {
    clear(detail);
    if (!selected) return;
    const e = selected;
    const best = app.scores.getBestAllDifficulties(e.meta.id);
    const diffs = h('div', { class: 'diffs' });
    // Availability: charts listed in meta; anything missing is auto-derived.
    const explicit = new Set(Object.keys(e.meta.charts ?? {}));
    for (const d of DIFFICULTIES) {
      const b = best[d];
      const btn = h(
        'div',
        { class: `diff ${d === difficulty ? 'selected' : ''} ${explicit.has(d) ? '' : 'derived'}`, dataset: { d }, onClick: () => { difficulty = d; localStorage.setItem('dk.lastDifficulty', d); renderDetail(); } },
        DIFF_LABEL[d],
        h('span', { class: 'best' }, b ? `${fmtScore(b.score)} · ${starString(b.stars)}` : '—'),
      );
      diffs.appendChild(btn);
    }
    const top = app.scores.getTop(e.meta.id, difficulty, 5);
    const lb = h(
      'table',
      { class: 'leaderboard' },
      h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Player'), h('th', null, 'Score'), h('th', null, 'Acc'), h('th', null, 'Combo'))),
      h('tbody', null, top.length ? top.map((s, i) => h('tr', null, h('td', null, String(i + 1)), h('td', null, s.player), h('td', null, fmtScore(s.score)), h('td', null, `${(s.accuracy * 100).toFixed(1)}%`), h('td', null, `${s.maxCombo}${s.fullCombo ? ' FC' : ''}`))) : h('tr', null, h('td', { colSpan: 5, class: 'mute' }, 'No scores yet — be the first.'))),
    );
    detail.append(
      h('h2', { class: 'display' }, e.meta.title),
      h('div', { class: 'dim' }, `${e.meta.artist}${e.meta.album ? ' · ' + e.meta.album : ''}${e.meta.year ? ' · ' + e.meta.year : ''}`),
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('span', { class: 'pill' }, `${Math.round(e.meta.bpm)} BPM`), e.meta.length ? h('span', { class: 'pill' }, fmtTime(e.meta.length)) : null, e.meta.charter ? h('span', { class: 'pill' }, `chart: ${e.meta.charter}`) : null, e.meta.samples && Object.keys(e.meta.samples).length ? h('span', { class: 'pill accent' }, 'custom kit') : null),
      h('h3', null, 'Difficulty'),
      diffs,
      h('div', { class: 'small mute', style: { marginTop: '6px' } }, 'AUTO = generated from the hardest chart in the song folder.'),
      h('h3', null, practice ? 'Practice' : 'Leaderboard'),
      practice ? h('div', { class: 'hint-box' }, 'Practice mode: adjust speed, loop sections, hear guide drums. Scores are not saved.') : lb,
      h('div', { class: 'btn-row', style: { marginTop: '20px' } },
        button(practice ? 'PRACTICE' : 'PLAY', () => play(e), 'primary big'),
        button('EDIT CHART', () => edit(e)),
        e.source !== 'bundled' ? button('REMOVE', () => remove(e), 'danger') : null,
      ),
    );
  }

  async function play(e: SongListEntry): Promise<void> {
    stopPreview();
    await app.boot();
    try {
      const pkg = await app.library.load(e);
      app.navigate('game', { pkg, difficulty, mode: practice ? 'practice' : 'play' });
    } catch (err) {
      toast(`Could not load song: ${(err as Error).message}`, 'bad');
    }
  }

  async function edit(e: SongListEntry): Promise<void> {
    stopPreview();
    await app.boot();
    try {
      const pkg = await app.library.load(e);
      app.navigate('editor', { pkg, difficulty });
    } catch (err) {
      toast(`Could not load song: ${(err as Error).message}`, 'bad');
    }
  }

  async function remove(e: SongListEntry): Promise<void> {
    if (!confirm(`Remove "${e.meta.title}" from your library? High scores are kept.`)) return;
    await app.library.remove(e.meta.id);
    selected = null;
    clear(detail);
    detail.appendChild(h('div', { class: 'dim' }, 'Select a song'));
    await refresh();
  }

  async function importPkg(pkg: SongPackage): Promise<void> {
    if (!availableDifficulties(pkg).length) {
      toast('That song has no chart MIDI files (expert.mid etc). Record one in the Studio.', 'bad');
    }
    await app.library.import(pkg);
    toast(`Imported "${pkg.meta.title}"`, 'ok');
    await refresh();
  }

  async function importZip(): Promise<void> {
    const files = await pickFile('.zip,application/zip', true);
    for (const f of files) {
      try {
        await importPkg(await loadSongFromZip(f));
      } catch (err) {
        toast(`${f.name}: ${(err as Error).message}`, 'bad');
      }
    }
  }

  async function importFolder(): Promise<void> {
    const files = await pickFolder();
    if (!files.length) return;
    try {
      await importPkg(await loadSongFromFiles(files));
    } catch (err) {
      toast(`${(err as Error).message}`, 'bad');
    }
  }

  // drag & drop zips anywhere
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    document.body.classList.add('dragover');
  };
  const onDragLeave = () => document.body.classList.remove('dragover');
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    document.body.classList.remove('dragover');
    const files = Array.from(e.dataTransfer?.files ?? []);
    for (const f of files) {
      if (!/\.zip$/i.test(f.name)) continue;
      try {
        await importPkg(await loadSongFromZip(f));
      } catch (err) {
        toast(`${f.name}: ${(err as Error).message}`, 'bad');
      }
    }
  };
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  const el = h(
    'div',
    { class: 'screen' },
    topbar(app, practice ? 'PRACTICE' : 'SELECT SONG', button('IMPORT ZIP', importZip), button('IMPORT FOLDER', importFolder), button('BACK', () => app.navigate('title'), 'ghost')),
    h('div', { class: 'screen-body' }, h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 420px', gap: '24px', alignItems: 'start' } }, list, detail)),
  );
  refresh().then(() => {
    // auto-select last played song
    const lastId = localStorage.getItem('dk.lastSong');
    const e = entries.find((x) => x.meta.id === lastId) ?? entries[0];
    if (e) {
      const card = list.children[entries.indexOf(e)] as HTMLElement | undefined;
      if (card) {
        selected = e;
        card.classList.add('selected');
        renderDetail();
      }
    }
  });
  return {
    el,
    dispose: () => {
      stopPreview();
      previewToken++;
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    },
  };
}
