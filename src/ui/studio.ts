import type { App, Screen } from '@/app';
import { DIFFICULTIES, DRUM_VOICES, VOICE_LABELS, type Chart, type Difficulty, type DrumVoice, type QuantizeOptions, type SongListEntry, type SongPackage } from '@/types';
import { chartToMidi, writeMidi, performanceToChart, quantizePerformance, QUANTIZE_GRIDS, constantTempoMap, DEFAULT_PPQ, chartStats, difficultyRating, parseMidi, chartFromMidi, deriveDifficulty } from '@/midi';
import { createSongPackage, exportSongZip, slugify, getChartBlob, hardestAvailable, availableDifficulties } from '@/song';
import { Transport, ChartPlayer, Metronome } from '@/audio';
import { h, button, field, toast, clear, downloadBlob, pickFile, select, fmtTime } from './dom';
import { topbar } from './topbar';
import { studioState } from './studioState';
import { VOICE_COLORS } from '@/game/renderer';
import { applySongKit } from './game';
import { offsetPicker, type OffsetPicker } from './offsetPicker';

/** Copy into a plain ArrayBuffer so Blob typing is happy. */
function midiBytes(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

type Step = 'source' | 'details' | 'record' | 'quantize' | 'save';
const STEPS: { id: Step; label: string }[] = [
  { id: 'source', label: '1 · Audio' },
  { id: 'details', label: '2 · Tempo & offset' },
  { id: 'record', label: '3 · Record' },
  { id: 'quantize', label: '4 · Quantize' },
  { id: 'save', label: '5 · Save & share' },
];

/**
 * STUDIO: build a song folder from an audio file — set tempo/offset, record a drum performance,
 * quantize it, save as a difficulty chart, export MIDI / zip, add to the library.
 */
export function studioScreen(app: App, params?: Record<string, unknown>): Screen {
  let step: Step = (params?.step as Step) ?? (studioState.pkg ? 'details' : 'source');
  const body = h('div');
  const stepsEl = h('div', { class: 'steps' });
  let transport: Transport | null = null;
  let player: ChartPlayer | null = null;
  let metro: Metronome | null = null;
  let quant: QuantizeOptions = { grid: '1/16', strength: 1, swing: 0, dedupeWindow: 0.03 };
  let picker: OffsetPicker | null = null;
  let quantized: Chart | null = null;

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

  function renderSteps(): void {
    clear(stepsEl);
    const idx = STEPS.findIndex((s) => s.id === step);
    STEPS.forEach((s, i) => stepsEl.appendChild(h('div', { class: `step ${i === idx ? 'active' : i < idx ? 'done' : ''}`, onClick: () => { if (i < idx || (studioState.pkg && i <= idx + 1)) go(s.id); } }, s.label)));
  }

  function go(next: Step): void {
    stopPreview();
    step = next;
    render();
  }

  function render(): void {
    renderSteps();
    clear(body);
    switch (step) {
      case 'source': return renderSource();
      case 'details': return renderDetails();
      case 'record': return renderRecord();
      case 'quantize': return renderQuantize();
      case 'save': return renderSave();
    }
  }

  // ─── 1. SOURCE ───
  function renderSource(): void {
    const libList = h('div', { class: 'btn-row' });
    app.library.listAll().then((entries) => {
      if (!entries.length) libList.appendChild(h('span', { class: 'mute' }, 'Library is empty.'));
      for (const e of entries) libList.appendChild(button(`${e.meta.title}`, () => useExisting(e)));
    });
    body.append(
      h('div', { class: 'panel' },
        h('h2', { class: 'display' }, 'NEW SONG'),
        h('div', { class: 'dim' }, 'Start from an audio file: a full mix WITHOUT drums (mp3, wav, flac, aac, m4a, ogg). You will record the drum part on your pads; the game plays your samples on top.'),
        h('div', { class: 'btn-row', style: { marginTop: '16px' } }, button('CHOOSE AUDIO FILE', chooseAudio, 'primary big')),
        h('h3', null, 'Or re-chart an existing song'),
        libList,
      ),
    );
  }

  async function chooseAudio(): Promise<void> {
    const [file] = await pickFile('audio/*,.mp3,.wav,.flac,.aac,.m4a,.ogg');
    if (!file) return;
    await app.boot();
    try {
      const buf = await app.engine.decode(await file.arrayBuffer());
      const name = file.name.replace(/\.[^.]+$/, '');
      const ext = (file.name.split('.').pop() ?? 'mp3').toLowerCase();
      studioState.reset();
      studioState.audioBuffer = buf;
      studioState.pkg = createSongPackage({ meta: { title: name, artist: 'Unknown Artist', bpm: 120, offset: 0, length: buf.duration, charter: app.settings.playerName }, audio: file, audioFileName: `audio.${ext}` });
      toast(`Loaded ${file.name} (${fmtTime(buf.duration)})`, 'ok');
      go('details');
    } catch (err) {
      toast(`Could not decode audio: ${(err as Error).message}`, 'bad');
    }
  }

  async function useExisting(e: SongListEntry): Promise<void> {
    await app.boot();
    const pkg = await app.library.load(e);
    const audioBlob = pkg.files.get(pkg.meta.audio);
    if (!audioBlob) return toast('Song has no audio', 'bad');
    studioState.reset();
    studioState.audioBuffer = await app.engine.decode(await audioBlob.arrayBuffer());
    studioState.pkg = { ...pkg, files: new Map(pkg.files), source: 'folder' };
    go('details');
  }

  // ─── 2. DETAILS ───
  function renderDetails(): void {
    const pkg = studioState.pkg!;
    const meta = pkg.meta;
    const buf = studioState.audioBuffer!;
    const bpmInput = h('input', { class: 'input', type: 'number', step: 0.01, min: 20, max: 300, value: meta.bpm, onChange: (e: Event) => { meta.bpm = Number((e.target as HTMLInputElement).value) || 120; picker?.setBpm(meta.bpm); } });
    const offsetInput = h('input', { class: 'input', type: 'number', step: 0.001, value: meta.offset, onChange: (e: Event) => { meta.offset = Number((e.target as HTMLInputElement).value) || 0; picker?.setOffset(meta.offset); } });
    picker?.dispose();
    picker = offsetPicker(app, buf, meta.offset, meta.bpm, (v) => { meta.offset = v; offsetInput.value = String(v); }, (b) => { meta.bpm = b; bpmInput.value = String(b); });
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
        unsub();
        stopPreview();
        toast(`Offset set to ${meta.offset.toFixed(3)}s`, 'ok');
      });
    });
    body.append(
      h('div', { class: 'studio' },
        h('div', { class: 'panel' },
          h('h2', { class: 'display' }, 'SONG DETAILS'),
          h('div', { class: 'grid-2' },
            field('Title', h('input', { class: 'input', value: meta.title, onChange: (e: Event) => { meta.title = (e.target as HTMLInputElement).value; } })),
            field('Artist', h('input', { class: 'input', value: meta.artist, onChange: (e: Event) => { meta.artist = (e.target as HTMLInputElement).value; } })),
            field('Album', h('input', { class: 'input', value: meta.album ?? '', onChange: (e: Event) => { meta.album = (e.target as HTMLInputElement).value || undefined; } })),
            field('Accent colour', h('input', { class: 'input', type: 'color', value: meta.accent ?? '#ff2d75', onChange: (e: Event) => { meta.accent = (e.target as HTMLInputElement).value; } })),
          ),
          h('h3', null, 'Tempo'),
          h('div', { class: 'row' }, h('div', { class: 'field', style: { flex: '0 0 140px', marginBottom: 0 } }, h('label', null, 'BPM'), bpmInput), tapBtn, playBtn),
          h('div', { class: 'small mute', style: { marginTop: '6px' } }, 'Tap along to the song, or type the BPM. Then press PLAY WITH CLICK to check the click lines up.'),
          h('h3', null, 'Offset'),
          h('div', { class: 'small mute', style: { marginBottom: '8px' } }, 'Chart time 0 = beat 1 of bar 1. Place the mark where that downbeat lands in the audio, then fine-tune it on the zoomed view and play around it to check.'),
          picker.el,
          h('div', { class: 'row', style: { marginTop: '10px' } }, h('div', { class: 'field', style: { flex: '0 0 140px', marginBottom: 0 } }, h('label', null, 'Seconds before beat 1'), offsetInput), tapOffset),
          h('h3', null, 'Recording'),
          h('div', { class: 'row' },
            h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: studioState.metronome, onChange: (e: Event) => { studioState.metronome = (e.target as HTMLInputElement).checked; } }), 'Metronome while recording'),
            h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', null, 'Count-in bars'), select([1, 2, 4].map((n) => ({ value: String(n), label: `${n}` })), String(studioState.countInBars), (v) => { studioState.countInBars = Number(v); })),
          ),
          h('div', { class: 'btn-row', style: { marginTop: '24px' } }, button('NEXT: RECORD →', () => go('record'), 'primary big')),
        ),
        h('div', { class: 'panel' },
          h('h3', { style: { marginTop: 0 } }, 'Custom drum samples'),
          h('div', { class: 'small dim' }, 'Optional. Assign a sample (wav/mp3/flac/aac) per drum for this song. Missing drums use the built-in kit.'),
          samplesEditor(),
          h('h3', null, 'Audio'),
          h('div', { class: 'small mono dim' }, `${meta.audio} · ${fmtTime(buf.duration)} · ${buf.sampleRate} Hz · ${buf.numberOfChannels} ch`),
          availableDifficulties(pkg).length ? h('div', { style: { marginTop: '10px' } }, h('span', { class: 'pill ok' }, `charts: ${availableDifficulties(pkg).join(', ')}`)) : null,
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
        const custom = studioState.customSamples[voice] ?? (pkg.meta.samples?.[voice] ? { fileName: pkg.meta.samples[voice]!, blob: pkg.files.get(pkg.meta.samples[voice]!)! } : undefined);
        list.appendChild(h('div', { class: 'voice-chip', style: { '--v': VOICE_COLORS[voice] } },
          h('div', { class: 'name' }, VOICE_LABELS[voice]),
          h('div', { class: 'pads' }, custom ? custom.fileName.split('/').pop() : 'built-in'),
          h('div', { class: 'btn-row' },
            button('PICK', async () => { const [f] = await pickFile('audio/*'); if (!f) return; studioState.customSamples[voice] = { blob: f, fileName: f.name }; rerender(); }, 'icon small'),
            custom ? button('✕', () => { delete studioState.customSamples[voice]; if (pkg.meta.samples) delete pkg.meta.samples[voice]; rerender(); }, 'icon ghost small') : null,
            button('▶', async () => { await app.boot(); if (custom) { await app.kit.loadSample(voice, await custom.blob.arrayBuffer()); app.kitCustomized = true; } app.kit.trigger(voice, 1); }, 'icon ghost small'),
          ),
        ));
      }
    };
    rerender();
    return list;
  }

  // ─── 3. RECORD ───
  function renderRecord(): void {
    const pkg = studioState.pkg!;
    body.append(
      h('div', { class: 'panel', style: { maxWidth: '760px', margin: '0 auto' } },
        h('h2', { class: 'display' }, 'RECORD'),
        h('div', { class: 'hint-box' }, `You'll get a ${studioState.countInBars}-bar count-in${studioState.metronome ? ' with a metronome' : ''}, then the song plays. Every pad hit is captured with its velocity. Your hits appear on the highway and recede into the distance as you carve the chart. Press ESC to abort.`),
        h('div', { style: { marginTop: '16px' } }, h('span', { class: 'pill' }, `${pkg.meta.bpm} BPM`), ' ', h('span', { class: 'pill' }, `offset ${pkg.meta.offset}s`), ' ', h('span', { class: 'pill' }, app.input.deviceConfig ? app.input.deviceConfig.deviceName : 'keyboard only')),
        studioState.recorded.length ? h('div', { style: { marginTop: '12px' } }, h('span', { class: 'pill ok' }, `last take: ${studioState.recorded.length} hits`), ' ', button('USE LAST TAKE →', () => go('quantize'), 'small')) : null,
        h('h3', null, 'Which difficulty is this take?'),
        h('div', { class: 'diffs', style: { maxWidth: '520px' } }, ...DIFFICULTIES.map((d) => h('div', { class: `diff ${d === studioState.targetDifficulty ? 'selected' : ''}`, dataset: { d }, onClick: () => { studioState.targetDifficulty = d; render(); } }, d.toUpperCase(), h('span', { class: 'best' }, pkg.meta.charts?.[d] ? 'has chart · will replace' : 'new')))),
        h('div', { class: 'small mute', style: { marginTop: '6px' } }, 'Record the hardest part you can play and the easier difficulties can be generated from it when you save.'),
        h('div', { class: 'btn-row', style: { marginTop: '24px' } },
          button(`● START RECORDING · ${studioState.targetDifficulty.toUpperCase()}`, async () => { await app.boot(); app.navigate('game', { pkg, difficulty: studioState.targetDifficulty, mode: 'record' }); }, 'primary big'),
          button('← BACK', () => go('details'), 'ghost'),
        ),
      ),
    );
  }

  // ─── 4. QUANTIZE ───
  function renderQuantize(): void {
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
      // beat grid
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
      // raw (dim) vs quantized (bright)
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
    const strength = h('input', { class: 'input', type: 'range', min: 0, max: 1, step: 0.05, value: quant.strength, onInput: (e: Event) => { quant = { ...quant, strength: Number((e.target as HTMLInputElement).value) }; strengthV.textContent = `${Math.round(quant.strength * 100)}%`; applyQuant(); } });
    const strengthV = h('span', { class: 'mono small' }, `${Math.round(quant.strength * 100)}%`);
    const swing = h('input', { class: 'input', type: 'range', min: 0, max: 1, step: 0.05, value: quant.swing, onInput: (e: Event) => { quant = { ...quant, swing: Number((e.target as HTMLInputElement).value) }; swingV.textContent = `${Math.round(quant.swing * 100)}%`; applyQuant(); } });
    const swingV = h('span', { class: 'mono small' }, `${Math.round(quant.swing * 100)}%`);
    const dedupe = h('input', { class: 'input', type: 'number', min: 0, max: 200, step: 5, value: Math.round(quant.dedupeWindow * 1000), onChange: (e: Event) => { quant = { ...quant, dedupeWindow: Number((e.target as HTMLInputElement).value) / 1000 }; applyQuant(); } });
    let raf = 0;
    const playBtn = button('▶ PREVIEW (song + your drums)', async () => {
      if (transport) { stopPreview(); cancelAnimationFrame(raf); playBtn.textContent = '▶ PREVIEW (song + your drums)'; return; }
      await app.boot();
      await applySongKitForStudio();
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
    body.append(
      h('div', { class: 'studio' },
        h('div', { class: 'panel' },
          h('h2', { class: 'display' }, 'QUANTIZE'),
          h('div', { style: { marginBottom: '8px' } }, h('span', { class: 'pill accent' }, `${studioState.targetDifficulty.toUpperCase()} TAKE`)),
          h('div', { class: 'dim' }, `${studioState.recorded.length} raw hits captured. Snap them to the grid, preview, then save.`),
          h('div', { style: { marginTop: '14px' } }, timeline),
          h('div', { class: 'small mute', style: { marginTop: '4px' } }, 'Dim = raw hits · bright = quantized · click to seek while previewing'),
          h('div', { class: 'btn-row', style: { marginTop: '14px' } }, playBtn, button('RE-RECORD', () => go('record'), 'ghost')),
          h('div', { style: { marginTop: '16px' } }, statsEl),
          h('div', { class: 'btn-row', style: { marginTop: '24px' } }, button('NEXT: SAVE →', () => go('save'), 'primary big')),
        ),
        h('div', { class: 'panel' },
          h('h3', { style: { marginTop: 0 } }, 'Quantize options'),
          field('Grid', gridSel),
          field('Strength', h('div', { class: 'row' }, strength, strengthV), '100% snaps fully; lower keeps some of your feel.'),
          field('Swing', h('div', { class: 'row' }, swing, swingV), 'Delays off-beats (1/8, 1/16, 1/32 grids).'),
          field('Merge double-hits within (ms)', dedupe, 'Collapses accidental double triggers on the same drum.'),
        ),
      ),
    );
    applyQuant();
  }

  async function applySongKitForStudio(): Promise<void> {
    const pkg = studioState.pkg!;
    // Merge picked custom samples into a temp package view for the kit loader.
    const tmp: SongPackage = { ...pkg, files: new Map(pkg.files), meta: { ...pkg.meta, samples: { ...(pkg.meta.samples ?? {}) } } };
    for (const [voice, s] of Object.entries(studioState.customSamples) as [DrumVoice, { blob: Blob; fileName: string }][]) {
      const path = `samples/${voice}.${s.fileName.split('.').pop()}`;
      tmp.files.set(path, s.blob);
      tmp.meta.samples![voice] = path;
    }
    await applySongKit(app, tmp);
  }

  // ─── 5. SAVE ───
  function renderSave(): void {
    const pkg = studioState.pkg!;
    const chart = studioState.chart ?? quantized;
    if (!chart) { go('quantize'); return; }
    let diff: Difficulty = studioState.targetDifficulty;
    let deriveOthers = true;
    const diffSel = select(DIFFICULTIES.map((d) => ({ value: d, label: d.toUpperCase() })), diff, (v) => { diff = v as Difficulty; studioState.targetDifficulty = diff; });
    const finalize = (): SongPackage => {
      const out: SongPackage = { ...pkg, files: new Map(pkg.files), meta: { ...pkg.meta, charts: { ...pkg.meta.charts }, samples: { ...(pkg.meta.samples ?? {}) } } };
      out.meta.id = out.meta.id || slugify(`${out.meta.title}-${out.meta.artist}`);
      out.meta.length = studioState.audioBuffer!.duration;
      const midi = writeMidi(chartToMidi(chart, { trackName: `${out.meta.title} — ${diff}` }));
      out.files.set(`${diff}.mid`, new Blob([midiBytes(midi)], { type: 'audio/midi' }));
      out.meta.charts[diff] = `${diff}.mid`;
      if (deriveOthers) {
        for (const d of DIFFICULTIES) {
          if (d === diff || out.meta.charts[d]) continue;
          if (DIFFICULTIES.indexOf(d) < DIFFICULTIES.indexOf(diff)) {
            const derived = deriveDifficulty(chart, d);
            out.files.set(`${d}.mid`, new Blob([midiBytes(writeMidi(chartToMidi(derived, { trackName: `${out.meta.title} — ${d} (auto)` })))], { type: 'audio/midi' }));
            out.meta.charts[d] = `${d}.mid`;
          }
        }
      }
      for (const [voice, s] of Object.entries(studioState.customSamples) as [DrumVoice, { blob: Blob; fileName: string }][]) {
        const path = `samples/${voice}.${(s.fileName.split('.').pop() ?? 'wav').toLowerCase()}`;
        out.files.set(path, s.blob);
        out.meta.samples![voice] = path;
      }
      if (!Object.keys(out.meta.samples!).length) delete out.meta.samples;
      return out;
    };
    body.append(
      h('div', { class: 'panel', style: { maxWidth: '760px', margin: '0 auto' } },
        h('h2', { class: 'display' }, 'SAVE & SHARE'),
        h('div', { class: 'dim' }, `${chart.notes.length} notes · ${pkg.meta.title} — ${pkg.meta.artist}`),
        h('div', { class: 'grid-2', style: { marginTop: '16px' } },
          field('Save this take as difficulty', diffSel),
          h('label', { class: 'toggle', style: { alignSelf: 'end', marginBottom: '14px' } }, h('input', { type: 'checkbox', checked: deriveOthers, onChange: (e: Event) => { deriveOthers = (e.target as HTMLInputElement).checked; } }), 'Auto-generate easier difficulties (as files)'),
        ),
        h('div', { class: 'hint-box' }, 'The song folder contains song.json, the audio, one MIDI per difficulty (GM drum notes, channel 10), and any custom samples. Open the MIDI in any DAW to fine-tune, then drop it back in the folder.'),
        h('div', { class: 'btn-row', style: { marginTop: '24px' } },
          button('ADD TO LIBRARY', async () => { const out = finalize(); await app.library.import(out); studioState.pkg = out; toast(`"${out.meta.title}" added to your library`, 'ok'); }, 'primary big'),
          button('DOWNLOAD SONG ZIP', async () => { const out = finalize(); downloadBlob(await exportSongZip(out), `${out.meta.id}.zip`); }, 'big'),
          button('DOWNLOAD MIDI ONLY', () => { const midi = writeMidi(chartToMidi(chart, { trackName: pkg.meta.title })); downloadBlob(new Blob([midiBytes(midi)], { type: 'audio/midi' }), `${slugify(pkg.meta.title)}-${diff}.mid`); }),
        ),
        h('div', { class: 'btn-row', style: { marginTop: '24px' } },
          button('PLAY IT NOW', async () => { const out = finalize(); await app.library.import(out); app.navigate('game', { pkg: out, difficulty: diff, mode: 'play' }); }),
          button('OPEN IN EDITOR', async () => { const out = finalize(); await app.library.import(out); studioState.pkg = out; app.navigate('editor', { pkg: out, difficulty: diff, back: 'studio' }); }),
          button('← QUANTIZE', () => go('quantize'), 'ghost'),
          button('DONE', () => app.navigate('title'), 'ghost'),
        ),
      ),
    );
  }

  const el = h('div', { class: 'screen' }, topbar(app, 'STUDIO', button('BACK', () => app.navigate('title'), 'ghost')), h('div', { class: 'screen-body' }, h('div', { style: { maxWidth: '1200px', margin: '0 auto' } }, stepsEl, body)));
  render();
  return { el, dispose: () => { stopPreview(); picker?.dispose(); } };
}
