import { describe, expect, it } from 'vitest';
import type { Chart, ChartNote, DrumVoice } from '@/types';
import { DIFFICULTIES } from '@/types';
import { constantTempoMap, ticksToSeconds } from '@/midi/chart';
import { chartStats, deriveDifficulty, difficultyRating } from '@/midi/difficulty';

const ppq = 480;
const map = constantTempoMap(120);

/** 8 bars of a busy 4/4 rock beat with 16th hats, ghost snares, a crash on every bar and a tom fill in bar 8. */
function expertChart(): Chart {
  const raw: { tick: number; voice: DrumVoice; velocity: number }[] = [];
  const bar = ppq * 4;
  for (let b = 0; b < 8; b++) {
    const start = b * bar;
    raw.push({ tick: start, voice: 'crash', velocity: 1 });
    for (let s = 0; s < 16; s++) {
      const tick = start + s * (ppq / 4);
      if (b < 7 || s < 8) raw.push({ tick, voice: s % 2 ? 'hihatClosed' : 'hihatOpen', velocity: s % 4 === 0 ? 0.9 : 0.5 });
      if (s === 0 || s === 8 || s === 10) raw.push({ tick, voice: 'kick', velocity: 1 });
      if (s === 4 || s === 12) raw.push({ tick, voice: 'snare', velocity: 1 });
      if (s === 7 || s === 15) raw.push({ tick, voice: 'snare', velocity: 0.2 }); // ghosts
      if (s === 3) raw.push({ tick, voice: 'kick', velocity: 0.6 });
    }
    if (b === 7) {
      // fill on beats 3–4: 16th toms
      const toms: DrumVoice[] = ['tomHigh', 'tomHigh', 'tomMid', 'tomMid', 'tomLow', 'tomLow', 'tomLow', 'tomLow'];
      toms.forEach((voice, i) => raw.push({ tick: start + (8 + i) * (ppq / 4), voice, velocity: 0.9 }));
      // two toms on the same tick
      raw.push({ tick: start + 15 * (ppq / 4), voice: 'tomHigh', velocity: 0.7 });
    }
  }
  raw.push({ tick: 8 * bar, voice: 'crash', velocity: 1 });
  raw.push({ tick: 8 * bar, voice: 'kick', velocity: 1 });
  const notes: ChartNote[] = raw
    .map((n) => ({ ...n, time: ticksToSeconds(n.tick, map, ppq) }))
    .sort((a, b) => a.time - b.time);
  return { ppq, tempoMap: map, timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }], notes, duration: notes.at(-1)!.time + 2 };
}

const key = (n: ChartNote) => `${n.tick}:${n.voice}`;

