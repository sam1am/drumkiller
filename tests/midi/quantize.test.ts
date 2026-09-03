import { describe, expect, it } from 'vitest';
import type { PerformanceNote, QuantizeOptions } from '@/types';
import { buildTempoMap, constantTempoMap, secondsToTicks, ticksToSeconds } from '@/midi/chart';
import { QUANTIZE_GRIDS, gridStepTicks, quantizePerformance } from '@/midi/quantize';

const ppq = 480;
const map120 = constantTempoMap(120); // 1 tick = 0.5/480 s
const tickSec = (tick: number) => ticksToSeconds(tick, map120, ppq);

const base: QuantizeOptions = { grid: '1/16', strength: 1, swing: 0, dedupeWindow: 0 };

describe('gridStepTicks / QUANTIZE_GRIDS', () => {
  it('maps every grid to the expected step', () => {
    expect(gridStepTicks('off', ppq)).toBe(0);
    expect(gridStepTicks('1/4', ppq)).toBe(480);
    expect(gridStepTicks('1/8', ppq)).toBe(240);
    expect(gridStepTicks('1/16', ppq)).toBe(120);
    expect(gridStepTicks('1/32', ppq)).toBe(60);
    expect(gridStepTicks('1/8T', ppq)).toBe(160);
    expect(gridStepTicks('1/16T', ppq)).toBe(80);
    expect(gridStepTicks('1/12', ppq)).toBe(160);
    expect(gridStepTicks('1/24', ppq)).toBe(80);
  });

  it('lists every grid once with a label', () => {
    const ids = QUANTIZE_GRIDS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['off', '1/4', '1/8', '1/16', '1/32', '1/8T', '1/16T', '1/12', '1/24']);
    expect(QUANTIZE_GRIDS.every((g) => g.label.length > 0)).toBe(true);
  });
});

