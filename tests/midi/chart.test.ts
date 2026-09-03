import { describe, expect, it } from 'vitest';
import type { Chart, ChartNote, PerformanceNote } from '@/types';
import {
  DEFAULT_PPQ,
  buildTempoMap,
  chartFromMidi,
  chartToMidi,
  constantTempoMap,
  performanceToChart,
  secondsToTicks,
  sortChartNotes,
  ticksToSeconds,
} from '@/midi/chart';
import { parseMidi, writeMidi, type MidiFile } from '@/midi/smf';

describe('tempo map', () => {
  const ppq = 480;

  it('inserts a fallback entry at tick 0 and computes cumulative time', () => {
    const map = buildTempoMap([{ tick: 960, bpm: 60 }], ppq, 120);
    expect(map).toEqual([
      { tick: 0, time: 0, bpm: 120 },
      { tick: 960, time: 1, bpm: 60 },
    ]);
  });

  it('sorts, dedupes and drops invalid entries', () => {
    const map = buildTempoMap(
      [
        { tick: 480, bpm: 100 },
        { tick: 0, bpm: 120 },
        { tick: 480, bpm: 90 },
        { tick: 240, bpm: 0 },
        { tick: 300, bpm: NaN },
      ],
      ppq,
      140,
    );
    expect(map.map((t) => [t.tick, t.bpm])).toEqual([
      [0, 120],
      [480, 90],
    ]);
    expect(map[1].time).toBeCloseTo(0.5, 12);
  });

  it('converts ticks ↔ seconds across a tempo change and is an exact inverse', () => {
    const map = buildTempoMap(
      [
        { tick: 0, bpm: 120 },
        { tick: 960, bpm: 60 },
        { tick: 1920, bpm: 180 },
      ],
      ppq,
      120,
    );
    expect(ticksToSeconds(0, map, ppq)).toBe(0);
    expect(ticksToSeconds(480, map, ppq)).toBeCloseTo(0.5, 12);
    expect(ticksToSeconds(960, map, ppq)).toBeCloseTo(1, 12);
    expect(ticksToSeconds(1440, map, ppq)).toBeCloseTo(2, 12); // 1 s + 1 beat @ 60 bpm
    expect(ticksToSeconds(1920, map, ppq)).toBeCloseTo(3, 12); // 1 s + 2 beats @ 60 bpm
    expect(ticksToSeconds(1920 + 480, map, ppq)).toBeCloseTo(3 + 1 / 3, 12);

    expect(secondsToTicks(1.5, map, ppq)).toBeCloseTo(1200, 9);
    expect(secondsToTicks(3, map, ppq)).toBeCloseTo(1920, 9);

    for (let tick = -200; tick <= 5000; tick += 37) {
      const s = ticksToSeconds(tick, map, ppq);
      expect(secondsToTicks(s, map, ppq)).toBeCloseTo(tick, 8);
    }
    for (let s = -0.5; s <= 8; s += 0.113) {
      const t = secondsToTicks(s, map, ppq);
      expect(ticksToSeconds(t, map, ppq)).toBeCloseTo(s, 10);
    }
  });

  it('constantTempoMap produces a single tick-0 entry', () => {
    expect(constantTempoMap(100)).toEqual([{ tick: 0, time: 0, bpm: 100 }]);
    expect(ticksToSeconds(DEFAULT_PPQ * 2, constantTempoMap(120), DEFAULT_PPQ)).toBeCloseTo(1, 12);
  });
});

function makeChart(): Chart {
  const ppq = 480;
  const tempoMap = buildTempoMap(
    [
      { tick: 0, bpm: 120 },
      { tick: 1920, bpm: 150 },
    ],
    ppq,
    120,
  );
  const raw: Omit<ChartNote, 'time'>[] = [
    { tick: 0, voice: 'kick', velocity: 1 },
    { tick: 0, voice: 'crash', velocity: 0.8 },
    { tick: 0, voice: 'hihatClosed', velocity: 0.5 },
    { tick: 240, voice: 'hihatClosed', velocity: 0.4 },
    { tick: 480, voice: 'snare', velocity: 0.9 },
    { tick: 480, voice: 'hihatClosed', velocity: 0.5 },
    { tick: 720, voice: 'hihatOpen', velocity: 0.6 },
    { tick: 960, voice: 'kick', velocity: 1 },
    { tick: 1200, voice: 'kick', velocity: 0.7 },
    { tick: 1440, voice: 'snare', velocity: 1 },
    { tick: 1680, voice: 'tomHigh', velocity: 0.8 },
    { tick: 1800, voice: 'tomMid', velocity: 0.8 },
    { tick: 1920, voice: 'tomLow', velocity: 0.8 },
    { tick: 2400, voice: 'ride', velocity: 0.6 },
    { tick: 2880, voice: 'crash', velocity: 1 },
  ];
  const notes: ChartNote[] = sortChartNotes(raw.map((n) => ({ ...n, time: ticksToSeconds(n.tick, tempoMap, ppq) })));
  return {
    ppq,
    tempoMap,
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    notes,
    duration: notes[notes.length - 1].time + 2,
  };
}

