import type { App, Screen } from '@/app';
import { DIFFICULTIES, DRUM_VOICES, VOICE_LABELS, type Chart, type Difficulty, type SongListEntry, type SongPackage } from '@/types';
import { chartToMidi, writeMidi, constantTempoMap, DEFAULT_PPQ } from '@/midi';
import { createSongPackage, exportSongZip, slugify, fileExtension, SAMPLE_EXTENSIONS, AUDIO_EXTENSIONS, DRUMS_AUDIO_BASENAME, playableDifficulties } from '@/song';
import { Transport, Metronome } from '@/audio';
import { h, button, field, toast, clear, downloadBlob, pickFile, fmtTime, modal } from './dom';
import { topbar } from './topbar';
import { studioState, type StudioTab } from './studioState';
import { VOICE_COLORS } from '@/game/renderer';
import { applySongKit, realDifficulties } from './game';
import { offsetPicker, type OffsetPicker } from './offsetPicker';
import { chartEditor, type ChartEditor } from './chartEditor';

/** Copy into a plain ArrayBuffer so Blob typing is happy. */
function midiBytes(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

function midiBlob(chart: Chart, trackName: string): Blob {
  return new Blob([midiBytes(writeMidi(chartToMidi(chart, { trackName })))], { type: 'audio/midi' });
}

const TABS: { id: StudioTab; label: string; hint: string }[] = [
  { id: 'song', label: 'SONG', hint: 'details · tempo & offset · audio · samples' },
  { id: 'chart', label: 'CHART', hint: 'record on your pads · edit the notes' },
];

// A reload would throw away unsaved studio work.
window.addEventListener('beforeunload', (e) => {
  if (studioState.dirty) e.preventDefault();
});

/**
 * STUDIO: the song editor. Create a song from an audio file or open one from the library, then work on
 * it in two tabs — SONG (details, tempo/offset, the two mixes, custom samples) and CHART (piano-roll
 * note editor that also records pad hits straight onto the chart). Everything edits one in-memory
 * working copy; SAVE writes it to the library, SAVE AS saves a copy under a new title.
 */
export function studioScreen(app: App, params?: Record<string, unknown>): Screen {
  if (params?.tab) studioState.tab = params.tab as StudioTab;
  const body = h('div', { class: 'studio-wrap' });
  const actions = h('div', { class: 'row', style: { gap: '8px' } });
  let transport: Transport | null = null;
  let metro: Metronome | null = null;
  let picker: OffsetPicker | null = null;
  let editor: ChartEditor | null = null;
  let editorToken = 0;

  function stopPreview(): void {
    picker?.stop();
    metro?.stop();
    transport?.stop();
    metro = null;
    transport = null;
  }

  /** Write pending chart edits into the working copy and tear the editor down. */
  function closeEditor(): void {
    editorToken++;
    if (!editor) return;
    editor.flush();
    editor.dispose();
    editor = null;
  }

  function markDirty(): void {
    if (studioState.dirty) return;
    studioState.dirty = true;
    renderActions();
  }

  /** Drop the chart file for `d` from the working copy (it becomes auto-derived again). */
  function removeChart(d: Difficulty): void {
    const pkg = studioState.pkg!;
    const path = pkg.meta.charts[d];
    if (!path) return;
    pkg.files.delete(path);
    delete pkg.meta.charts[d];
    markDirty();
  }

  // ─── open / new ───
  async function openPackage(pkg: SongPackage, buf: AudioBuffer, drums: AudioBuffer | null, savedId: string | null): Promise<void> {
    stopPreview();
    closeEditor();
    studioState.reset();
    studioState.pkg = pkg;
    studioState.audioBuffer = buf;
    studioState.drumsBuffer = drums;
    studioState.savedId = savedId;
    studioState.dirty = savedId === null;
    studioState.targetDifficulty = 'expert';
    applySongKit(app, pkg).catch((err) => console.warn('kit load failed', err));
    // A chart file with no notes is no chart: drop it so the difficulty reads as AUTO everywhere.
    const real = new Set(await realDifficulties(pkg));
    const empty = DIFFICULTIES.filter((d) => pkg.meta.charts[d] && !real.has(d));
    for (const d of empty) removeChart(d);
    if (empty.length) toast(`Dropped the empty ${empty.join(', ')} chart${empty.length > 1 ? 's' : ''} — save to clean up the library copy`, 'ok', 4000);
    render();
  }

  async function newFromAudio(): Promise<void> {
    const [file] = await pickFile('audio/*,.mp3,.wav,.flac,.aac,.m4a,.ogg');
    if (!file) return;
    await app.boot();
    try {
      const buf = await app.engine.decode(await file.arrayBuffer());
      const name = file.name.replace(/\.[^.]+$/, '');
      const ext = (file.name.split('.').pop() ?? 'mp3').toLowerCase();
      const pkg = createSongPackage({ meta: { title: name, artist: 'Unknown Artist', bpm: 120, offset: 0, length: buf.duration, charter: app.settings.playerName }, audio: file, audioFileName: `audio.${ext}` });
      toast(`Loaded ${file.name} (${fmtTime(buf.duration)}) — set the tempo and offset, then record or draw a chart`, 'ok', 4000);
      await openPackage(pkg, buf, null, null);
    } catch (err) {
      toast(`Could not decode audio: ${(err as Error).message}`, 'bad');
    }
  }

  async function openExisting(e: SongListEntry): Promise<void> {
    await app.boot();
    try {
      const loaded = await app.library.load(e);
      const audioBlob = loaded.files.get(loaded.meta.audio);
      if (!audioBlob) return toast('Song has no audio', 'bad');
      const buf = await app.engine.decode(await audioBlob.arrayBuffer());
      const pkg: SongPackage = { ...loaded, files: new Map(loaded.files), meta: { ...loaded.meta, charts: { ...loaded.meta.charts }, samples: loaded.meta.samples ? { ...loaded.meta.samples } : undefined } };
      let drums: AudioBuffer | null = null;
      const drumsBlob = pkg.meta.audioWithDrums ? pkg.files.get(pkg.meta.audioWithDrums) : undefined;
      if (drumsBlob) {
        try {
          drums = await app.engine.decode(await drumsBlob.arrayBuffer());
        } catch (err) {
          toast(`Could not decode the mix with drums (${(err as Error).message}) — carrying on without it`, 'bad', 4000);
        }
      } else if (pkg.meta.audioWithDrums) {
        delete pkg.meta.audioWithDrums;
      }
      await openPackage(pkg, buf, drums, e.meta.id);
    } catch (err) {
      toast(`Could not open song: ${(err as Error).message}`, 'bad');
    }
  }

  /**
   * Pick a file for one of the song's two mixes. 'audio' is the drum-less mix the game plays: swapping it
   * keeps the charts, offset and everything else. 'drums' is the optional mix WITH drums that the chart
   * editor can switch to as a reference. The two files must start at the same instant.
   */
  async function pickAudio(kind: 'audio' | 'drums'): Promise<void> {
    const pkg = studioState.pkg;
    if (!pkg) return;
    const [file] = await pickFile('audio/*,.mp3,.wav,.flac,.aac,.m4a,.ogg');
    if (!file) return;
    const ext = fileExtension(file.name) || 'mp3';
    if (!(AUDIO_EXTENSIONS as readonly string[]).includes(ext)) return toast(`Unsupported audio type .${ext} (use ${AUDIO_EXTENSIONS.join(', ')})`, 'bad');
    await app.boot();
    let buf: AudioBuffer;
    try {
      buf = await app.engine.decode(await file.arrayBuffer());
    } catch (err) {
      return toast(`Could not decode audio: ${(err as Error).message}`, 'bad');
    }
    stopPreview();
    closeEditor();
    if (kind === 'audio') {
      const old = studioState.audioBuffer!;
      pkg.files.delete(pkg.meta.audio);
      pkg.meta.audio = `audio.${ext}`;
      pkg.files.set(pkg.meta.audio, file);
      pkg.meta.length = buf.duration;
      studioState.audioBuffer = buf;
      const diff = buf.duration - old.duration;
      const note = Math.abs(diff) > 0.05
        ? `${Math.abs(diff).toFixed(2)}s ${diff > 0 ? 'longer' : 'shorter'} than the old one — check the offset still lines up`
        : 'same length as before; charts and offset carried over';
      toast(`Audio replaced with ${file.name} (${fmtTime(buf.duration)}) — ${note}`, 'ok', 5000);
    } else {
      if (pkg.meta.audioWithDrums) pkg.files.delete(pkg.meta.audioWithDrums);
      pkg.meta.audioWithDrums = `${DRUMS_AUDIO_BASENAME}.${ext}`;
      pkg.files.set(pkg.meta.audioWithDrums, file);
      studioState.drumsBuffer = buf;
      const diff = buf.duration - studioState.audioBuffer!.duration;
      const note = Math.abs(diff) > 0.05
        ? `${Math.abs(diff).toFixed(2)}s ${diff > 0 ? 'longer' : 'shorter'} than the drum-less mix — make sure both start at the same instant`
        : 'same length as the drum-less mix';
      toast(`Mix with drums set to ${file.name} (${fmtTime(buf.duration)}) — ${note}`, 'ok', 5000);
    }
    markDirty();
    render();
  }

  function removeDrumsAudio(): void {
    const pkg = studioState.pkg;
    if (!pkg?.meta.audioWithDrums) return;
    stopPreview();
    closeEditor();
    pkg.files.delete(pkg.meta.audioWithDrums);
    delete pkg.meta.audioWithDrums;
    studioState.drumsBuffer = null;
    markDirty();
    render();
  }

  function close(): void {
    const pkg = studioState.pkg;
    if (!pkg) return;
    if (studioState.dirty && !confirm(`Close "${pkg.meta.title}" without saving? Your changes will be lost.`)) return;
    stopPreview();
    closeEditor();
    studioState.reset();
    render();
  }

  // ─── save ───
  /** An id no other song in the library uses. */
  async function uniqueId(base: string): Promise<string> {
    const ids = new Set((await app.library.listAll()).map((x) => x.meta.id));
    const root = base || 'song';
    let id = root;
    for (let n = 2; ids.has(id); n++) id = `${root}-${n}`;
    return id;
  }

  async function save(): Promise<boolean> {
    const pkg = studioState.pkg;
    if (!pkg) return false;
    editor?.flush();
    if (!pkg.meta.title.trim()) {
      toast('Give the song a title first', 'bad');
      return false;
    }
    pkg.meta.length = studioState.audioBuffer!.duration;
    if (!studioState.savedId) pkg.meta.id = await uniqueId(slugify(`${pkg.meta.title} ${pkg.meta.artist}`));
    await app.library.import(pkg);
    pkg.source = 'library';
    studioState.savedId = pkg.meta.id;
    studioState.dirty = false;
    renderActions();
    toast(`Saved "${pkg.meta.title}"`, 'ok');
    return true;
  }

  function saveAs(): void {
    const pkg = studioState.pkg;
    if (!pkg) return;
    editor?.flush();
    const titleIn = h('input', { class: 'input', value: studioState.savedId ? `${pkg.meta.title} (copy)` : pkg.meta.title });
    const confirmSave = async () => {
      const t = titleIn.value.trim();
      if (!t) return toast('Give the copy a title', 'bad');
      pkg.meta.title = t;
      pkg.meta.id = await uniqueId(slugify(`${t} ${pkg.meta.artist}`));
      studioState.savedId = pkg.meta.id; // save() keeps an assigned id
      m.close();
      if (await save()) render();
    };
    titleIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') void confirmSave(); });
    const m = modal(
      h('div', null,
        h('h2', { class: 'display', style: { marginTop: 0 } }, 'SAVE AS'),
        h('div', { class: 'dim', style: { marginBottom: '14px' } }, studioState.savedId ? 'Saves a copy of this song to your library under a new title and carries on editing the copy. The original is left as it is.' : 'Saves this song to your library.'),
        field('Title', titleIn),
        h('div', { class: 'btn-row', style: { marginTop: '16px' } }, button(studioState.savedId ? 'SAVE COPY' : 'SAVE', () => void confirmSave(), 'primary'), button('CANCEL', () => m.close(), 'ghost')),
      ),
    );
    titleIn.focus();
    titleIn.select();
  }

  async function testPlay(): Promise<void> {
    const pkg = studioState.pkg;
    if (!pkg) return;
    stopPreview();
    closeEditor();
    await app.boot();
    app.navigate('game', { pkg, difficulty: studioState.targetDifficulty, mode: 'practice', back: 'studio' });
  }

  // ─── layout ───
  function renderActions(): void {
    clear(actions);
    const pkg = studioState.pkg;
    if (!pkg) {
      actions.append(button('BACK', () => app.navigate('title'), 'ghost'));
      return;
    }
    actions.append(
      h('span', { class: `pill ${studioState.dirty ? 'accent' : ''}` }, `${pkg.meta.title || 'Untitled'}${studioState.dirty ? ' *' : ''}`),
      ...(studioState.savedId ? [] : [h('span', { class: 'pill warn' }, 'NOT SAVED YET')]),
      button('SAVE', () => void save(), 'primary'),
      button('SAVE AS…', saveAs),
      button('▶ TEST PLAY', () => void testPlay(), 'ghost'),
      button('CLOSE', close, 'ghost'),
      button('BACK', () => app.navigate('title'), 'ghost'),
    );
  }

  function go(tab: StudioTab): void {
    stopPreview();
    closeEditor();
    studioState.tab = tab;
    render();
  }

  function render(): void {
    renderActions();
    clear(body);
    if (!studioState.pkg) {
      body.classList.remove('full');
      renderOpen();
      return;
    }
    const tab = studioState.tab;
    body.classList.toggle('full', tab === 'chart');
    body.appendChild(
      h('div', { class: 'tabs' }, ...TABS.map((t) => h('div', { class: `tab ${t.id === tab ? 'active' : ''}`, onClick: () => { if (t.id !== tab) go(t.id); } },
        h('span', { class: 'label' }, t.label),
        h('span', { class: 'hint' }, t.hint)))),
    );
    switch (tab) {
      case 'song': return renderSong();
      case 'chart': return renderChart();
    }
  }

  // ─── OPEN ───
  function renderOpen(): void {
    const list = h('div', { class: 'song-rows' }, h('span', { class: 'mute' }, 'Loading…'));
    app.library.listAll().then((entries) => {
      clear(list);
      if (!entries.length) list.appendChild(h('span', { class: 'mute' }, 'Your library is empty.'));
      for (const e of entries) {
        const charts = Object.keys(e.meta.charts ?? {});
        list.appendChild(h('div', { class: 'song-row', onClick: () => void openExisting(e) },
          h('div', { class: 'who' }, h('div', { class: 'title' }, e.meta.title), h('div', { class: 'artist' }, e.meta.artist)),
          h('span', { class: 'pill' }, `${Math.round(e.meta.bpm)} BPM`),
          h('span', { class: 'pill' }, charts.length ? charts.join(' · ') : 'no charts'),
          e.source === 'bundled' ? h('span', { class: 'pill accent' }, 'BUNDLED') : null,
          button('OPEN', () => void openExisting(e), 'small'),
        ));
      }
    });
    body.append(
      h('div', { class: 'studio-open' },
        h('div', { class: 'panel' },
          h('h2', { class: 'display' }, 'NEW SONG'),
          h('div', { class: 'dim' }, 'Start from an audio file: a full mix WITHOUT drums (mp3, wav, flac, aac, m4a, ogg). Set the tempo and offset, then record the drum part on your pads or draw it in the chart editor. The game plays your drum samples on top. A second mix WITH drums can be added on the SONG tab as a reference for the editor.'),
          h('div', { class: 'btn-row', style: { marginTop: '16px' } }, button('CHOOSE AUDIO FILE', () => void newFromAudio(), 'primary big')),
        ),
        h('div', { class: 'panel' },
          h('h2', { class: 'display' }, 'OPEN A SONG'),
          h('div', { class: 'dim', style: { marginBottom: '12px' } }, 'Change its details, record onto the chart, or fix notes by hand. Saving a bundled song keeps your edited version in the library; remove it from the song list to get the original back.'),
          list,
        ),
      ),
    );
  }

  // ─── SONG ───
  function renderSong(): void {
    const pkg = studioState.pkg!;
    const meta = pkg.meta;
    const buf = studioState.audioBuffer!;
    const bpmInput = h('input', { class: 'input', type: 'number', step: 0.01, min: 20, max: 300, value: meta.bpm, onChange: (e: Event) => { meta.bpm = Number((e.target as HTMLInputElement).value) || 120; picker?.setBpm(meta.bpm); markDirty(); } });
    const offsetInput = h('input', { class: 'input', type: 'number', step: 0.001, value: meta.offset, onChange: (e: Event) => { meta.offset = Number((e.target as HTMLInputElement).value) || 0; picker?.setOffset(meta.offset); markDirty(); } });
    picker?.dispose();
    picker = offsetPicker(app, buf, meta.offset, meta.bpm, (v) => { meta.offset = v; offsetInput.value = String(v); markDirty(); }, (b) => { meta.bpm = b; bpmInput.value = String(b); markDirty(); });
    // tap tempo
    const taps: number[] = [];
    const tapBtn = button('TAP TEMPO', () => {
      const now = performance.now();
      if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
      taps.push(now);
      if (taps.length >= 4) {
        const iv = [];
        for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
        const mean = iv.slice(-8).reduce((a, b) => a + b, 0) / Math.min(8, iv.length);
        meta.bpm = Math.round((60000 / mean) * 10) / 10;
        bpmInput.value = String(meta.bpm);
        picker?.setBpm(meta.bpm);
        markDirty();
        tapBtn.textContent = `TAP TEMPO (${meta.bpm})`;
      } else tapBtn.textContent = `TAP TEMPO (${taps.length}/4)`;
    });
    const playBtn = button('▶ PLAY WITH CLICK', async () => {
      if (transport) {
        stopPreview();
        playBtn.textContent = '▶ PLAY WITH CLICK';
        return;
      }
      await app.boot();
      transport = new Transport(app.engine);
      transport.load(buf);
      metro = new Metronome(app.engine, transport);
      metro.setTempoMap(constantTempoMap(meta.bpm), DEFAULT_PPQ, [{ tick: 0, numerator: 4, denominator: 4 }]);
      metro.setOffset(meta.offset);
      await metro.prepare();
      transport.play(Math.max(0, meta.offset - 1));
      metro.start();
      playBtn.textContent = '■ STOP';
      transport.onEnded = () => { stopPreview(); playBtn.textContent = '▶ PLAY WITH CLICK'; };
    });
    const tapOffset = button('SET OFFSET = HIT PAD ON FIRST DOWNBEAT', async () => {
      await app.boot();
      stopPreview();
      transport = new Transport(app.engine);
      transport.load(buf);
      transport.play(0);
      toast('Playing from the top — hit any pad on the first downbeat (beat 1 of bar 1)');
      const unsub = app.input.onHit((hit) => {
        const t = transport!.positionAtPerfTime(hit.timeStamp) - app.engine.inputLatencyCompensation + app.settings.inputOffset;
        meta.offset = Math.round(t * 1000) / 1000;
        offsetInput.value = String(meta.offset);
        picker?.setOffset(meta.offset);
        markDirty();
        unsub();
        stopPreview();
        toast(`Offset set to ${meta.offset.toFixed(3)}s`, 'ok');
      });
    });
    const text = (key: 'title' | 'artist' | 'album') =>
      h('input', { class: 'input', value: meta[key] ?? '', onInput: (e: Event) => {
        const v = (e.target as HTMLInputElement).value;
        if (key === 'album') meta.album = v || undefined;
        else meta[key] = v;
        markDirty();
        if (key === 'title') renderActions();
      } });
    const playable = playableDifficulties(meta);
    const chartPills = DIFFICULTIES.map((d) => h('span', { class: `pill ${meta.charts[d] ? 'ok' : playable.includes(d) ? '' : 'mute'}` }, `${d}: ${meta.charts[d] ? 'chart' : playable.includes(d) ? 'auto' : 'not offered'}`));
    body.append(
      h('div', { class: 'studio' },
        h('div', { class: 'panel' },
          h('h2', { class: 'display' }, 'SONG DETAILS'),
          h('div', { class: 'grid-2' },
            field('Title', text('title')),
            field('Artist', text('artist')),
            field('Album', text('album')),
            field('Accent colour', h('input', { class: 'input', type: 'color', value: meta.accent ?? '#ff2d75', onChange: (e: Event) => { meta.accent = (e.target as HTMLInputElement).value; markDirty(); } })),
          ),
          h('h3', null, 'Tempo'),
          h('div', { class: 'row' }, h('div', { class: 'field', style: { flex: '0 0 140px', marginBottom: 0 } }, h('label', null, 'BPM'), bpmInput), tapBtn, playBtn),
          h('div', { class: 'small mute', style: { marginTop: '6px' } }, 'Tap along to the song, or type the BPM. Then press PLAY WITH CLICK to check the click lines up.'),
          h('h3', null, 'Offset'),
          h('div', { class: 'small mute', style: { marginBottom: '8px' } }, 'Chart time 0 = beat 1 of bar 1. Place the mark where that downbeat lands in the audio, then fine-tune it on the zoomed view and play around it to check.'),
          picker.el,
          h('div', { class: 'row', style: { marginTop: '10px' } }, h('div', { class: 'field', style: { flex: '0 0 140px', marginBottom: 0 } }, h('label', null, 'Seconds before beat 1'), offsetInput), tapOffset),
        ),
        h('div', { class: 'panel' },
          h('h3', { style: { marginTop: 0 } }, 'Charts'),
          h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, ...chartPills),
          h('div', { class: 'small mute', style: { marginTop: '6px' } }, 'AUTO = generated from the hardest chart when the song is played. Difficulties above the hardest chart are not offered to players. A chart with no notes counts as no chart. Record onto a difficulty or edit it on the CHART tab to make it real.'),
          h('h3', null, 'Custom drum samples'),
          h('div', { class: 'small dim' }, 'Optional. Assign a sample (wav/mp3/flac/aac) per drum for this song. Missing drums use the built-in kit.'),
          samplesEditor(),
          h('h3', null, 'Audio'),
          audioSlot('Mix without drums', 'What the game plays. Swapping it keeps the charts and the offset.', meta.audio, buf,
            button('REPLACE…', () => void pickAudio('audio'), 'small')),
          audioSlot('Mix with drums', 'Optional. The chart editor can switch to it while you program or record.', meta.audioWithDrums, studioState.drumsBuffer,
            button(meta.audioWithDrums ? 'REPLACE…' : 'ADD…', () => void pickAudio('drums'), 'small'),
            meta.audioWithDrums ? button('REMOVE', removeDrumsAudio, 'ghost small') : null),
          h('div', { class: 'small dim', style: { margin: '6px 0 8px' } }, 'Both mixes need to start at the same instant so the offset and charts line up on either one.'),
          h('h3', null, 'Share'),
          h('div', { class: 'small dim', style: { marginBottom: '8px' } }, 'The song folder holds song.json, the audio, one MIDI per difficulty (GM drum notes, channel 10) and any custom samples. Zip it to share it.'),
          h('div', { class: 'btn-row' }, button('DOWNLOAD SONG ZIP', async () => { editor?.flush(); downloadBlob(await exportSongZip(pkg), `${pkg.meta.id}.zip`); })),
        ),
      ),
    );
  }

  /** One of the song's audio files: label, decoded stats (or "none") and its buttons. */
  function audioSlot(label: string, hint: string, path: string | undefined, buf: AudioBuffer | null, ...buttons: (HTMLElement | null)[]): HTMLElement {
    return h('div', { class: 'audio-slot' },
      h('div', { class: 'who' },
        h('div', { class: 'name' }, label),
        h('div', { class: 'small mono dim' }, path && buf ? `${path} · ${fmtTime(buf.duration)} · ${buf.sampleRate} Hz · ${buf.numberOfChannels} ch` : 'none'),
        h('div', { class: 'small mute' }, hint),
      ),
      h('div', { class: 'btn-row' }, ...buttons),
    );
  }

  function samplesEditor(): HTMLElement {
    const list = h('div', { class: 'voice-list', style: { gridTemplateColumns: '1fr 1fr' } });
    const pkg = studioState.pkg!;
    const rerender = () => {
      clear(list);
      for (const voice of DRUM_VOICES) {
        const path = pkg.meta.samples?.[voice];
        list.appendChild(h('div', { class: 'voice-chip', style: { '--v': VOICE_COLORS[voice] } },
          h('div', { class: 'name' }, VOICE_LABELS[voice]),
          h('div', { class: 'pads' }, path ? path.split('/').pop() : 'built-in'),
          h('div', { class: 'btn-row' },
            button('PICK', async () => {
              const [f] = await pickFile('audio/*');
              if (!f) return;
              const ext = fileExtension(f.name);
              if (!(SAMPLE_EXTENSIONS as readonly string[]).includes(ext)) return toast(`Unsupported sample type .${ext} (use ${SAMPLE_EXTENSIONS.join(', ')})`, 'bad');
              if (path) pkg.files.delete(path);
              const p = `samples/${voice}.${ext}`;
              pkg.files.set(p, f);
              (pkg.meta.samples ??= {})[voice] = p;
              markDirty();
              rerender();
              applySongKit(app, pkg).catch((err) => console.warn('kit load failed', err));
            }, 'icon small'),
            path ? button('✕', () => {
              pkg.files.delete(path);
              delete pkg.meta.samples![voice];
              if (!Object.keys(pkg.meta.samples!).length) delete pkg.meta.samples;
              markDirty();
              rerender();
              applySongKit(app, pkg).catch((err) => console.warn('kit load failed', err));
            }, 'icon ghost small') : null,
            button('▶', async () => { await app.boot(); app.kit.trigger(voice, 1); }, 'icon ghost small'),
          ),
        ));
      }
    };
    rerender();
    return list;
  }

  // ─── CHART ───
  function renderChart(): void {
    const pkg = studioState.pkg!;
    const token = ++editorToken;
    const pane = h('div', { class: 'studio-pane chart' }, h('div', { class: 'dim' }, 'Loading chart…'));
    body.appendChild(pane);
    chartEditor(app, {
      pkg,
      audio: studioState.audioBuffer!,
      drumsAudio: studioState.drumsBuffer ?? undefined,
      difficulty: studioState.targetDifficulty,
      onChange: markDirty,
      onDifficulty: (d) => { studioState.targetDifficulty = d; },
      onSave: () => void save(),
      actions: [
        button('EXPORT MIDI', () => { if (!editor) return; downloadBlob(midiBlob(editor.toChart(), pkg.meta.title), `${slugify(pkg.meta.title)}-${editor.difficulty}.mid`); }),
      ],
    }).then((ed) => {
      if (token !== editorToken) {
        ed.dispose();
        return;
      }
      editor = ed;
      clear(pane);
      pane.appendChild(ed.el);
    }).catch((err) => {
      clear(pane);
      pane.appendChild(h('div', { class: 'hint-box' }, `Could not open the chart: ${(err as Error).message}`));
    });
  }

  const el = h('div', { class: 'screen' }, topbar(app, 'STUDIO', actions), h('div', { class: 'screen-body studio-body' }, body));
  render();
  return {
    el,
    dispose: () => {
      stopPreview();
      closeEditor();
      picker?.dispose();
    },
  };
}