describe('deriveDifficulty', () => {
  const source = expertChart();

  it('expert is an unchanged deep copy', () => {
    const out = deriveDifficulty(source, 'expert');
    expect(out).toEqual(source);
    expect(out).not.toBe(source);
    expect(out.notes[0]).not.toBe(source.notes[0]);
    expect(out.tempoMap).not.toBe(source.tempoMap);
  });

  it('reduces note counts monotonically and never invents notes', () => {
    const counts: Record<string, number> = {};
    const sourceKeys = new Set(source.notes.map(key));
    let prevKeys: Set<string> | null = null;
    for (const d of [...DIFFICULTIES].reverse()) {
      const out = deriveDifficulty(source, d);
      counts[d] = out.notes.length;
      expect(out.ppq).toBe(source.ppq);
      expect(out.tempoMap).toEqual(source.tempoMap);
      expect(out.timeSignatures).toEqual(source.timeSignatures);
      expect(out.duration).toBe(source.duration);
      const keys = new Set(out.notes.map(key));
      for (const k of keys) expect(sourceKeys.has(k)).toBe(true);
      if (prevKeys) for (const k of keys) expect(prevKeys.has(k)).toBe(true); // subset of the harder chart
      prevKeys = keys;
      // sorted by time
      for (let i = 1; i < out.notes.length; i++) expect(out.notes[i].time).toBeGreaterThanOrEqual(out.notes[i - 1].time);
    }
    expect(counts.expert).toBeGreaterThan(counts.hard);
    expect(counts.hard).toBeGreaterThan(counts.medium);
    expect(counts.medium).toBeGreaterThan(counts.easy);
    expect(counts.easy).toBeGreaterThan(0);
  });

  it('hard: drops ghosts, thins hats to 8ths, keeps kick/snare/crash, one tom per tick', () => {
    const hard = deriveDifficulty(source, 'hard');
    expect(hard.notes.every((n) => n.velocity >= 0.3)).toBe(true);
    const hats = hard.notes.filter((n) => n.voice === 'hihatClosed' || n.voice === 'hihatOpen');
    expect(hats.length).toBeGreaterThan(0);
    expect(hats.every((n) => n.tick % (ppq / 2) === 0)).toBe(true);

    const loudSource = source.notes.filter((n) => n.velocity >= 0.3 && ['kick', 'snare', 'crash'].includes(n.voice));
    const hardKeys = new Set(hard.notes.map(key));
    for (const n of loudSource) expect(hardKeys.has(key(n))).toBe(true);

    const perTick = new Map<number, ChartNote[]>();
    for (const n of hard.notes) perTick.set(n.tick, [...(perTick.get(n.tick) ?? []), n]);
    for (const group of perTick.values()) {
      const nonKickCrash = group.filter((n) => n.voice !== 'kick' && n.voice !== 'crash');
      expect(nonKickCrash.length).toBeLessThanOrEqual(1);
      expect(group.filter((n) => n.voice.startsWith('tom')).length).toBeLessThanOrEqual(1);
    }
  });

  it('medium: hats on quarters, toms ≤ 4 per bar on 8ths, kick/snare on 8ths, crash only with kick', () => {
    const medium = deriveDifficulty(source, 'medium');
    const hats = medium.notes.filter((n) => ['hihatClosed', 'hihatOpen', 'ride'].includes(n.voice));
    expect(hats.length).toBeGreaterThan(0);
    expect(hats.every((n) => n.tick % ppq === 0)).toBe(true);
    const toms = medium.notes.filter((n) => n.voice.startsWith('tom'));
    expect(toms.length).toBeGreaterThan(0);
    expect(toms.length).toBeLessThanOrEqual(4);
    expect(toms.every((n) => n.tick % (ppq / 2) === 0)).toBe(true);
    expect(medium.notes.filter((n) => n.voice === 'kick' || n.voice === 'snare').every((n) => n.tick % (ppq / 2) === 0)).toBe(true);
    const crashTicks = new Set(medium.notes.filter((n) => n.voice === 'crash').map((n) => n.tick));
    for (const n of medium.notes) {
      if (crashTicks.has(n.tick)) expect(['crash', 'kick']).toContain(n.voice);
    }
    expect(crashTicks.size).toBe(9);
  });

  it('easy: kick/snare on quarters, hats on beats 1 & 3, toms only before a crash, one non-kick per beat', () => {
    const easy = deriveDifficulty(source, 'easy');
    expect(easy.notes.filter((n) => n.voice === 'kick' || n.voice === 'snare').every((n) => n.tick % ppq === 0)).toBe(true);
    const hats = easy.notes.filter((n) => ['hihatClosed', 'hihatOpen', 'ride'].includes(n.voice));
    expect(hats.every((n) => n.tick % (2 * ppq) === 0)).toBe(true);
    expect(easy.notes.filter((n) => n.voice === 'crash')).toHaveLength(9);
    const toms = easy.notes.filter((n) => n.voice.startsWith('tom'));
    expect(toms.length).toBeGreaterThan(0);
    const crashTicks = easy.notes.filter((n) => n.voice === 'crash').map((n) => n.tick);
    for (const t of toms) expect(crashTicks.some((c) => c > t.tick && c - t.tick <= ppq)).toBe(true);
    const perBeat = new Map<number, number>();
    for (const n of easy.notes) {
      if (n.voice === 'kick') continue;
      const beat = Math.floor(n.tick / ppq);
      perBeat.set(beat, (perBeat.get(beat) ?? 0) + 1);
    }
    for (const c of perBeat.values()) expect(c).toBe(1);
  });
});

describe('chartStats / difficultyRating', () => {
  it('counts notes, per-voice, average and peak nps', () => {
    const chart = expertChart();
    const stats = chartStats(chart);
    expect(stats.notes).toBe(chart.notes.length);
    const sum = Object.values(stats.perVoice).reduce((a, b) => a + b, 0);
    expect(sum).toBe(chart.notes.length);
    expect(stats.perVoice.crash).toBe(9);
    expect(stats.notesPerSecond).toBeCloseTo(chart.notes.length / chart.duration, 12);
    expect(stats.peakNps).toBeGreaterThanOrEqual(Math.floor(stats.notesPerSecond));
    expect(stats.peakNps).toBeLessThanOrEqual(chart.notes.length);
  });

  it('rates harder charts higher, within 1..10', () => {
    const chart = expertChart();
    const ratings = DIFFICULTIES.map((d) => difficultyRating(deriveDifficulty(chart, d)));
    for (const r of ratings) {
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(10);
      expect(Number.isInteger(r)).toBe(true);
    }
    for (let i = 1; i < ratings.length; i++) expect(ratings[i]).toBeGreaterThanOrEqual(ratings[i - 1]);
    expect(ratings[3]).toBeGreaterThan(ratings[0]);
    expect(difficultyRating({ ...chart, notes: [] })).toBe(1);
  });
});
