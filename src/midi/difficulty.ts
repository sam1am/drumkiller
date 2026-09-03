/**
 * Rule-based difficulty derivation and chart statistics.
 *
 * `deriveDifficulty` turns a hard chart (usually expert) into musically sensible
 * easier charts by *filtering only* — no note is ever added or moved, so
 * expert ⊇ hard ⊇ medium ⊇ easy always holds.
 *
 * Beat positions are judged from ticks with a small tolerance
 * (≈ 1/32 of a quarter note) so lightly humanised charts still classify.
 */

import type { Chart, ChartNote, Difficulty, DrumVoice, TimeSignatureEvent } from '@/types';
import { DRUM_VOICES } from '@/types';
import { normaliseTimeSignatures, sortChartNotes } from './chart';

// ─────────────────────────── Helpers ───────────────────────────

const HAT_OR_RIDE: ReadonlySet<DrumVoice> = new Set<DrumVoice>(['hihatClosed', 'hihatOpen', 'ride']);
const TOMS: ReadonlySet<DrumVoice> = new Set<DrumVoice>(['tomHigh', 'tomMid', 'tomLow']);

/** Priority (lower = more important) used when only one note may survive on a tick / beat. */
const PRIORITY: Record<DrumVoice, number> = {
  crash: 0,
  snare: 1,
  tomHigh: 2,
  tomMid: 3,
  tomLow: 4,
  hihatOpen: 5,
  ride: 6,
  hihatClosed: 7,
  kick: 8,
};

/** Tick tolerance for "is on the grid" checks. */
function gridTolerance(ppq: number): number {
  return Math.max(1, Math.floor(ppq / 32));
}

/** True when `tick` is within `tol` of a multiple of `step`. */
export function isOnGrid(tick: number, step: number, tol: number): boolean {
  if (!(step > 0)) return true;
  const r = ((tick % step) + step) % step;
  return r <= tol || step - r <= tol;
}

/**
 * Priority used by the EASY per-beat rule: toms that survive into easy are, by
 * construction, fill endings and must beat the snare on the same beat.
 */
const EASY_PRIORITY: Record<DrumVoice, number> = {
  crash: 0,
  tomHigh: 1,
  tomMid: 2,
  tomLow: 3,
  snare: 4,
  hihatOpen: 5,
  ride: 6,
  hihatClosed: 7,
  kick: 8,
};

/** Pick the most important note (priority, then velocity, then earliest). */
function pickBest(notes: ChartNote[], priority: Record<DrumVoice, number> = PRIORITY): ChartNote {
  let best = notes[0];
  for (let i = 1; i < notes.length; i++) {
    const n = notes[i];
    const pb = priority[best.voice];
    const pn = priority[n.voice];
    if (pn < pb || (pn === pb && (n.velocity > best.velocity || (n.velocity === best.velocity && n.tick < best.tick)))) {
      best = n;
    }
  }
  return best;
}

/** Group notes by exact tick, preserving input order. */
function groupByTick(notes: ChartNote[]): ChartNote[][] {
  const groups = new Map<number, ChartNote[]>();
  for (const n of notes) {
    const g = groups.get(n.tick);
    if (g) g.push(n);
    else groups.set(n.tick, [n]);
  }
  return [...groups.values()];
}

/**
 * Bar index for a tick given the time-signature list.
 * Bars are counted from tick 0 through each time-signature segment.
 */
export function barIndexAt(tick: number, timeSignatures: TimeSignatureEvent[], ppq: number): number {
  const sigs = normaliseTimeSignatures(timeSignatures);
  let bars = 0;
  for (let i = 0; i < sigs.length; i++) {
    const sig = sigs[i];
    const barLen = (ppq * 4 * sig.numerator) / sig.denominator;
    const segEnd = i + 1 < sigs.length ? sigs[i + 1].tick : Infinity;
    if (tick < segEnd) {
      return bars + Math.floor(Math.max(0, tick - sig.tick) / barLen);
    }
    bars += Math.ceil((segEnd - sig.tick) / barLen);
  }
  return bars;
}

