import { describe, expect, it } from 'vitest';
import { heatColor, heatmapColumns, laneTiming, timingDensity, timingSummary, type TimingHit } from '@/game/timingHeatmap';
import { LANE_ORDER } from '@/types';

const hit = (voice: TimingHit['voice'], delta: number): TimingHit => ({ voice, delta, judgement: 'great' });

describe('timing heatmap data', () => {
  it('columns are the lane order plus crash last', () => {
    expect(heatmapColumns(LANE_ORDER)).toEqual(['hihat', 'snare', 'kick', 'toms', 'ride', 'crash']);
    expect(heatmapColumns(['kick', 'snare', 'hihat', 'toms', 'ride'])).toEqual(['kick', 'snare', 'hihat', 'toms', 'ride', 'crash']);
  });

  it('summarises mean, spread and the early/late split', () => {
    const s = timingSummary([hit('kick', -0.02), hit('kick', 0.02), hit('snare', 0.04), hit('snare', 0)]);
    expect(s.count).toBe(4);
    expect(s.mean).toBeCloseTo(0.01);
    expect(s.early).toBe(1);
    expect(s.late).toBe(2);
    expect(s.spread).toBeCloseTo(Math.sqrt((0.03 ** 2 + 0.01 ** 2 + 0.03 ** 2 + 0.01 ** 2) / 4));
    expect(timingSummary([])).toEqual({ count: 0, mean: 0, spread: 0, early: 0, late: 0 });
  });

  it('per-lane stats follow the voice → lane mapping', () => {
    const cols = heatmapColumns(LANE_ORDER);
    const st = laneTiming([hit('tomHigh', 0.01), hit('tomLow', 0.03), hit('hihatOpen', -0.05), hit('crash', 0)], cols);
    const by = Object.fromEntries(st.map((s) => [s.lane, s]));
    expect(by.toms.count).toBe(2);
    expect(by.toms.mean).toBeCloseTo(0.02);
    expect(by.hihat).toMatchObject({ count: 1, early: 1, late: 0 });
    expect(by.crash).toMatchObject({ count: 1, early: 0, late: 0 });
    expect(by.kick.count).toBe(0);
  });

  it('density puts early hits at the top, late at the bottom, and piles coincident hits', () => {
    const cols = heatmapColumns(LANE_ORDER);
    const rows = 101;
    const d = timingDensity([hit('kick', -0.1), hit('snare', 0.05), hit('snare', 0.05)], cols, 0.1, rows, 1);
    const kick = cols.indexOf('kick');
    const snare = cols.indexOf('snare');
    const at = (r: number, c: number) => d.grid[r * d.cols + c];
    expect(at(0, kick)).toBeCloseTo(1); // -range → top row
    expect(at(rows - 1, kick)).toBe(0);
    expect(at(75, snare)).toBeCloseTo(2); // +half range → three quarters down, two hits stacked
    expect(d.max).toBeCloseTo(2);
    // out-of-range hits clamp to the edge instead of vanishing
    const e = timingDensity([hit('ride', 5)], cols, 0.1, rows, 1);
    expect(at.call(null, 0, 0)).toBe(0);
    expect(e.grid[(rows - 1) * e.cols + cols.indexOf('ride')]).toBeCloseTo(1);
  });

  it('heat colour ramps from transparent violet to white', () => {
    expect(heatColor(0)[3]).toBe(0);
    expect(heatColor(0.1)[3]).toBeGreaterThan(0);
    expect(heatColor(1)).toEqual([255, 255, 255, 255]);
    const mid = heatColor(0.45);
    expect(mid.slice(0, 3)).toEqual([0xff, 0x2d, 0x75]);
  });
});
