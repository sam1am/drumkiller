import type { App } from '@/app';
import { DIFFICULTIES, VOICE_LABELS, type Chart, type Difficulty, type DrumVoice, type QuantizeGrid, type SongPackage } from '@/types';
import { chartToMidi, writeMidi, performanceToChart, gridStepTicks, secondsToTicks, ticksToSeconds, QUANTIZE_GRIDS, chartStats, difficultyRating } from '@/midi';
import { Transport, ChartPlayer } from '@/audio';
import { h, button, toast, select, fmtTime } from './dom';
import { VOICE_COLORS, type BeatMark } from '@/game/renderer';
import { VOICE_ORDER_FOR_UI, computeBeats } from '@/game/session';
import { computeEnvelope } from '@/game/waveform';
import { loadChart } from './game';

interface EditNote {
  id: number;
  time: number; // chart seconds
  voice: DrumVoice;
  velocity: number; // 0..1
}

let ROW_H = 34; // recomputed on resize to fill the available height
const RULER_H = 26;
const LABEL_W = 156;
/** Per-row MUTE / SOLO buttons at the right edge of the label column. */
const MIX_BTN = 18;
const MIX_GAP = 4;
const MIX_X_S = LABEL_W - MIX_GAP - MIX_BTN; // solo (rightmost)
const MIX_X_M = MIX_X_S - MIX_GAP - MIX_BTN; // mute
const NOTE_W = 12;
const MIN_PPS = 20;
const MAX_PPS = 600;
/** Two notes on the same drum closer than this are the same note. */
const SAME_SPOT = 0.002;
/** Rows of vertical drag it takes to sweep a note's velocity from 0 to 1. */
const VEL_DRAG_ROWS = 2;
/** Where the playhead sits (fraction of the visible timeline) while the chart scrolls past it. */
const PLAYHEAD_FRAC = 0.25;

/** Copied notes, times relative to the earliest one. Module-level so it survives re-opening the editor. */
let clipboard: { dt: number; voice: DrumVoice; velocity: number }[] = [];

