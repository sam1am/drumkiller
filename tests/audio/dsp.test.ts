import { describe, expect, it } from 'vitest';
import {
  attackDecay,
  beatsInRange,
  collectWindow,
  lowerBound,
  makeSaturationCurve,
  mulberry32,
  normalize,
  peak,
  randomDetune,
  secondsToTick,
  tauFor60dB,
  tickToSeconds,
  velocityToGain,
  whiteNoise,
} from '@/audio/dsp';

describe('velocityToGain', () => {
  it('is monotonic, clamped and passes through 0 and 1', () => {
    expect(velocityToGain(0)).toBe(0);
    expect(velocityToGain(1)).toBe(1);
    expect(velocityToGain(2)).toBe(1);
    expect(velocityToGain(-1)).toBe(0);
    expect(velocityToGain(0.5)).toBeCloseTo(Math.pow(0.5, 1.5), 6);
    let last = 0;
    for (let v = 0; v <= 1; v += 0.05) {
      const g = velocityToGain(v);
      expect(g).toBeGreaterThanOrEqual(last);
      last = g;
    }
  });
});

describe('envelopes', () => {
  it('tauFor60dB reaches -60 dB at the given time', () => {
    const tau = tauFor60dB(0.5);
    expect(Math.exp(-0.5 / tau)).toBeCloseTo(0.001, 5);
  });
  it('attackDecay ramps then decays', () => {
    expect(attackDecay(-1, 0.01, 0.1)).toBe(0);
    expect(attackDecay(0.005, 0.01, 0.1)).toBeCloseTo(0.5, 6);
    expect(attackDecay(0.01, 0.01, 0.1)).toBeCloseTo(1, 6);
    expect(attackDecay(0.11, 0.01, 0.1)).toBeCloseTo(0.001, 4);
  });
});

describe('normalize / peak', () => {
  it('scales to the target peak and ignores silence', () => {
    const a = new Float32Array([0.1, -0.5, 0.25]);
    const b = new Float32Array([0.2, 0, 0]);
    expect(peak([a, b])).toBeCloseTo(0.5);
    normalize([a, b], 0.9);
    expect(peak([a, b])).toBeCloseTo(0.9, 6);
    const silent = new Float32Array(10);
    expect(normalize([silent])).toBe(1);
  });
});

describe('saturation curve', () => {
  it('is odd-symmetric and bounded to ±1', () => {
    const c = makeSaturationCurve(2.5, 1001);
    expect(c[0]).toBeCloseTo(-1, 6);
    expect(c[1000]).toBeCloseTo(1, 6);
    expect(c[500]).toBeCloseTo(0, 6);
    for (let i = 0; i < 500; i++) expect(c[i]).toBeCloseTo(-c[1000 - i], 6);
  });
});

describe('random helpers', () => {
  it('mulberry32 is deterministic and in [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
  it('whiteNoise stays in range and randomDetune respects spread', () => {
    const n = whiteNoise(1000, mulberry32(1));
    expect(peak([n])).toBeLessThanOrEqual(1);
    expect(randomDetune(0.02, () => 0)).toBeCloseTo(0.98);
    expect(randomDetune(0.02, () => 1)).toBeCloseTo(1.02);
  });
});

describe('tempo map math', () => {
  const ppq = 480;
  const map = [
    { tick: 0, time: 0, bpm: 120 },
    { tick: 1920, time: 2, bpm: 60 },
  ];
  it('converts ticks to seconds across tempo changes', () => {
    expect(tickToSeconds(480, map, ppq)).toBeCloseTo(0.5);
    expect(tickToSeconds(1920, map, ppq)).toBeCloseTo(2);
    expect(tickToSeconds(1920 + 480, map, ppq)).toBeCloseTo(3);
  });
  it('is invertible', () => {
    for (const t of [0, 123, 1919, 1920, 3000]) {
      expect(secondsToTick(tickToSeconds(t, map, ppq), map, ppq)).toBeCloseTo(t, 6);
    }
  });
  it('enumerates beats with accents on bar starts', () => {
    const sig = [{ tick: 0, numerator: 4, denominator: 4 }];
    const beats = beatsInRange(0, 4, map, ppq, sig);
    // Bar 0 at 120 BPM (0.5 s beats), bar 1 at 60 BPM (1 s beats).
    expect(beats.map((b) => b.time)).toEqual([0, 0.5, 1, 1.5, 2, 3]);
    expect(beats.filter((b) => b.accent).map((b) => b.bar)).toEqual([0, 1]);
    // Window that starts mid-bar.
    const later = beatsInRange(3.4, 6.1, map, ppq, sig);
    expect(later.map((b) => b.time)).toEqual([4, 5, 6]);
    expect(later[2].accent).toBe(true);
    expect(later[2].bar).toBe(2);
  });
  it('handles time signature changes and does not duplicate beats across windows', () => {
    const one = [{ tick: 0, time: 0, bpm: 120 }];
    const sig = [
      { tick: 0, numerator: 3, denominator: 4 },
      { tick: 1440, numerator: 4, denominator: 4 },
    ];
    const all = beatsInRange(0, 6, one, ppq, sig);
    expect(all.length).toBe(12);
    expect(all.filter((b) => b.accent).map((b) => b.time)).toEqual([0, 1.5, 3.5, 5.5]);
    expect(all[all.length - 1].bar).toBe(3);
    const chunks: number[] = [];
    for (let i = 0; i < 60; i++) chunks.push(...beatsInRange(i / 10, (i + 1) / 10, one, ppq, sig).map((b) => b.time));
    expect(chunks.map((x) => +x.toFixed(6))).toEqual(all.map((b) => +b.time.toFixed(6)));
  });
});

describe('window helpers', () => {
  const notes = [0, 0.1, 0.25, 0.5, 0.5, 0.9].map((time) => ({ time }));
  it('lowerBound finds first note at or after t', () => {
    expect(lowerBound(notes, -1)).toBe(0);
    expect(lowerBound(notes, 0.1)).toBe(1);
    expect(lowerBound(notes, 0.5)).toBe(3);
    expect(lowerBound(notes, 1)).toBe(6);
  });
  it('collectWindow is half-open and never returns a note twice across consecutive windows', () => {
    let cursor = 0;
    const seen: number[] = [];
    for (let t = 0; t < 1; t += 0.2) {
      const r = collectWindow(notes, cursor, t, t + 0.2);
      cursor = r.cursor;
      seen.push(...r.items.map((n) => n.time));
    }
    expect(seen).toEqual([0, 0.1, 0.25, 0.5, 0.5, 0.9]);
  });
});