/** Deep-copy a chart (notes, tempo map and time signatures are all cloned). */
export function cloneChart(chart: Chart): Chart {
  return {
    ppq: chart.ppq,
    tempoMap: chart.tempoMap.map((t) => ({ ...t })),
    timeSignatures: chart.timeSignatures.map((s) => ({ ...s })),
    notes: chart.notes.map((n) => ({ ...n })),
    duration: chart.duration,
  };
}

// ─────────────────────────── Rules ───────────────────────────

/**
 * HARD: drop ghost notes (< 0.3), thin hats/ride to 8ths, keep all kick/snare/crash,
 * and allow at most kick + crash + ONE other note per tick (so toms never double up).
 */
function toHard(notes: ChartNote[], ppq: number): ChartNote[] {
  const tol = gridTolerance(ppq);
  const eighth = ppq / 2;
  const kept = notes.filter((n) => n.velocity >= 0.3 && (!HAT_OR_RIDE.has(n.voice) || isOnGrid(n.tick, eighth, tol)));

  const out: ChartNote[] = [];
  for (const group of groupByTick(kept)) {
    const others: ChartNote[] = [];
    for (const n of group) {
      if (n.voice === 'kick' || n.voice === 'crash') out.push(n);
      else others.push(n);
    }
    if (others.length) out.push(pickBest(others));
  }
  return sortChartNotes(out);
}

/**
 * MEDIUM (from hard): hats/ride only on quarters; kick, snare and toms only on 8ths;
 * at most 4 toms per bar (the last four — fills lead into the downbeat);
 * when a crash is present on a tick only kick may accompany it.
 */
function toMedium(notes: ChartNote[], ppq: number, timeSignatures: TimeSignatureEvent[]): ChartNote[] {
  const tol = gridTolerance(ppq);
  const eighth = ppq / 2;
  let kept = notes.filter((n) => {
    if (HAT_OR_RIDE.has(n.voice)) return isOnGrid(n.tick, ppq, tol);
    if (n.voice === 'crash') return true;
    return isOnGrid(n.tick, eighth, tol); // kick, snare, toms
  });

  // At most 4 toms per bar: keep the last four.
  const tomsPerBar = new Map<number, ChartNote[]>();
  for (const n of kept) {
    if (!TOMS.has(n.voice)) continue;
    const bar = barIndexAt(n.tick, timeSignatures, ppq);
    const list = tomsPerBar.get(bar);
    if (list) list.push(n);
    else tomsPerBar.set(bar, [n]);
  }
  const dropTom = new Set<ChartNote>();
  for (const list of tomsPerBar.values()) {
    for (let i = 0; i < list.length - 4; i++) dropTom.add(list[i]);
  }
  kept = kept.filter((n) => !dropTom.has(n));

  const out: ChartNote[] = [];
  for (const group of groupByTick(kept)) {
    const hasCrash = group.some((n) => n.voice === 'crash');
    if (hasCrash) {
      for (const n of group) if (n.voice === 'crash' || n.voice === 'kick') out.push(n);
    } else {
      out.push(...group);
    }
  }
  return sortChartNotes(out);
}

/**
 * EASY (from medium): kick and snare only on quarters; hats/ride only on beats 1 & 3
 * (tick % 2·ppq); toms only when a crash follows within one beat (end of a fill);
 * crash always kept; never more than one non-kick note per beat (crash > fill tom > snare > hats).
 */