function midiBytes(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

export interface ChartEditorOptions {
  /** The studio's working copy. `flush()` writes the edited chart back into it as `<difficulty>.mid`. */
  pkg: SongPackage;
  /** Decoded song audio (the studio already has it). */
  audio: AudioBuffer;
  difficulty: Difficulty;
  /** Called on every edit so the owner can mark the song as having unsaved changes. */
  onChange: () => void;
  /** Called when the user switches which difficulty is being edited. */
  onDifficulty?: (d: Difficulty) => void;
  /** ⌘S. */
  onSave?: () => void;
  /** Extra buttons for the editor footer (export, …). */
  actions?: HTMLElement[];
}

export interface ChartEditor {
  el: HTMLElement;
  readonly difficulty: Difficulty;
  /** True while there are edits not yet written into the package. */
  readonly dirty: boolean;
  /** Current notes as a chart. */
  toChart(): Chart;
  /** Write the edited chart into the package (as `<difficulty>.mid`). Returns whether anything was written. */
  flush(): boolean;
  dispose(): void;
}

/**
 * CHART EDITOR — piano-roll for drum charts, mounted inside the studio. One row per drum voice, time
 * left→right over the song waveform and beat grid. Click to add, drag to move, marquee to select,
 * Delete to remove, undo/redo, snap grid, velocity, transport playback with the drum kit, pad input
 * while playing. Edits are written into the studio's working copy via `flush()`; the studio saves.
 */
export async function chartEditor(app: App, opts: ChartEditorOptions): Promise<ChartEditor> {
  const { pkg, audio } = opts;
  let difficulty = opts.difficulty;

  // ── data ──
  let base: Chart;
  let notes: EditNote[] = [];
  let nextId = 1;
  let derived = false;
  let dirty = false;
  const undo: EditNote[][] = [];
  const redo: EditNote[][] = [];
  const selected = new Set<number>();
  let grid: QuantizeGrid = '1/16';
  let pps = 120; // pixels per second
  let scrollT = 0; // chart seconds at left edge
  let follow = true;
  let padInput = true;
  let beats: BeatMark[] = [];
  /** Per-row mix: muted rows stay silent; while any row is soloed only soloed rows play. Session-only, not saved. */
  const muted = new Set<DrumVoice>();
  const soloed = new Set<DrumVoice>();
  let songAudio = true;
  const isSilent = (voice: DrumVoice): boolean => (soloed.size ? !soloed.has(voice) : muted.has(voice));
  const applyMix = (): void => {
    player.muteVoices.clear();
    for (const v of rows) if (isSilent(v)) player.muteVoices.add(v);
    updateMixBtn();
    draw();
  };
  const toggleMute = (voice: DrumVoice): void => {
    if (muted.has(voice)) muted.delete(voice);
    else muted.add(voice);
    applyMix();
  };
  /** Click = toggle this row in the solo set; alt-click = solo only this row (or clear if it was the only one). */
  const toggleSolo = (voice: DrumVoice, exclusive = false): void => {
    if (exclusive) {
      const only = soloed.size === 1 && soloed.has(voice);
      soloed.clear();
      if (!only) soloed.add(voice);
    } else if (soloed.has(voice)) soloed.delete(voice);
    else soloed.add(voice);
    applyMix();
  };
  const clearMix = (): void => {
    muted.clear();
    soloed.clear();
    applyMix();
  };
  const envChannels: Float32Array[] = [];
  for (let c = 0; c < audio.numberOfChannels; c++) envChannels.push(audio.getChannelData(c));
  const env = computeEnvelope(envChannels, audio.sampleRate, 200);
  const chartDuration = audio.duration - pkg.meta.offset;

  /** Bumped on every load so a slower, older load can't overwrite a newer one. */
  let loadToken = 0;
  async function loadDifficulty(d: Difficulty): Promise<void> {
    const token = ++loadToken;
    const r = await loadChart(pkg, d);
    if (token !== loadToken) return;
    base = r.chart;
    derived = r.derived;
    notes = base.notes.map((n) => ({ id: nextId++, time: n.time, voice: n.voice, velocity: n.velocity }));
    selected.clear();
    undo.length = 0;
    redo.length = 0;
    dirty = false;
    beats = computeBeats(base, chartDuration);
    difficulty = d;
    player?.setNotes(notes);
    updateStatus();
  }

  // ── transport ──
  const transport = new Transport(app.engine);
  transport.load(audio);
  const player = new ChartPlayer(app.engine, app.kit, transport);
  player.setOffset(pkg.meta.offset);
  transport.onEnded = () => {
    player.stop();
    updatePlayBtn();
  };
  const chartTime = () => transport.position - pkg.meta.offset;

  function togglePlay(): void {
    if (transport.playing) {
      transport.pause();
      player.stop();
    } else {
      transport.play(Math.max(0, transport.position));
      player.start();
      if (follow) pinPlayhead(chartTime());
    }
    updatePlayBtn();
  }
  function seekChart(t: number): void {
    transport.seek(Math.max(0, Math.min(audio.duration, t + pkg.meta.offset)));
    player.resync();
    revealPlayhead(chartTime());
    draw();
  }

  // ── helpers ──
  const snapTime = (t: number): number => {
    const step = gridStepTicks(grid, base.ppq);
    if (!step) return t;
    const tick = secondsToTicks(t, base.tempoMap, base.ppq);
    return ticksToSeconds(Math.round(tick / step) * step, base.tempoMap, base.ppq);
  };
  const gridStepSeconds = (): number => {
    const step = gridStepTicks(grid, base.ppq) || base.ppq / 4;
    const t = chartTime();
    const tick = secondsToTicks(Math.max(0, t), base.tempoMap, base.ppq);
    return ticksToSeconds(tick + step, base.tempoMap, base.ppq) - ticksToSeconds(tick, base.tempoMap, base.ppq);
  };
  const pushUndo = (): void => {
    undo.push(notes.map((n) => ({ ...n })));
    if (undo.length > 200) undo.shift();
    redo.length = 0;
    dirty = true;
    opts.onChange();
  };
  const restore = (from: EditNote[][], to: EditNote[][]): void => {
    const snap = from.pop();
    if (!snap) return;
    to.push(notes.map((n) => ({ ...n })));
    notes = snap.map((n) => ({ ...n }));
    selected.clear();
    dirty = true;
    opts.onChange();
    player.setNotes(notes);
    updateStatus();
    draw();
  };
  /** One note per drum per spot: later-added (higher id) or selected notes win over the note already there. */
  const dedupe = (): void => {
    const byVoice = new Map<DrumVoice, EditNote[]>();
    for (const n of notes) {
      const list = byVoice.get(n.voice);
      if (list) list.push(n);
      else byVoice.set(n.voice, [n]);
    }
    const drop = new Set<number>();
    for (const list of byVoice.values()) {
      list.sort((a, b) => a.time - b.time || a.id - b.id);
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1];
        const cur = list[i];
        if (Math.abs(cur.time - prev.time) >= SAME_SPOT) continue;
        // keep the selected one if only one is selected, else the newer one
        const loser = selected.has(prev.id) && !selected.has(cur.id) ? cur : prev;
        drop.add(loser.id);
        if (loser === cur) list[i] = prev; // the survivor keeps competing with the next note
      }
    }
    if (!drop.size) return;
    notes = notes.filter((n) => !drop.has(n.id));
    for (const id of drop) selected.delete(id);
  };
  const commit = (): void => {
    dedupe();
    notes.sort((a, b) => a.time - b.time);
    player.setNotes(notes);
    updateStatus();
    draw();
  };

  // ── canvas ──
  const canvas = h('canvas', { class: 'editor-canvas' });
  const ctx = canvas.getContext('2d')!;
  let W = 0;
  let H = 0;
  const rows = VOICE_ORDER_FOR_UI;
  const rowOf = (voice: DrumVoice) => rows.indexOf(voice);
  const xOf = (t: number) => LABEL_W + (t - scrollT) * pps;
  const tOf = (x: number) => scrollT + (x - LABEL_W) / pps;
  const yOf = (voice: DrumVoice) => RULER_H + rowOf(voice) * ROW_H;
  const visibleSeconds = () => (W - LABEL_W) / pps;
  /** Scroll so the playhead sits at PLAYHEAD_FRAC of the timeline. */
  const pinPlayhead = (t: number): void => {
    scrollT = t - visibleSeconds() * PLAYHEAD_FRAC;
  };
  /** Bring an off-screen playhead back into view (pinned). */
  const revealPlayhead = (t: number): void => {
    const x = xOf(t);
    if (x < LABEL_W || x > W) pinPlayhead(t);
  };
  const setFollow = (on: boolean): void => {
    follow = on;
    followBtn.textContent = `FOLLOW: ${follow ? 'ON' : 'OFF'}`;
  };

  function resize(): void {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.floor(rect.width));
    const wrapH = canvas.parentElement?.getBoundingClientRect().height ?? 0;
    ROW_H = Math.max(30, Math.min(64, Math.floor((wrapH - RULER_H) / rows.length)));
    H = RULER_H + rows.length * ROW_H;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw(): void {
    if (!base) return;
    const t = chartTime();
    // While playing with FOLLOW on, the playhead stays pinned and the chart scrolls past it.
    if (follow && transport.playing) pinPlayhead(t);
    ctx.fillStyle = '#08080c';
    ctx.fillRect(0, 0, W, H);
    const t0 = tOf(LABEL_W);
    const t1 = tOf(W);

    // row backgrounds + waveform
    rows.forEach((voice, i) => {
      const y = RULER_H + i * ROW_H;
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.045)';
      ctx.fillRect(LABEL_W, y, W - LABEL_W, ROW_H);
    });
    // waveform behind rows
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    const mid = RULER_H + (rows.length * ROW_H) / 2;
    const amp = (rows.length * ROW_H) / 2 - 4;
    for (let x = LABEL_W; x < W; x++) {
      const ta = tOf(x) + pkg.meta.offset;
      const tb = tOf(x + 1) + pkg.meta.offset;
      const b0 = Math.max(0, Math.floor(ta * env.binsPerSecond));
      const b1 = Math.min(env.max.length - 1, Math.ceil(tb * env.binsPerSecond));
      if (b1 < 0 || b0 >= env.max.length) continue;
      let lo = 0;
      let hi = 0;
      for (let b = b0; b <= b1; b++) {
        if (env.max[b] > hi) hi = env.max[b];
        if (env.min[b] < lo) lo = env.min[b];
      }
      ctx.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }

    // beat grid + ruler
    ctx.fillStyle = '#0f0f16';
    ctx.fillRect(LABEL_W, 0, W - LABEL_W, RULER_H);
    let bar = 0;
    for (const b of beats) {
      if (b.bar) bar++;
      if (b.time < t0 - 1) continue;
      if (b.time > t1) break;
      const x = xOf(b.time);
      ctx.strokeStyle = b.bar ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.1)';
      ctx.lineWidth = b.bar ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, H);
      ctx.stroke();
      if (b.bar) {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(String(bar), x + 3, 17);
      }
    }
    // sub-grid (snap) lines when zoomed in
    const step = gridStepTicks(grid, base.ppq);
    if (step && pps >= 80) {
      const tickA = Math.max(0, secondsToTicks(t0, base.tempoMap, base.ppq));
      const tickB = secondsToTicks(t1, base.tempoMap, base.ppq);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      for (let tk = Math.floor(tickA / step) * step; tk <= tickB; tk += step) {
        const x = xOf(ticksToSeconds(tk, base.tempoMap, base.ppq));
        ctx.beginPath();
        ctx.moveTo(x, RULER_H);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
    }

    // notes
    for (const n of notes) {
      if (n.time < t0 - 0.5 || n.time > t1 + 0.5) continue;
      const x = xOf(n.time);
      const y = yOf(n.voice);
      const hgt = 8 + n.velocity * (ROW_H - 12);
      const color = VOICE_COLORS[n.voice];
      const silent = isSilent(n.voice) ? 0.3 : 1;
      ctx.fillStyle = color;
      // full-height column marks the whole click target; the solid bar shows velocity
      ctx.globalAlpha = 0.18 * silent;
      ctx.fillRect(x - NOTE_W / 2, y + 2, NOTE_W, ROW_H - 4);
      ctx.globalAlpha = (0.45 + n.velocity * 0.55) * silent;
      ctx.fillRect(x - NOTE_W / 2, y + ROW_H - 2 - hgt, NOTE_W, hgt);
      ctx.globalAlpha = 1;
      if (selected.has(n.id)) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x - NOTE_W / 2 - 2, y + 2, NOTE_W + 4, ROW_H - 4);
      }
    }

    // velocity readout while dragging a note up/down
    if (drag?.kind === 'move' && drag.axis === 'velocity') {
      const hitId = drag.hitId;
      const hit = notes.find((n) => n.id === hitId);
      if (hit) {
        const x = xOf(hit.time);
        const y = yOf(hit.voice);
        const label = `${Math.round(hit.velocity * 100)}`;
        ctx.font = '700 12px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(label).width + 12;
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.fillRect(x - w / 2, y - 22, w, 18);
        ctx.strokeStyle = VOICE_COLORS[hit.voice];
        ctx.lineWidth = 1;
        ctx.strokeRect(x - w / 2 + 0.5, y - 21.5, w - 1, 17);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x, y - 13);
        ctx.textBaseline = 'alphabetic';
      }
    }

    // marquee
    if (drag?.kind === 'marquee') {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      const x0 = Math.min(drag.x0, drag.x1);
      const y0 = Math.min(drag.y0, drag.y1);
      ctx.fillRect(x0, y0, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.strokeRect(x0, y0, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    }

    // playhead
    const px = xOf(t);
    if (px >= LABEL_W && px <= W) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#fff';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // labels column (drawn last so it covers scrolled content)
    ctx.fillStyle = '#0f0f16';
    ctx.fillRect(0, 0, LABEL_W, H);
    rows.forEach((voice, i) => {
      const y = RULER_H + i * ROW_H;
      const silent = isSilent(voice);
      ctx.fillStyle = VOICE_COLORS[voice];
      ctx.globalAlpha = silent ? 0.35 : 1;
      ctx.fillRect(0, y, 4, ROW_H);
      ctx.globalAlpha = 1;
      ctx.fillStyle = silent ? 'rgba(255,255,255,0.35)' : hoverRow === i ? '#fff' : 'rgba(255,255,255,0.75)';
      ctx.font = '700 11px "Space Grotesk", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(VOICE_LABELS[voice].toUpperCase(), 12, y + ROW_H / 2, MIX_X_M - 16);
      // MUTE / SOLO buttons
      const by = y + (ROW_H - MIX_BTN) / 2;
      const drawBtn = (bx: number, label: string, on: boolean, onColor: string) => {
        ctx.fillStyle = on ? onColor : 'rgba(255,255,255,0.06)';
        ctx.fillRect(bx, by, MIX_BTN, MIX_BTN);
        ctx.strokeStyle = on ? onColor : 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, by + 0.5, MIX_BTN - 1, MIX_BTN - 1);
        ctx.fillStyle = on ? '#000' : 'rgba(255,255,255,0.55)';
        ctx.font = '700 10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, bx + MIX_BTN / 2, by + MIX_BTN / 2 + 0.5);
      };
      drawBtn(MIX_X_M, 'M', muted.has(voice), '#ff4d4d');
      drawBtn(MIX_X_S, 'S', soloed.has(voice), '#ffe600');
    });
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText(fmtTime(Math.max(0, t)), 12, 17);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(LABEL_W + 0.5, 0);
    ctx.lineTo(LABEL_W + 0.5, H);
    ctx.stroke();
  }

  // ── interaction ──
  type Drag =
    | {
        kind: 'move';
        /** The note under the pointer when the drag started. */
        hitId: number;
        startT: number;
        startY: number;
        origin: Map<number, { time: number; velocity: number }>;
        /** Locked to the dominant direction once the pointer travels far enough: sideways moves in time, up/down changes velocity. */
        axis: 'none' | 'time' | 'velocity';
      }
    | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
    | { kind: 'scrub' };
  let drag: Drag | null = null;
  let hoverRow = -1;

  /** Pixel tolerance for picking a note: at least the note width, up to half a grid step when zoomed in. */
  const hitRadius = (): number => {
    const step = gridStepTicks(grid, base.ppq) || base.ppq / 4;
    const stepPx = (ticksToSeconds(step, base.tempoMap, base.ppq) - ticksToSeconds(0, base.tempoMap, base.ppq)) * pps;
    return Math.max(NOTE_W / 2 + 4, Math.min(16, stepPx / 2));
  };
  /** Nearest note on the row under `y` within reach of `x`; the whole row height counts regardless of velocity. */
  const noteAt = (x: number, y: number): EditNote | null => {
    const voice = rowVoice(y);
    if (!voice) return null;
    const r = hitRadius();
    let best: EditNote | null = null;
    let bestD = Infinity;
    for (const n of notes) {
      if (n.voice !== voice) continue;
      const d = Math.abs(xOf(n.time) - x);
      if (d <= r && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  };
  const noteAtTime = (voice: DrumVoice, t: number): EditNote | null =>
    notes.find((n) => n.voice === voice && Math.abs(n.time - t) < SAME_SPOT) ?? null;

  const rowVoice = (y: number): DrumVoice | null => {
    const row = Math.floor((y - RULER_H) / ROW_H);
    return row >= 0 && row < rows.length ? rows[row] : null;
  };

  function onPointerDown(e: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    canvas.setPointerCapture(e.pointerId);
    if (y < RULER_H && x >= LABEL_W) {
      seekChart(snapTime(tOf(x)));
      drag = { kind: 'scrub' };
      return;
    }
    if (x < LABEL_W) {
      const v = rowVoice(y);
      if (!v) return;
      const inBtn = (bx: number) => x >= bx && x < bx + MIX_BTN && Math.abs(y - (yOf(v) + ROW_H / 2)) <= MIX_BTN / 2;
      if (inBtn(MIX_X_M)) toggleMute(v);
      else if (inBtn(MIX_X_S)) toggleSolo(v, e.altKey);
      else app.kit.trigger(v, 1); // preview the voice
      return;
    }
    const hit = noteAt(x, y);
    if (e.button === 2 || e.altKey) {
      if (hit) {
        pushUndo();
        notes = notes.filter((n) => n.id !== hit.id);
        selected.delete(hit.id);
        commit();
      }
      return;
    }
    if (hit) {
      if (e.shiftKey) {
        if (selected.has(hit.id)) selected.delete(hit.id);
        else selected.add(hit.id);
      } else if (!selected.has(hit.id)) {
        selected.clear();
        selected.add(hit.id);
      }
      drag = startMoveDrag(hit.id, x, y);
      app.kit.trigger(hit.voice, hit.velocity);
      draw();
      return;
    }
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      drag = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, additive: e.shiftKey };
      return;
    }
    // click on empty space: drop any selection and add a note there in the same tap
    const voice = rowVoice(y);
    if (!voice) return;
    const t = Math.max(0, snapTime(tOf(x)));
    const existing = noteAtTime(voice, t);
    if (existing) {
      // the snapped spot is already taken — select that note rather than stacking another on it
      selected.clear();
      selected.add(existing.id);
      app.kit.trigger(existing.voice, existing.velocity);
      draw();
      return;
    }
    pushUndo();
    const n: EditNote = { id: nextId++, time: t, voice, velocity: velocityForNew };
    notes.push(n);
    selected.clear();
    selected.add(n.id);
    app.kit.trigger(voice, n.velocity);
    commit();
    // keep holding and drag: sideways moves the new note, up/down sets its velocity
    drag = startMoveDrag(n.id, x, y);
  }

  /** Begin a drag on `hitId` with the whole selection along for the ride. Undo is pushed once the drag actually moves. */
  function startMoveDrag(hitId: number, x: number, y: number): Drag {
    const origin = new Map<number, { time: number; velocity: number }>();
    for (const n of notes) if (selected.has(n.id)) origin.set(n.id, { time: n.time, velocity: n.velocity });
    return { kind: 'move', hitId, startT: tOf(x), startY: y, origin, axis: 'none' };
  }

  function onPointerMove(e: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const row = Math.floor((y - RULER_H) / ROW_H);
    const newHover = row >= 0 && row < rows.length ? row : -1;
    if (newHover !== hoverRow) {
      hoverRow = newHover;
      if (!drag) draw();
    }
    if (!drag) return;
    if (drag.kind === 'scrub') {
      if (x >= LABEL_W) seekChart(snapTime(tOf(x)));
      return;
    }
    if (drag.kind === 'marquee') {
      drag.x1 = x;
      drag.y1 = y;
      draw();
      return;
    }
    // move / velocity
    const dt = tOf(x) - drag.startT;
    const dx = dt * pps;
    const dy = y - drag.startY;
    if (drag.axis === 'none') {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'time' : 'velocity';
      pushUndo();
    }
    if (drag.axis === 'time') {
      for (const n of notes) {
        const o = drag.origin.get(n.id);
        if (o) n.time = Math.max(0, snapTime(o.time + dt));
      }
    } else {
      // dragging up a full row height adds ~VEL_DRAG_RANGE of velocity
      const dv = -dy / (ROW_H * VEL_DRAG_ROWS);
      for (const n of notes) {
        const o = drag.origin.get(n.id);
        if (o) n.velocity = Math.max(0.05, Math.min(1, Math.round((o.velocity + dv) * 100) / 100));
      }
      const hitId = drag.hitId;
      const hit = notes.find((n) => n.id === hitId);
      if (hit) {
        velocityForNew = hit.velocity;
        velSlider.value = String(hit.velocity);
      }
    }
    player.setNotes(notes);
    updateStatus();
    draw();
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drag) return;
    if (drag.kind === 'marquee') {
      const x0 = Math.min(drag.x0, drag.x1);
      const x1 = Math.max(drag.x0, drag.x1);
      const y0 = Math.min(drag.y0, drag.y1);
      const y1 = Math.max(drag.y0, drag.y1);
      if (!drag.additive) selected.clear();
      if (x1 - x0 > 2 || y1 - y0 > 2) {
        for (const n of notes) {
          const nx = xOf(n.time);
          const ny = yOf(n.voice) + ROW_H / 2;
          if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1) selected.add(n.id);
        }
      }
    } else if (drag.kind === 'move' && drag.axis !== 'none') {
      if (drag.axis === 'velocity') {
        const hitId = drag.hitId;
        const hit = notes.find((n) => n.id === hitId);
        if (hit) app.kit.trigger(hit.voice, hit.velocity);
      }
      commit(); // dedupes notes dragged onto another note
    }
    drag = null;
    draw();
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (e.ctrlKey || e.metaKey) {
      const tAtMouse = tOf(x);
      pps = Math.max(MIN_PPS, Math.min(MAX_PPS, pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      scrollT = tAtMouse - (x - LABEL_W) / pps;
    } else {
      scrollT += (e.deltaX || e.deltaY) / pps;
    }
    scrollT = Math.max(-1, Math.min(chartDuration, scrollT));
    if (transport.playing) setFollow(false);
    draw();
  }

  function onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    const meta = e.metaKey || e.ctrlKey;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      e.preventDefault();
      deleteSelected();
    } else if (meta && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) restore(redo, undo);
      else restore(undo, redo);
    } else if (meta && e.code === 'KeyA') {
      e.preventDefault();
      notes.forEach((n) => selected.add(n.id));
      draw();
    } else if (meta && e.code === 'KeyS') {
      e.preventDefault();
      opts.onSave?.();
    } else if (meta && e.code === 'KeyD') {
      e.preventDefault();
      duplicateSelected();
    } else if (meta && e.code === 'KeyC') {
      e.preventDefault();
      copySelected();
    } else if (meta && e.code === 'KeyX') {
      e.preventDefault();
      if (copySelected()) deleteSelected();
    } else if (meta && e.code === 'KeyV') {
      e.preventDefault();
      pasteAtPlayhead();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      if (selected.size) nudge(e.code === 'ArrowLeft' ? -1 : 1, 0);
      else seekChart(chartTime() + (e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 4 : 1) * gridStepSeconds());
    } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault();
      if (selected.size) nudge(0, e.code === 'ArrowUp' ? -1 : 1);
    } else if (e.code === 'Home') {
      seekChart(0);
      scrollT = -1;
      draw();
    } else if (e.code === 'Escape') {
      selected.clear();
      draw();
    } else if (e.code === 'Equal' || e.code === 'Minus') {
      pps = Math.max(MIN_PPS, Math.min(MAX_PPS, pps * (e.code === 'Equal' ? 1.25 : 0.8)));
      draw();
    }
  }

  function nudge(dSteps: number, dRows: number): void {
    if (!selected.size) return;
    pushUndo();
    const step = gridStepTicks(grid, base.ppq) || base.ppq / 4;
    for (const n of notes) {
      if (!selected.has(n.id)) continue;
      if (dSteps) {
        const tick = secondsToTicks(n.time, base.tempoMap, base.ppq);
        n.time = Math.max(0, ticksToSeconds(Math.round(tick / step) * step + dSteps * step, base.tempoMap, base.ppq));
      }
      if (dRows) n.voice = rows[Math.max(0, Math.min(rows.length - 1, rowOf(n.voice) + dRows))];
    }
    commit();
  }
  function deleteSelected(): void {
    if (!selected.size) return;
    pushUndo();
    notes = notes.filter((n) => !selected.has(n.id));
    selected.clear();
    commit();
  }
  function duplicateSelected(): void {
    if (!selected.size) return;
    pushUndo();
    const step = gridStepSeconds();
    const copies = notes.filter((n) => selected.has(n.id)).map((n) => ({ ...n, id: nextId++, time: n.time + step * 4 }));
    notes.push(...copies);
    selected.clear();
    copies.forEach((c) => selected.add(c.id));
    commit();
  }
  /** Copy the selection to the editor clipboard (times relative to the earliest copied note). */
  function copySelected(): boolean {
    const sel = notes.filter((n) => selected.has(n.id));
    if (!sel.length) return false;
    const t0 = Math.min(...sel.map((n) => n.time));
    clipboard = sel.map((n) => ({ dt: n.time - t0, voice: n.voice, velocity: n.velocity }));
    toast(`Copied ${sel.length} note${sel.length === 1 ? '' : 's'}`, 'ok');
    return true;
  }
  /** Paste the clipboard with its first note at the (snapped) playhead; pasted notes become the selection. */
  function pasteAtPlayhead(): void {
    if (!clipboard.length) return;
    pushUndo();
    const t0 = Math.max(0, snapTime(chartTime()));
    const pasted = clipboard.map((c) => ({ id: nextId++, time: t0 + c.dt, voice: c.voice, velocity: c.velocity }));
    notes.push(...pasted);
    selected.clear();
    pasted.forEach((n) => selected.add(n.id));
    commit();
  }
  function setSelectedVelocity(v: number): void {
    if (!selected.size) return;
    pushUndo();
    for (const n of notes) if (selected.has(n.id)) n.velocity = v;
    commit();
  }

  // ── pad input: hits while playing insert notes at the playhead; while paused they preview ──
  const unsubHits = app.input.onHit((hit) => {
    if (!transport.playing) {
      app.kit.trigger(hit.voice, hit.velocity);
      return;
    }
    if (!padInput) return;
    const pos = transport.positionAtPerfTime(hit.timeStamp) - pkg.meta.offset + app.settings.inputOffset - app.engine.inputLatencyCompensation;
    const t = Math.max(0, snapTime(pos));
    if (noteAtTime(hit.voice, t)) return;
    pushUndo();
    notes.push({ id: nextId++, time: t, voice: hit.voice, velocity: hit.velocity });
    commit();
  });

  // ── write back ──
  function toChart(): Chart {
    const c = performanceToChart(
      notes.map((n) => ({ time: n.time, voice: n.voice, velocity: n.velocity })),
      base.tempoMap,
      base.ppq,
    );
    c.timeSignatures = base.timeSignatures;
    c.duration = Math.max(c.duration, chartDuration);
    return c;
  }
  /** Take `<difficulty>.mid` out of the package: the difficulty goes back to being auto-derived. */
  function removeFromPackage(d: Difficulty): void {
    const path = pkg.meta.charts[d];
    if (path) pkg.files.delete(path);
    delete pkg.meta.charts[d];
  }
  /**
   * Write the edited chart into the package as `<difficulty>.mid` (a derived chart becomes a real one).
   * An edit that leaves no notes removes the chart file instead — an empty chart is no chart.
   */
  function flush(): boolean {
    if (!dirty) return false;
    if (notes.length) {
      const midi = writeMidi(chartToMidi(toChart(), { trackName: `${pkg.meta.title} — ${difficulty}` }));
      pkg.files.set(`${difficulty}.mid`, new Blob([midiBytes(midi)], { type: 'audio/midi' }));
      pkg.meta.charts[difficulty] = `${difficulty}.mid`;
      derived = false;
    } else {
      // Emptied out: the difficulty is auto-derived again, so show what players will actually get.
      removeFromPackage(difficulty);
      derived = true;
      void loadDifficulty(difficulty).then(draw);
    }
    dirty = false;
    refreshDiffLabels();
    updateStatus();
    return true;
  }
  /** Delete this difficulty's chart file (after confirming) and reload it as auto-derived. */
  async function deleteChart(): Promise<void> {
    if (!pkg.meta.charts[difficulty]) return;
    const others = DIFFICULTIES.filter((d) => d !== difficulty && pkg.meta.charts[d]);
    const hardestOther = others.length ? others[others.length - 1] : null;
    const then = hardestOther
      ? DIFFICULTIES.indexOf(hardestOther) >= DIFFICULTIES.indexOf(difficulty)
        ? `It will be generated from the ${hardestOther} chart instead.`
        : `It will no longer be offered to players (the hardest remaining chart is ${hardestOther}).`
      : 'The song will have no chart left.';
    if (!confirm(`Delete the ${difficulty.toUpperCase()} chart? ${then} This cannot be undone once you save.`)) return;
    removeFromPackage(difficulty);
    dirty = false;
    opts.onChange();
    await loadDifficulty(difficulty);
    refreshDiffLabels();
    draw();
    toast(`${difficulty.toUpperCase()} chart deleted${hardestOther ? ` — now auto-generated from ${hardestOther}` : ''}`, 'ok');
  }

  // ── toolbar ──
  const playBtn = button('▶ PLAY', togglePlay, 'primary');
  const updatePlayBtn = () => {
    playBtn.textContent = transport.playing ? '■ STOP' : '▶ PLAY';
  };
  const status = h('span', { class: 'mono small dim' });
  const deleteChartBtn = button('DELETE CHART', () => void deleteChart(), 'danger small');
  deleteChartBtn.title = 'Remove this difficulty\'s chart file from the song (asks first)';
  const updateStatus = () => {
    const st = chartStats(toChart());
    status.textContent = `${difficulty.toUpperCase()} · ${notes.length} notes · ${st.notesPerSecond.toFixed(1)} nps · ${difficultyRating(toChart())}/10${derived ? ' · AUTO-GENERATED (edit to make it a real chart)' : ''}`;
    deleteChartBtn.hidden = !pkg.meta.charts[difficulty];
    deleteChartBtn.textContent = `DELETE ${difficulty.toUpperCase()} CHART`;
  };
  let velocityForNew = 0.9;
  const velSlider = h('input', { class: 'input', type: 'range', min: 0.05, max: 1, step: 0.01, value: velocityForNew, style: { width: '110px' }, onInput: (e: Event) => { velocityForNew = Number((e.target as HTMLInputElement).value); setSelectedVelocity(velocityForNew); } });
  const diffLabel = (d: Difficulty) => `${d.toUpperCase()}${pkg.meta.charts?.[d] ? '' : ' (auto)'}`;
  const diffSel = select(DIFFICULTIES.map((d) => ({ value: d, label: diffLabel(d) })), difficulty, async (v) => {
    flush(); // edits to the difficulty we are leaving stay in the working copy
    await loadDifficulty(v as Difficulty);
    opts.onDifficulty?.(difficulty);
    draw();
  });
  const refreshDiffLabels = () => {
    Array.from(diffSel.options).forEach((o) => { o.textContent = diffLabel(o.value as Difficulty); });
  };
  const gridSel = select(QUANTIZE_GRIDS.map((g) => ({ value: g.id, label: g.id === 'off' ? 'Snap: off' : `Snap: ${g.label}` })), grid, (v) => { grid = v as QuantizeGrid; draw(); });
  const followBtn = button('FOLLOW: ON', () => { setFollow(!follow); if (follow) { pinPlayhead(chartTime()); draw(); } }, 'icon small');
  const padBtn = button('PADS ADD NOTES: ON', () => { padInput = !padInput; padBtn.textContent = `PADS ADD NOTES: ${padInput ? 'ON' : 'OFF'}`; }, 'icon small');
  const songBtn = button('SONG: ON', () => { songAudio = !songAudio; transport.setGain(songAudio ? 1 : 0); songBtn.textContent = `SONG: ${songAudio ? 'ON' : 'OFF'}`; songBtn.classList.toggle('danger', !songAudio); }, 'icon small');
  songBtn.title = 'Mute / unmute the song audio (hear the drums on their own)';
  const mixBtn = button('CLEAR M/S', clearMix, 'icon small');
  mixBtn.title = 'Clear every row MUTE / SOLO';
  const updateMixBtn = () => { mixBtn.hidden = !muted.size && !soloed.size; };
  updateMixBtn();

  const toolbar = h('div', { class: 'editor-toolbar' },
    playBtn,
    button('⏮', () => { seekChart(0); scrollT = -1; draw(); }, 'icon'),
    diffSel,
    gridSel,
    h('span', { class: 'small dim' }, 'Velocity'), velSlider,
    button('UNDO', () => restore(undo, redo), 'icon small'),
    button('REDO', () => restore(redo, undo), 'icon small'),
    button('DELETE', deleteSelected, 'icon small'),
    button('DUPLICATE', duplicateSelected, 'icon small'),
    button('COPY', copySelected, 'icon small'),
    button('PASTE', pasteAtPlayhead, 'icon small'),
    button('−', () => { pps = Math.max(MIN_PPS, pps * 0.8); draw(); }, 'icon small'),
    button('+', () => { pps = Math.min(MAX_PPS, pps * 1.25); draw(); }, 'icon small'),
    followBtn,
    padBtn,
    songBtn,
    mixBtn,
  );
  const footer = h('div', { class: 'editor-footer' }, status, h('span', { class: 'spacer' }), deleteChartBtn, ...(opts.actions ?? []));
  const help = h('div', { class: 'small mute editor-help' },
    'Click empty space = add note (drops the old selection) · drag a note sideways = move, up/down = velocity · shift/⌘-drag = marquee select · shift-click = add to selection · right-click or alt-click = delete · ',
    h('kbd', null, 'Space'), ' play · ', h('kbd', null, '⌫'), ' delete · ', h('kbd', null, '⌘Z'), ' undo · ', h('kbd', null, '⇧⌘Z'), ' redo · ', h('kbd', null, '⌘A'), ' all · ', h('kbd', null, '⌘D'), ' duplicate a bar later · ', h('kbd', null, '⌘C'), '/', h('kbd', null, '⌘X'), ' copy/cut · ', h('kbd', null, '⌘V'), ' paste at playhead · ', h('kbd', null, '←→'), ' nudge / seek · ', h('kbd', null, '↑↓'), ' change drum · ', h('kbd', null, '⌘+wheel'), ' zoom · wheel scroll · ruler click = seek · pads preview when stopped, insert while playing · M / S on a row = mute / solo that drum (alt-click S = solo only it) · SONG = mute the song audio',
  );

  const wrap = h('div', { class: 'editor-wrap' }, canvas);
  const el = h('div', { class: 'chart-editor' }, toolbar, wrap, footer, help);

  await loadDifficulty(difficulty);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', resize);
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  let raf = 0;
  const tick = () => {
    if (transport.playing) draw();
    raf = requestAnimationFrame(tick);
  };
  tick();
  app.input.keyboard.setEnabled(false); // editor owns the keyboard
  (window as unknown as { dkEditor: unknown }).dkEditor = { get notes() { return notes; }, get difficulty() { return difficulty; }, get selected() { return selected; }, toChart, flush, transport, copySelected, pasteAtPlayhead, get clipboard() { return clipboard; }, get dirty() { return dirty; }, get rowH() { return ROW_H; }, get pps() { return pps; }, get scrollT() { return scrollT; }, get follow() { return follow; }, get muted() { return muted; }, get soloed() { return soloed; }, deleteChart, get derived() { return derived; }, get muteVoices() { return player.muteVoices; }, toggleMute, toggleSolo, clearMix, get songAudio() { return songAudio; } };

  return {
    el,
    get difficulty() { return difficulty; },
    get dirty() { return dirty; },
    toChart,
    flush,
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      transport.stop();
      player.stop();
      unsubHits();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', resize);
      app.input.keyboard.setEnabled(true);
      if ((window as unknown as { dkEditor: unknown }).dkEditor) delete (window as unknown as { dkEditor?: unknown }).dkEditor;
    },
  };
}
