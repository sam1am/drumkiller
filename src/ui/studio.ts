import type { App, Screen } from '@/app';
import { DIFFICULTIES, DRUM_VOICES, VOICE_LABELS, type Chart, type Difficulty, type DrumVoice, type QuantizeOptions, type SongListEntry, type SongPackage } from '@/types';
import { chartToMidi, writeMidi, performanceToChart, quantizePerformance, QUANTIZE_GRIDS, constantTempoMap, DEFAULT_PPQ, chartStats, difficultyRating, deriveDifficulty } from '@/midi';
import { createSongPackage, exportSongZip, slugify, fileExtension, SAMPLE_EXTENSIONS, AUDIO_EXTENSIONS, playableDifficulties } from '@/song';
import { Transport, ChartPlayer, Metronome } from '@/audio';
import { h, button, field, toast, clear, downloadBlob, pickFile, select, fmtTime, modal } from './dom';
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
  { id: 'song', label: 'SONG', hint: 'details · tempo & offset · samples' },
  { id: 'record', label: 'RECORD', hint: 'play a take on your pads' },
  { id: 'chart', label: 'CHART', hint: 'edit the notes' },
];

// A reload would throw away unsaved studio work.
window.addEventListener('beforeunload', (e) => {
  if (studioState.dirty) e.preventDefault();
});

/**
 * STUDIO: the song editor. Create a song from an audio file or open one from the library, then work on
 * it in three tabs — SONG (details, tempo/offset, custom samples), RECORD (capture a take on the pads
 * and quantize it into a chart) and CHART (piano-roll note editor). Everything edits one in-memory
 * working copy; SAVE writes it to the library, SAVE AS saves a copy under a new title.
 */