describe('chartToMidi / chartFromMidi', () => {
  it('round-trips ticks, voices, velocities and the tempo map through SMF bytes', () => {
    const chart = makeChart();
    const midi = chartToMidi(chart, { trackName: 'Test' });
    expect(midi.format).toBe(1);
    expect(midi.tracks).toHaveLength(2);
    expect(midi.tracks[0].name).toBe('Test');
    expect(midi.tracks[1].events.every((e) => e.type !== 'noteOn' || e.channel === 9)).toBe(true);

    const back = chartFromMidi(parseMidi(writeMidi(midi)), { fallbackBpm: 100 });
    expect(back.ppq).toBe(480);
    expect(back.notes.map((n) => [n.tick, n.voice])).toEqual(chart.notes.map((n) => [n.tick, n.voice]));
    for (let i = 0; i < chart.notes.length; i++) {
      expect(back.notes[i].velocity).toBeCloseTo(chart.notes[i].velocity, 2);
      expect(back.notes[i].time).toBeCloseTo(chart.notes[i].time, 6);
    }
    expect(back.tempoMap.map((t) => t.tick)).toEqual([0, 1920]);
    expect(back.tempoMap[1].bpm).toBeCloseTo(150, 4);
    expect(back.timeSignatures).toEqual([{ tick: 0, numerator: 4, denominator: 4 }]);
    expect(back.duration).toBeCloseTo(chart.duration, 6);
  });

  it('emits note-offs before note-ons on the same tick and honours noteLength/channel', () => {
    const chart = makeChart();
    const midi = chartToMidi(chart, { noteLength: 240, channel: 3 });
    const ev = midi.tracks[1].events;
    // hihatClosed at 0 → off at 240, and a hihatClosed on at 240: off must come first.
    const at240 = ev.filter((e) => e.tick === 240 && (e.type === 'noteOn' || e.type === 'noteOff'));
    expect(at240[0].type).toBe('noteOff');
    expect(ev.every((e) => e.type !== 'noteOn' || e.channel === 3)).toBe(true);
    const on = ev.find((e) => e.type === 'noteOn')!;
    const off = ev.find((e) => e.type === 'noteOff' && e.note === (on as { note: number }).note)!;
    expect(off.tick - on.tick).toBe(240);
  });

  it('collects notes from every track, ignores unmapped notes and note-offs, and dedupes', () => {
    const midi: MidiFile = {
      format: 1,
      ppq: 96,
      tracks: [
        { events: [{ type: 'tempo', tick: 0, bpm: 60, microsecondsPerQuarter: 1_000_000 }] },
        {
          events: [
            { type: 'noteOn', tick: 0, channel: 9, note: 36, velocity: 64 },
            { type: 'noteOn', tick: 0, channel: 9, note: 35, velocity: 127 }, // duplicate kick → keep loudest
            { type: 'noteOn', tick: 96, channel: 9, note: 60, velocity: 127 }, // bongo → ignored
            { type: 'noteOff', tick: 96, channel: 9, note: 36, velocity: 0 },
          ],
        },
        {
          events: [
            { type: 'noteOn', tick: 96, channel: 2, note: 38, velocity: 100 },
            { type: 'timeSignature', tick: 0, numerator: 3, denominator: 8 },
          ],
        },
      ],
    };
    const chart = chartFromMidi(midi, { fallbackBpm: 120 });
    expect(chart.notes).toEqual([
      { tick: 0, time: 0, voice: 'kick', velocity: 1 },
      { tick: 96, time: 1, voice: 'snare', velocity: 100 / 127 },
    ]);
    expect(chart.tempoMap).toEqual([{ tick: 0, time: 0, bpm: 60 }]);
    expect(chart.timeSignatures).toEqual([{ tick: 0, numerator: 3, denominator: 8 }]);
    expect(chart.duration).toBe(3);

    const filtered = chartFromMidi(midi, { fallbackBpm: 120, channelFilter: 2 });
    expect(filtered.notes.map((n) => n.voice)).toEqual(['snare']);
  });

  it('uses fallbackBpm when the file has no tempo; an empty chart still gets the +2 s tail', () => {
    const chart = chartFromMidi({ format: 0, ppq: 480, tracks: [{ events: [] }] }, { fallbackBpm: 90 });
    expect(chart.tempoMap).toEqual([{ tick: 0, time: 0, bpm: 90 }]);
    expect(chart.timeSignatures).toEqual([{ tick: 0, numerator: 4, denominator: 4 }]);
    expect(chart.duration).toBe(2);
    expect(chart.notes).toEqual([]);
  });
});

describe('performanceToChart', () => {
  it('rounds seconds to the nearest tick and re-derives time from the tick', () => {
    const map = constantTempoMap(120); // 480 ticks = 1 beat = 0.5 s → 1 tick ≈ 1.0417 ms
    const notes: PerformanceNote[] = [
      { time: 0.5004, voice: 'snare', velocity: 0.9 },
      { time: 0.0, voice: 'kick', velocity: 1 },
      { time: 0.0003, voice: 'kick', velocity: 0.5 }, // same tick → merged
    ];
    const chart = performanceToChart(notes, map, 480);
    expect(chart.notes.map((n) => [n.tick, n.voice, n.velocity])).toEqual([
      [0, 'kick', 1],
      [480, 'snare', 0.9],
    ]);
    expect(chart.notes[1].time).toBeCloseTo(0.5, 12);
    expect(chart.duration).toBeCloseTo(2.5, 12);
    expect(chart.tempoMap).toEqual(map);
    expect(chart.tempoMap).not.toBe(map);
  });
});