describe('quantizePerformance', () => {
  it("'off' returns a sorted copy without touching times", () => {
    const notes: PerformanceNote[] = [
      { time: 0.7, voice: 'snare', velocity: 1 },
      { time: 0.1, voice: 'kick', velocity: 1 },
    ];
    const out = quantizePerformance(notes, map120, ppq, { ...base, grid: 'off' });
    expect(out.map((n) => n.time)).toEqual([0.1, 0.7]);
    expect(out[0]).not.toBe(notes[1]);
    expect(notes[0].time).toBe(0.7); // input untouched
  });

  it('snaps fully at strength 1 and halfway at strength 0.5', () => {
    const notes: PerformanceNote[] = [
      { time: tickSec(130), voice: 'kick', velocity: 1 }, // nearest 16th = 120
      { time: tickSec(175), voice: 'snare', velocity: 1 }, // nearest 16th = 120 (175-120=55 < 65)
      { time: tickSec(185), voice: 'hihatClosed', velocity: 1 }, // nearest = 240
    ];
    const full = quantizePerformance(notes, map120, ppq, base);
    const ticks = full.map((n) => secondsToTicks(n.time, map120, ppq));
    expect(ticks[0]).toBeCloseTo(120, 9);
    expect(ticks[1]).toBeCloseTo(120, 9);
    expect(ticks[2]).toBeCloseTo(240, 9);

    const half = quantizePerformance(notes, map120, ppq, { ...base, strength: 0.5 });
    const halfTicks = half.map((n) => secondsToTicks(n.time, map120, ppq));
    expect(halfTicks[0]).toBeCloseTo(125, 9);
    expect(halfTicks[1]).toBeCloseTo(147.5, 9);
    expect(halfTicks[2]).toBeCloseTo(212.5, 9);

    const none = quantizePerformance(notes, map120, ppq, { ...base, strength: 0 });
    expect(none.map((n) => n.time)).toEqual(notes.map((n) => n.time));
  });

  it('snaps to triplet grids', () => {
    const notes: PerformanceNote[] = [
      { time: tickSec(150), voice: 'kick', velocity: 1 }, // 1/8T step 160 → 160
      { time: tickSec(330), voice: 'kick', velocity: 1 }, // → 320
      { time: tickSec(75), voice: 'snare', velocity: 1 }, // 1/16T step 80 → 80
    ];
    const t8 = quantizePerformance(notes.slice(0, 2), map120, ppq, { ...base, grid: '1/8T' });
    expect(t8.map((n) => secondsToTicks(n.time, map120, ppq))).toEqual([160, 320].map((v) => expect.closeTo(v, 9)));
    const t16 = quantizePerformance([notes[2]], map120, ppq, { ...base, grid: '1/16T' });
    expect(secondsToTicks(t16[0].time, map120, ppq)).toBeCloseTo(80, 9);
  });

  it('applies swing to odd grid points on straight grids only', () => {
    // 1/8 grid, step 240, swing 1 → odd points delayed by 80 ticks (triplet feel).
    const notes: PerformanceNote[] = [
      { time: tickSec(250), voice: 'hihatClosed', velocity: 1 }, // near swung point 320
      { time: tickSec(0), voice: 'kick', velocity: 1 }, // even point: unchanged
      { time: tickSec(470), voice: 'snare', velocity: 1 }, // near 480 (even)
    ];
    const swung = quantizePerformance(notes, map120, ppq, { ...base, grid: '1/8', swing: 1 });
    const ticks = swung.map((n) => secondsToTicks(n.time, map120, ppq));
    expect(ticks[0]).toBeCloseTo(0, 9);
    expect(ticks[1]).toBeCloseTo(320, 9);
    expect(ticks[2]).toBeCloseTo(480, 9);

    const half = quantizePerformance([notes[0]], map120, ppq, { ...base, grid: '1/8', swing: 0.5 });
    expect(secondsToTicks(half[0].time, map120, ppq)).toBeCloseTo(280, 9);

    // Triplet grids ignore swing.
    const trip = quantizePerformance([{ time: tickSec(165), voice: 'kick', velocity: 1 }], map120, ppq, {
      ...base,
      grid: '1/8T',
      swing: 1,
    });
    expect(secondsToTicks(trip[0].time, map120, ppq)).toBeCloseTo(160, 9);
    // 1/4 grid ignores swing.
    const quarter = quantizePerformance([{ time: tickSec(500), voice: 'kick', velocity: 1 }], map120, ppq, {
      ...base,
      grid: '1/4',
      swing: 1,
    });
    expect(secondsToTicks(quarter[0].time, map120, ppq)).toBeCloseTo(480, 9);
  });

  it('respects tempo changes (works in tick domain)', () => {
    const map = buildTempoMap(
      [
        { tick: 0, bpm: 120 },
        { tick: 960, bpm: 60 },
      ],
      ppq,
      120,
    );
    // Tick 1200 is at 1 s + 240 ticks @ 60 bpm (1 s / 480 ticks) = 1.5 s. A note at 1.52 s (≈ tick 1209.6)
    // snaps to tick 1200 on a 1/8 grid = 1.5 s, not to a 120-bpm-derived grid.
    const out = quantizePerformance([{ time: 1.52, voice: 'kick', velocity: 1 }], map, ppq, { ...base, grid: '1/8' });
    expect(out[0].time).toBeCloseTo(1.5, 9);
  });

  it('dedupes same-voice notes within the window keeping the louder velocity', () => {
    const notes: PerformanceNote[] = [
      { time: tickSec(118), voice: 'snare', velocity: 0.4 },
      { time: tickSec(123), voice: 'snare', velocity: 0.9 }, // both → tick 120
      { time: tickSec(121), voice: 'kick', velocity: 0.7 }, // different voice: kept
      { time: tickSec(365), voice: 'snare', velocity: 0.5 }, // → 360, far enough away
    ];
    const out = quantizePerformance(notes, map120, ppq, { ...base, dedupeWindow: 0.03 });
    expect(out.map((n) => [Math.round(secondsToTicks(n.time, map120, ppq)), n.voice, n.velocity])).toEqual([
      [120, 'kick', 0.7],
      [120, 'snare', 0.9],
      [360, 'snare', 0.5],
    ]);

    const noDedupe = quantizePerformance(notes, map120, ppq, base);
    expect(noDedupe).toHaveLength(4);
  });
});