export function studioScreen(app: App, params?: Record<string, unknown>): Screen {
  if (params?.tab) studioState.tab = params.tab as StudioTab;
  const body = h('div', { class: 'studio-wrap' });
  const actions = h('div', { class: 'row', style: { gap: '8px' } });
  let transport: Transport | null = null;
  let player: ChartPlayer | null = null;
  let metro: Metronome | null = null;
  let picker: OffsetPicker | null = null;
  let editor: ChartEditor | null = null;
  let editorToken = 0;
  let quant: QuantizeOptions = { grid: '1/16', strength: 1, swing: 0, dedupeWindow: 0.03 };
  let quantized: Chart | null = null;
  let deriveEasier = true;
  /** RECORD tab: show the recording setup even though a take is pending. */
  let recordSetup = false;

  studioState.chartForRecording = (pkg) => baseChart(pkg);

  function baseChart(pkg: SongPackage): Chart {
    return { ppq: DEFAULT_PPQ, tempoMap: constantTempoMap(pkg.meta.bpm), timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }], notes: [], duration: studioState.audioBuffer ? studioState.audioBuffer.duration - pkg.meta.offset : 0 };
  }

  function stopPreview(): void {
    picker?.stop();
    player?.stop();
    metro?.stop();
    transport?.stop();
    player = null;
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

  /** Put `chart` into the working copy as `<difficulty>.mid`. A chart with no notes removes the difficulty instead. */
  function setChart(d: Difficulty, chart: Chart, auto = false): void {
    const pkg = studioState.pkg!;
    if (!chart.notes.length) return removeChart(d);
    pkg.files.set(`${d}.mid`, midiBlob(chart, `${pkg.meta.title} — ${d}${auto ? ' (auto)' : ''}`));
    pkg.meta.charts[d] = `${d}.mid`;
    markDirty();
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
  async function openPackage(pkg: SongPackage, buf: AudioBuffer, savedId: string | null): Promise<void> {
    stopPreview();
    closeEditor();
    studioState.reset();
    studioState.pkg = pkg;
    studioState.audioBuffer = buf;
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
      await openPackage(pkg, buf, null);
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
      await openPackage(pkg, buf, e.meta.id);
    } catch (err) {
      toast(`Could not open song: ${(err as Error).message}`, 'bad');
    }
  }

  /**
   * Swap the song's audio for another file, keeping the charts, offset and everything else. For working
   * against a mix WITH drums while programming and shipping the drum-less mix at the end — the two files
   * must start at the same instant for the offset to carry over.
   */
  async function replaceAudio(): Promise<void> {
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
    const old = studioState.audioBuffer!;
    pkg.files.delete(pkg.meta.audio);
    pkg.meta.audio = `audio.${ext}`;
    pkg.files.set(pkg.meta.audio, file);
    pkg.meta.length = buf.duration;
    studioState.audioBuffer = buf;
    markDirty();
    const diff = buf.duration - old.duration;
    const note = Math.abs(diff) > 0.05
      ? `${Math.abs(diff).toFixed(2)}s ${diff > 0 ? 'longer' : 'shorter'} than the old one — check the offset still lines up`
      : 'same length as before; charts and offset carried over';
    toast(`Audio replaced with ${file.name} (${fmtTime(buf.duration)}) — ${note}`, 'ok', 5000);
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
        h('span', { class: 'label' }, t.label, t.id === 'record' && studioState.recorded.length ? h('span', { class: 'dot' }) : null),
        h('span', { class: 'hint' }, t.hint)))),
    );
    switch (tab) {
      case 'song': return renderSong();
      case 'record': return renderRecord();
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
          h('div', { class: 'dim' }, 'Start from an audio file: a full mix WITHOUT drums (mp3, wav, flac, aac, m4a, ogg). Set the tempo and offset, then record the drum part on your pads or draw it in the chart editor. The game plays your drum samples on top.'),
          h('div', { class: 'btn-row', style: { marginTop: '16px' } }, button('CHOOSE AUDIO FILE', () => void newFromAudio(), 'primary big')),
        ),
        h('div', { class: 'panel' },
          h('h2', { class: 'display' }, 'OPEN A SONG'),
          h('div', { class: 'dim', style: { marginBottom: '12px' } }, 'Change its details, record a new take, or fix notes in the chart. Saving a bundled song keeps your edited version in the library; remove it from the song list to get the original back.'),
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
          h('div', { class: 'small mute', style: { marginTop: '6px' } }, 'AUTO = generated from the hardest chart when the song is played. Difficulties above the hardest chart are not offered to players. A chart with no notes counts as no chart. Record a take or edit the chart to make one real.'),
          h('h3', null, 'Custom drum samples'),
          h('div', { class: 'small dim' }, 'Optional. Assign a sample (wav/mp3/flac/aac) per drum for this song. Missing drums use the built-in kit.'),
          samplesEditor(),
          h('h3', null, 'Audio'),
          h('div', { class: 'small mono dim' }, `${meta.audio} · ${fmtTime(buf.duration)} · ${buf.sampleRate} Hz · ${buf.numberOfChannels} ch`),
          h('div', { class: 'small dim', style: { margin: '6px 0 8px' } }, 'Swap the mix without touching the charts or the offset — e.g. program against a mix WITH drums, then replace it with the drum-less mix for the final version. The two files need to start at the same instant.'),
          h('div', { class: 'btn-row' }, button('REPLACE AUDIO…', () => void replaceAudio())),
          h('h3', null, 'Share'),
          h('div', { class: 'small dim', style: { marginBottom: '8px' } }, 'The song folder holds song.json, the audio, one MIDI per difficulty (GM drum notes, channel 10) and any custom samples. Zip it to share it.'),
          h('div', { class: 'btn-row' }, button('DOWNLOAD SONG ZIP', async () => { editor?.flush(); downloadBlob(await exportSongZip(pkg), `${pkg.meta.id}.zip`); })),
        ),
      ),
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

  // ─── RECORD ───
  function renderRecord(): void {
    if (studioState.recorded.length && !recordSetup) renderTake();
    else renderRecordSetup();
  }

  function renderRecordSetup(): void {
    const pkg = studioState.pkg!;
    const d = studioState.targetDifficulty;
    body.append(
      h('div', { class: 'panel', style: { maxWidth: '760px', margin: '0 auto' } },
        h('h2', { class: 'display' }, 'RECORD A TAKE'),
        h('div', { class: 'hint-box' }, `You'll get a ${studioState.countInBars}-bar count-in${studioState.metronome ? ' with a metronome' : ''}, then the song plays. Every pad hit is captured with its velocity. Your hits appear on the highway and recede into the distance as you carve the chart. Press ESC to abort.`),
        h('div', { style: { marginTop: '16px' } }, h('span', { class: 'pill' }, `${pkg.meta.bpm} BPM`), ' ', h('span', { class: 'pill' }, `offset ${pkg.meta.offset}s`), ' ', h('span', { class: 'pill' }, app.input.deviceConfig ? app.input.deviceConfig.deviceName : 'keyboard only')),
        studioState.recorded.length ? h('div', { style: { marginTop: '12px' } }, h('span', { class: 'pill ok' }, `pending take: ${studioState.recorded.length} hits`), ' ', button('BACK TO THE TAKE →', () => { recordSetup = false; render(); }, 'small')) : null,
        h('h3', null, 'Which difficulty is this take for?'),
        h('div', { class: 'diffs', style: { maxWidth: '520px' } }, ...DIFFICULTIES.map((x) => h('div', { class: `diff ${x === d ? 'selected' : ''}`, dataset: { d: x }, onClick: () => { studioState.targetDifficulty = x; render(); } }, x.toUpperCase(), h('span', { class: 'best' }, pkg.meta.charts?.[x] ? 'has chart · will replace' : 'new')))),
        h('div', { class: 'small mute', style: { marginTop: '6px' } }, 'Record the hardest part you can play; easier difficulties can be generated from it.'),
        h('h3', null, 'Count-in'),
        h('div', { class: 'row' },
          h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: studioState.metronome, onChange: (e: Event) => { studioState.metronome = (e.target as HTMLInputElement).checked; } }), 'Metronome while recording'),
          h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', null, 'Count-in bars'), select([1, 2, 4].map((n) => ({ value: String(n), label: `${n}` })), String(studioState.countInBars), (v) => { studioState.countInBars = Number(v); })),
        ),
        h('div', { class: 'btn-row', style: { marginTop: '24px' } },
          button(`● START RECORDING · ${d.toUpperCase()}`, async () => { stopPreview(); await app.boot(); app.navigate('game', { pkg, difficulty: d, mode: 'record' }); }, 'primary big'),
        ),
      ),
    );
  }

  function renderTake(): void {
    const pkg = studioState.pkg!;
    const tempoMap = constantTempoMap(pkg.meta.bpm);
    const statsEl = h('div');
    const canvas = h('canvas');
    const timeline = h('div', { class: 'timeline' }, canvas);
    const applyQuant = () => {
      const notes = quantizePerformance(studioState.recorded, tempoMap, DEFAULT_PPQ, quant);
      quantized = performanceToChart(notes, tempoMap, DEFAULT_PPQ);
      quantized.duration = Math.max(quantized.duration, studioState.audioBuffer!.duration - pkg.meta.offset);
      studioState.chart = quantized;
      const st = chartStats(quantized);
      clear(statsEl);
      statsEl.append(
        h('div', { class: 'grid-3' },
          h('div', { class: 'stat' }, h('div', { class: 'v' }, String(st.notes)), h('div', { class: 'k' }, 'notes')),
          h('div', { class: 'stat' }, h('div', { class: 'v' }, st.notesPerSecond.toFixed(1)), h('div', { class: 'k' }, 'notes / sec')),
          h('div', { class: 'stat' }, h('div', { class: 'v' }, `${difficultyRating(quantized)}/10`), h('div', { class: 'k' }, 'difficulty')),
        ),
        h('div', { class: 'small mono dim', style: { marginTop: '8px' } }, DRUM_VOICES.map((v) => `${VOICE_LABELS[v]}: ${st.perVoice[v] ?? 0}`).join(' · ')),
      );
      drawTimeline();
      if (player) player.setNotes(quantized.notes);
    };
    const drawTimeline = () => {
      const ctx = canvas.getContext('2d')!;
      const w = (canvas.width = timeline.clientWidth * devicePixelRatio);
      const hh = (canvas.height = timeline.clientHeight * devicePixelRatio);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, hh);
      const dur = Math.max(1, studioState.audioBuffer!.duration);
      const lanes = DRUM_VOICES;
      const beat = 60 / pkg.meta.bpm;
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      for (let b = 0; b * beat < dur; b++) {
        const x = ((b * beat + pkg.meta.offset) / dur) * w;
        ctx.lineWidth = b % 4 === 0 ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, hh);
        ctx.stroke();
      }
      const draw = (notes: { time: number; voice: DrumVoice; velocity: number }[], alpha: number) => {
        for (const n of notes) {
          const x = ((n.time + pkg.meta.offset) / dur) * w;
          const y = (lanes.indexOf(n.voice) + 0.5) * (hh / lanes.length);
          ctx.globalAlpha = alpha;
          ctx.fillStyle = VOICE_COLORS[n.voice];
          ctx.fillRect(x - 1, y - 3 - n.velocity * 3, 2 * devicePixelRatio, 6 + n.velocity * 6);
        }
        ctx.globalAlpha = 1;
      };
      draw(studioState.recorded, 0.25);
      if (quantized) draw(quantized.notes, 1);
      if (transport) {
        const x = (transport.position / dur) * w;
        ctx.fillStyle = '#fff';
        ctx.fillRect(x, 0, 2, hh);
      }
    };
    const gridSel = select(QUANTIZE_GRIDS.map((g) => ({ value: g.id, label: g.label })), quant.grid, (v) => { quant = { ...quant, grid: v as QuantizeOptions['grid'] }; applyQuant(); });
    const strengthV = h('span', { class: 'mono small' }, `${Math.round(quant.strength * 100)}%`);
    const strength = h('input', { class: 'input', type: 'range', min: 0, max: 1, step: 0.05, value: quant.strength, onInput: (e: Event) => { quant = { ...quant, strength: Number((e.target as HTMLInputElement).value) }; strengthV.textContent = `${Math.round(quant.strength * 100)}%`; applyQuant(); } });
    const swingV = h('span', { class: 'mono small' }, `${Math.round(quant.swing * 100)}%`);
    const swing = h('input', { class: 'input', type: 'range', min: 0, max: 1, step: 0.05, value: quant.swing, onInput: (e: Event) => { quant = { ...quant, swing: Number((e.target as HTMLInputElement).value) }; swingV.textContent = `${Math.round(quant.swing * 100)}%`; applyQuant(); } });
    const dedupe = h('input', { class: 'input', type: 'number', min: 0, max: 200, step: 5, value: Math.round(quant.dedupeWindow * 1000), onChange: (e: Event) => { quant = { ...quant, dedupeWindow: Number((e.target as HTMLInputElement).value) / 1000 }; applyQuant(); } });
    let raf = 0;
    const playBtn = button('▶ PREVIEW (song + your drums)', async () => {
      if (transport) { stopPreview(); cancelAnimationFrame(raf); playBtn.textContent = '▶ PREVIEW (song + your drums)'; return; }
      await app.boot();
      await applySongKit(app, pkg);
      transport = new Transport(app.engine);
      transport.load(studioState.audioBuffer!);
      player = new ChartPlayer(app.engine, app.kit, transport);
      player.setNotes(quantized!.notes);
      player.setOffset(pkg.meta.offset);
      transport.play(0);
      player.start();
      playBtn.textContent = '■ STOP';
      transport.onEnded = () => { stopPreview(); playBtn.textContent = '▶ PREVIEW (song + your drums)'; };
      const tick = () => { drawTimeline(); if (transport) raf = requestAnimationFrame(tick); };
      tick();
    });
    new ResizeObserver(() => drawTimeline()).observe(timeline);
    timeline.addEventListener('click', (e) => {
      if (!transport) return;
      const r = timeline.getBoundingClientRect();
      const frac = (e.clientX - r.left) / r.width;
      transport.seek(frac * studioState.audioBuffer!.duration);
      player?.resync();
    });
    const diffSel = select(DIFFICULTIES.map((d) => ({ value: d, label: `${d.toUpperCase()}${pkg.meta.charts?.[d] ? ' (replaces chart)' : ''}` })), studioState.targetDifficulty, (v) => { studioState.targetDifficulty = v as Difficulty; useBtn.textContent = useLabel(); });
    const useLabel = () => `USE TAKE AS ${studioState.targetDifficulty.toUpperCase()} CHART →`;
    const useBtn = button(useLabel(), () => {
      const chart = quantized;
      if (!chart) return;
      const d = studioState.targetDifficulty;
      stopPreview();
      cancelAnimationFrame(raf);
      setChart(d, chart);
      const made: string[] = [d];
      if (deriveEasier) {
        for (const x of DIFFICULTIES) {
          if (x === d || pkg.meta.charts[x] || DIFFICULTIES.indexOf(x) > DIFFICULTIES.indexOf(d)) continue;
          setChart(x, deriveDifficulty(chart, x), true);
          made.push(x);
        }
      }
      studioState.recorded = [];
      studioState.chart = null;
      quantized = null;
      toast(`Take written to the ${made.join(', ')} chart${made.length > 1 ? 's' : ''} — fine-tune it here, then SAVE`, 'ok', 4000);
      go('chart');
    }, 'primary big');
    body.append(
      h('div', { class: 'studio' },
        h('div', { class: 'panel' },
          h('h2', { class: 'display' }, 'QUANTIZE THE TAKE'),
          h('div', { class: 'dim' }, `${studioState.recorded.length} raw hits captured. Snap them to the grid, preview, then use the take as a chart.`),
          h('div', { style: { marginTop: '14px' } }, timeline),
          h('div', { class: 'small mute', style: { marginTop: '4px' } }, 'Dim = raw hits · bright = quantized · click to seek while previewing'),
          h('div', { class: 'btn-row', style: { marginTop: '14px' } }, playBtn),
          h('div', { style: { marginTop: '16px' } }, statsEl),
          h('div', { class: 'btn-row', style: { marginTop: '24px' } },
            useBtn,
            button('RECORD ANOTHER TAKE', () => { stopPreview(); cancelAnimationFrame(raf); recordSetup = true; render(); }, 'ghost'),
            button('DISCARD TAKE', () => { if (!confirm('Throw away this take?')) return; stopPreview(); cancelAnimationFrame(raf); studioState.recorded = []; studioState.chart = null; quantized = null; render(); }, 'ghost'),
          ),
        ),
        h('div', { class: 'panel' },
          h('h3', { style: { marginTop: 0 } }, 'Quantize'),
          field('Grid', gridSel),
          field('Strength', h('div', { class: 'row' }, strength, strengthV), '100% snaps fully; lower keeps some of your feel.'),
          field('Swing', h('div', { class: 'row' }, swing, swingV), 'Delays off-beats (1/8, 1/16, 1/32 grids).'),
          field('Merge double-hits within (ms)', dedupe, 'Collapses accidental double triggers on the same drum.'),
          h('h3', null, 'Use as'),
          field('Difficulty', diffSel),
          h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: deriveEasier, onChange: (e: Event) => { deriveEasier = (e.target as HTMLInputElement).checked; } }), 'Also generate the easier difficulties that have no chart yet'),
        ),
      ),
    );
    applyQuant();
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
