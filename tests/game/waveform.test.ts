import { describe, expect, it } from 'vitest';
import { computeEnvelope } from '@/game/waveform';
import { mergeLaneOrder } from '@/store/settings';
import { LANE_ORDER } from '@/types';

describe('computeEnvelope', () => {
  it('produces min/max per bin from mono-summed channels', () => {
    const sr = 1000;
    const a = new Float32Array(sr * 2); // 2 seconds
    const b = new Float32Array(sr * 2);
    for (let i = 0; i < a.length; i++) {
      a[i] = i < sr ? 0.5 : -0.25; // first second +0.5, second -0.25
      b[i] = i < sr ? 0.5 : -0.25;
    }
    a[10] = 1; b[10] = 1; // a peak in bin 1 (10ms bins)
    const env = computeEnvelope([a, b], sr, 100);
    expect(env.max.length).toBe(200);
    expect(env.max[1]).toBeCloseTo(1, 5);
    expect(env.max[50]).toBeCloseTo(0.5, 5);
    expect(env.min[50]).toBe(0);
    expect(env.min[150]).toBeCloseTo(-0.25, 5);
    expect(env.max[150]).toBe(0);
  });
  it('handles empty input', () => {
    const env = computeEnvelope([], 44100);
    expect(env.max.length).toBe(0);
  });
});

describe('mergeLaneOrder', () => {
  it('accepts a permutation and rejects anything else', () => {
    expect(mergeLaneOrder(['ride', 'toms', 'kick', 'snare', 'hihat'])).toEqual(['ride', 'toms', 'kick', 'snare', 'hihat']);
    expect(mergeLaneOrder(['ride', 'ride', 'kick', 'snare', 'hihat'])).toEqual([...LANE_ORDER]);
    expect(mergeLaneOrder(['ride', 'toms', 'kick', 'snare'])).toEqual([...LANE_ORDER]);
    expect(mergeLaneOrder(['ride', 'toms', 'kick', 'snare', 'crash'])).toEqual([...LANE_ORDER]);
    expect(mergeLaneOrder(undefined)).toEqual([...LANE_ORDER]);
  });
});
