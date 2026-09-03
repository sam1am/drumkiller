/**
 * Performance quantisation.
 *
 * Works in the tick domain (via the tempo map) so tempo changes are respected,
 * supports partial strength, swing on straight grids and a per-voice dedupe
 * window for double triggers.
 */

import type { DrumVoice, PerformanceNote, QuantizeGrid, QuantizeOptions, TempoEvent } from '@/types';
import { secondsToTicks, ticksToSeconds } from './chart';

/** Grid choices for the UI, in display order. */
export const QUANTIZE_GRIDS: { id: QuantizeGrid; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: '1/4', label: '1/4 note' },
  { id: '1/8', label: '1/8 note' },
  { id: '1/16', label: '1/16 note' },
  { id: '1/32', label: '1/32 note' },
  { id: '1/8T', label: '1/8 triplet' },
  { id: '1/16T', label: '1/16 triplet' },
  { id: '1/12', label: '1/12 (8th-triplet grid)' },
  { id: '1/24', label: '1/24 (16th-triplet grid)' },
];

/** Grids that receive swing (every second grid point is delayed). */
const SWING_GRIDS: ReadonlySet<QuantizeGrid> = new Set<QuantizeGrid>(['1/8', '1/16', '1/32']);

/**
 * Grid step in ticks for a grid id. Returns `0` for `'off'`.
 *
 * 1/4 → ppq, 1/8 → ppq/2, 1/16 → ppq/4, 1/32 → ppq/8,
 * 1/8T → ppq/3, 1/16T → ppq/6, 1/12 → ppq/3, 1/24 → ppq/6.
 */
export function gridStepTicks(grid: QuantizeGrid, ppq: number): number {
  switch (grid) {
    case 'off':
      return 0;
    case '1/4':
      return ppq;
    case '1/8':
      return ppq / 2;
    case '1/16':
      return ppq / 4;
    case '1/32':
      return ppq / 8;
    case '1/8T':
    case '1/12':
      return ppq / 3;
    case '1/16T':
    case '1/24':
      return ppq / 6;
    default:
      return 0;
  }
}

/** Clamp to 0..1, treating NaN as 0. */
function unit(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Nearest point of a (possibly swung) grid to `tick`.
 *
 * Grid point k sits at `k * step`, plus `swingTicks` when k is odd.
 * Candidates around `floor(tick / step)` are examined; the closest wins
 * (earlier point on exact ties). Works for negative ticks too.
 */
export function nearestGridTick(tick: number, step: number, swingTicks = 0): number {
  const k0 = Math.floor(tick / step);
  let best = k0 * step;
  let bestDist = Infinity;
  for (let k = k0 - 1; k <= k0 + 2; k++) {
    const odd = ((k % 2) + 2) % 2 === 1;
    const g = k * step + (odd ? swingTicks : 0);
    const d = Math.abs(g - tick);
    if (d < bestDist) {
      bestDist = d;
      best = g;
    }
  }
  return best;
}

/** Sort by time, then voice name, for deterministic output. */
function sortNotes(notes: PerformanceNote[]): PerformanceNote[] {
  return notes.sort((a, b) => a.time - b.time || (a.voice < b.voice ? -1 : a.voice > b.voice ? 1 : 0));
}

/**
 * Collapse notes of the same voice closer than `window` seconds into one,
 * keeping the earlier time and the louder velocity. Input must be sorted by time.
 */
export function dedupeNotes(sorted: PerformanceNote[], window: number): PerformanceNote[] {
  if (!(window > 0)) return sorted;
  const last = new Map<DrumVoice, PerformanceNote>();
  const out: PerformanceNote[] = [];
  for (const n of sorted) {
    const prev = last.get(n.voice);
    if (prev && n.time - prev.time < window) {
      prev.velocity = Math.max(prev.velocity, n.velocity);
      continue;
    }
    const copy = { ...n };
    out.push(copy);
    last.set(n.voice, copy);
  }
  return out;
}

/**
 * Quantise a performance to a grid.
 *
 * Algorithm per note:
 *  1. seconds → ticks via the tempo map
 *  2. find the nearest grid point (odd grid points delayed by `swing * step / 3`
 *     on straight grids 1/8, 1/16, 1/32 — swing = 1 gives a triplet feel)
 *  3. `newTick = tick + (nearest - tick) * strength`
 *  4. ticks → seconds
 *
 * Afterwards notes are sorted and, when `dedupeWindow > 0`, same-voice notes
 * within the window collapse into one (louder velocity wins).
 *
 * `grid: 'off'` skips steps 1–4 and returns a sorted copy (dedupe still applies).
 *
 * @param notes    Recorded hits (seconds).
 * @param tempoMap Tempo map of the song.
 * @param ppq      Pulses per quarter note.
 * @param opts     Grid, strength, swing and dedupe window.
 * @returns New note objects; the input is not mutated.
 */
export function quantizePerformance(
  notes: PerformanceNote[],
  tempoMap: TempoEvent[],
  ppq: number,
  opts: QuantizeOptions,
): PerformanceNote[] {
  const step = gridStepTicks(opts.grid, ppq);
  const copies = notes.map((n) => ({ ...n }));
  if (opts.grid === 'off' || !(step > 0)) {
    return dedupeNotes(sortNotes(copies), opts.dedupeWindow);
  }

  const strength = unit(opts.strength);
  const swingTicks = SWING_GRIDS.has(opts.grid) ? (unit(opts.swing) * step) / 3 : 0;

  for (const n of copies) {
    const tick = secondsToTicks(n.time, tempoMap, ppq);
    const nearest = nearestGridTick(tick, step, swingTicks);
    const newTick = tick + (nearest - tick) * strength;
    n.time = ticksToSeconds(newTick, tempoMap, ppq);
  }

  return dedupeNotes(sortNotes(copies), opts.dedupeWindow);
}