function toEasy(notes: ChartNote[], ppq: number): ChartNote[] {
  const tol = gridTolerance(ppq);
  const crashTicks = notes.filter((n) => n.voice === 'crash').map((n) => n.tick);

  const kept = notes.filter((n) => {
    switch (n.voice) {
      case 'kick':
      case 'snare':
        return isOnGrid(n.tick, ppq, tol);
      case 'hihatClosed':
      case 'hihatOpen':
      case 'ride':
        return isOnGrid(n.tick, 2 * ppq, tol);
      case 'crash':
        return true;
      default: // toms
        return crashTicks.some((c) => c > n.tick && c - n.tick <= ppq + tol);
    }
  });

  // One non-kick note per beat.
  const perBeat = new Map<number, ChartNote[]>();
  const out: ChartNote[] = [];
  for (const n of kept) {
    if (n.voice === 'kick') {
      out.push(n);
      continue;
    }
    const beat = Math.floor((n.tick + tol) / ppq);
    const list = perBeat.get(beat);
    if (list) list.push(n);
    else perBeat.set(beat, [n]);
  }
  for (const list of perBeat.values()) out.push(pickBest(list, EASY_PRIORITY));
  return sortChartNotes(out);
}

// ─────────────────────────── Public API ───────────────────────────

/**
 * Derive a chart of the requested difficulty from a harder source chart.
 *
 * Rules are cumulative (easy is derived from medium, medium from hard) and only
 * ever remove notes, so note counts decrease monotonically and every derived
 * note exists in the source. `ppq`, tempo map, time signatures and duration are
 * preserved. `expert` returns a deep copy of the source.
 */
export function deriveDifficulty(source: Chart, target: Difficulty): Chart {
  const chart = cloneChart(source);
  if (target === 'expert') return chart;

  const ppq = chart.ppq > 0 ? chart.ppq : 480;
  let notes = toHard(chart.notes, ppq);
  if (target === 'medium' || target === 'easy') notes = toMedium(notes, ppq, chart.timeSignatures);
  if (target === 'easy') notes = toEasy(notes, ppq);
  chart.notes = notes;
  return chart;
}

/** Aggregate statistics about a chart. */
export interface ChartStats {
  /** Total note count. */
  notes: number;
  /** Notes per voice. */
  perVoice: Record<DrumVoice, number>;
  /** Average notes per second over `duration`. */
  notesPerSecond: number;
  /** Maximum notes in any 1-second window. */
  peakNps: number;
}

/**
 * Compute note counts, per-voice counts, average and peak (1-second sliding
 * window) notes per second.
 */
export function chartStats(chart: Chart): ChartStats {
  const perVoice = {} as Record<DrumVoice, number>;
  for (const v of DRUM_VOICES) perVoice[v] = 0;
  for (const n of chart.notes) perVoice[n.voice]++;

  const times = chart.notes.map((n) => n.time).sort((a, b) => a - b);
  let peak = 0;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    while (j < times.length && times[j] < times[i] + 1) j++;
    peak = Math.max(peak, j - i);
  }

  const duration = chart.duration > 0 ? chart.duration : times.length ? Math.max(1, times[times.length - 1]) : 1;
  return {
    notes: chart.notes.length,
    perVoice,
    notesPerSecond: chart.notes.length / duration,
    peakNps: peak,
  };
}

/**
 * Rough 1–10 difficulty rating from density (average and peak notes per
 * second), the share of simultaneous hits and voice variety.
 */
export function difficultyRating(chart: Chart): number {
  if (chart.notes.length === 0) return 1;
  const stats = chartStats(chart);

  const ticks = new Map<number, number>();
  for (const n of chart.notes) ticks.set(n.tick, (ticks.get(n.tick) ?? 0) + 1);
  let chords = 0;
  for (const c of ticks.values()) if (c > 1) chords++;
  const chordRatio = chords / ticks.size;
  const variety = DRUM_VOICES.filter((v) => stats.perVoice[v] > 0).length / DRUM_VOICES.length;

  const raw = 1 + stats.notesPerSecond * 0.75 + stats.peakNps * 0.2 + chordRatio * 1.5 + variety * 0.5;
  return Math.min(10, Math.max(1, Math.round(raw)));
}
