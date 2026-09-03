/**
 * Chart ⇄ MIDI conversion and tempo-map math.
 *
 * All conversions are driven by a tempo map (list of {@link TempoEvent}s with
 * pre-computed `time`), so tick ↔ second conversions are piecewise-linear and
 * exact inverses of each other.
 */

import type { Chart, ChartNote, DrumVoice, PerformanceNote, TempoEvent, TimeSignatureEvent } from '@/types';
import { LANE_FOR_VOICE, LANE_ORDER } from '@/types';
import { noteForVoice, voiceForNote } from './gm';
import type { MidiEvent, MidiFile } from './smf';

/** Default pulses-per-quarter used for charts produced by the game. */
export const DEFAULT_PPQ = 480;

// ─────────────────────────── Tempo map ───────────────────────────

/**
 * Build a normalised tempo map.
 *
 * - Sorted by tick, one entry per tick (later entries win on duplicates).
 * - Guaranteed entry at tick 0 (`fallbackBpm` is used when the input has none).
 * - `time` (seconds from chart zero) is computed cumulatively.
 * - Non-positive / non-finite BPM values are discarded.
 *
 * @param events      Raw tempo events (e.g. from a MIDI file).
 * @param ppq         Pulses per quarter note.
 * @param fallbackBpm BPM used at tick 0 when none is given.
 */
export function buildTempoMap(
  events: { tick: number; bpm: number }[],
  ppq: number,
  fallbackBpm: number,
): TempoEvent[] {
  const byTick = new Map<number, number>();
  for (const ev of events) {
    if (!Number.isFinite(ev.bpm) || ev.bpm <= 0 || !Number.isFinite(ev.tick)) continue;
    byTick.set(Math.max(0, ev.tick), ev.bpm);
  }
  if (!byTick.has(0)) {
    byTick.set(0, Number.isFinite(fallbackBpm) && fallbackBpm > 0 ? fallbackBpm : 120);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);

  const map: TempoEvent[] = [];
  let time = 0;
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i];
    if (i > 0) {
      const prev = map[i - 1];
      time = prev.time + ((tick - prev.tick) * 60) / (prev.bpm * ppq);
    }
    map.push({ tick, time, bpm: byTick.get(tick)! });
  }
  return map;
}

/** Tempo map with a single constant tempo at tick 0. */
export function constantTempoMap(bpm: number): TempoEvent[] {
  return [{ tick: 0, time: 0, bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : 120 }];
}

/** Binary search: index of the last tempo entry whose `tick` <= tick (0 if tick precedes the map). */
function segmentForTick(tick: number, tempoMap: TempoEvent[]): number {
  let lo = 0;
  let hi = tempoMap.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tempoMap[mid].tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Binary search: index of the last tempo entry whose `time` <= seconds (0 if before the map). */
function segmentForTime(seconds: number, tempoMap: TempoEvent[]): number {
  let lo = 0;
  let hi = tempoMap.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tempoMap[mid].time <= seconds) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Convert a tick position to seconds using a tempo map (piecewise-linear).
 * Ticks before the first entry are extrapolated with the first tempo.
 *
 * @param tick     Tick position (may be fractional).
 * @param tempoMap Tempo map from {@link buildTempoMap} / {@link constantTempoMap}.
 * @param ppq      Pulses per quarter note.
 */
export function ticksToSeconds(tick: number, tempoMap: TempoEvent[], ppq: number): number {
  if (tempoMap.length === 0) return (tick * 60) / (120 * ppq);
  const seg = tempoMap[segmentForTick(tick, tempoMap)];
  return seg.time + ((tick - seg.tick) * 60) / (seg.bpm * ppq);
}

/**
 * Convert seconds to a (fractional) tick position — the exact inverse of
 * {@link ticksToSeconds}.
 */
export function secondsToTicks(seconds: number, tempoMap: TempoEvent[], ppq: number): number {
  if (tempoMap.length === 0) return (seconds * 120 * ppq) / 60;
  const seg = tempoMap[segmentForTime(seconds, tempoMap)];
  return seg.tick + ((seconds - seg.time) * seg.bpm * ppq) / 60;
}

// ─────────────────────────── Helpers ───────────────────────────

/** Lane sort order used for ties on `time` (crash sorts last). */
function laneIndex(voice: DrumVoice): number {
  const idx = LANE_ORDER.indexOf(LANE_FOR_VOICE[voice]);
  return idx < 0 ? LANE_ORDER.length : idx;
}

/** Sort notes by time, then lane, then voice name (stable & deterministic). */
export function sortChartNotes<T extends { time: number; voice: DrumVoice }>(notes: T[]): T[] {
  return notes.sort((a, b) => a.time - b.time || laneIndex(a.voice) - laneIndex(b.voice) || (a.voice < b.voice ? -1 : a.voice > b.voice ? 1 : 0));
}

/** Normalise time signatures: sorted, deduped by tick, entry at tick 0 guaranteed (4/4 default). */
export function normaliseTimeSignatures(sigs: TimeSignatureEvent[]): TimeSignatureEvent[] {
  const byTick = new Map<number, TimeSignatureEvent>();
  for (const s of sigs) {
    if (!Number.isFinite(s.tick) || s.numerator <= 0 || s.denominator <= 0) continue;
    const tick = Math.max(0, s.tick);
    byTick.set(tick, { tick, numerator: s.numerator, denominator: s.denominator });
  }
  if (!byTick.has(0)) byTick.set(0, { tick: 0, numerator: 4, denominator: 4 });
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

/** Chart duration rule: last note + 2 s, never below 1 s. */
function durationFor(notes: { time: number }[]): number {
  const last = notes.length ? notes[notes.length - 1].time : 0;
  return Math.max(1, last + 2);
}

// ─────────────────────────── MIDI → Chart ───────────────────────────

/** Options for {@link chartFromMidi}. */
export interface ChartFromMidiOptions {
  /** Tempo used when the file has no tempo event at tick 0. */
  fallbackBpm: number;
  /** Only accept notes on this channel (0..15). `null`/`undefined` = every channel. */
  channelFilter?: number | null;
}

/**
 * Convert a parsed MIDI file into a {@link Chart}.
 *
 * - Note-ons from ALL tracks whose note maps to a voice ({@link voiceForNote}) become
 *   chart notes (note-offs are ignored). Velocity is normalised to 0..1.
 * - Tempo and time-signature events are collected from every track.
 * - Exact duplicates (same tick + voice) collapse into one (loudest wins).
 * - Notes are sorted by time, then lane.
 * - `duration` is the last note time + 2 s (minimum 1 s).
 */
export function chartFromMidi(midi: MidiFile, opts: ChartFromMidiOptions): Chart {
  const ppq = Number.isFinite(midi.ppq) && midi.ppq > 0 ? midi.ppq : DEFAULT_PPQ;
  const channelFilter = opts.channelFilter ?? null;

  const tempoEvents: { tick: number; bpm: number }[] = [];
  const timeSigs: TimeSignatureEvent[] = [];
  const noteMap = new Map<string, { tick: number; voice: DrumVoice; velocity: number }>();

  for (const track of midi.tracks) {
    for (const ev of track.events) {
      switch (ev.type) {
        case 'tempo':
          tempoEvents.push({ tick: ev.tick, bpm: ev.bpm });
          break;
        case 'timeSignature':
          timeSigs.push({ tick: ev.tick, numerator: ev.numerator, denominator: ev.denominator });
          break;
        case 'noteOn': {
          if (channelFilter !== null && ev.channel !== channelFilter) break;
          const voice = voiceForNote(ev.note);
          if (!voice) break;
          const key = `${ev.tick}:${voice}`;
          const velocity = Math.min(1, Math.max(0, ev.velocity / 127));
          const existing = noteMap.get(key);
          if (!existing) noteMap.set(key, { tick: ev.tick, voice, velocity });
          else existing.velocity = Math.max(existing.velocity, velocity);
          break;
        }
        default:
          break;
      }
    }
  }

  const tempoMap = buildTempoMap(tempoEvents, ppq, opts.fallbackBpm);
  const notes: ChartNote[] = [];
  for (const n of noteMap.values()) {
    notes.push({ tick: n.tick, time: ticksToSeconds(n.tick, tempoMap, ppq), voice: n.voice, velocity: n.velocity });
  }
  sortChartNotes(notes);

  return {
    ppq,
    tempoMap,
    timeSignatures: normaliseTimeSignatures(timeSigs),
    notes,
    duration: durationFor(notes),
  };
}

// ─────────────────────────── Chart → MIDI ───────────────────────────

/** Options for {@link chartToMidi}. */
export interface ChartToMidiOptions {
  /** Name written to the tempo track (default `DRUMKILLER`). */
  trackName?: string;
  /** Note length in ticks (default `ppq / 8`, at least 1). */
  noteLength?: number;
  /** MIDI channel for the drum notes (default 9 = GM percussion). */
  channel?: number;
}

/**
 * Convert a chart into a format-1 MIDI file:
 *  - track 0: track name, tempo map and time signatures
 *  - track 1: drum notes on channel 9 (canonical GM notes via {@link noteForVoice}),
 *    each followed by a note-off after `noteLength` ticks.
 *
 * Note-offs that land on the same tick as a later note-on are ordered before it.
 */
export function chartToMidi(chart: Chart, opts: ChartToMidiOptions = {}): MidiFile {
  const ppq = Number.isFinite(chart.ppq) && chart.ppq > 0 ? Math.round(chart.ppq) : DEFAULT_PPQ;
  const channel = Math.min(15, Math.max(0, Math.round(opts.channel ?? 9)));
  const noteLength = Math.max(1, Math.round(opts.noteLength ?? ppq / 8));
  const trackName = opts.trackName ?? 'DRUMKILLER';

  const metaEvents: MidiEvent[] = [{ type: 'trackName', tick: 0, text: trackName }];
  for (const t of chart.tempoMap) {
    metaEvents.push({
      type: 'tempo',
      tick: Math.max(0, Math.round(t.tick)),
      bpm: t.bpm,
      microsecondsPerQuarter: Math.round(60_000_000 / t.bpm),
    });
  }
  for (const s of normaliseTimeSignatures(chart.timeSignatures)) {
    metaEvents.push({ type: 'timeSignature', tick: s.tick, numerator: s.numerator, denominator: s.denominator });
  }
  metaEvents.sort((a, b) => a.tick - b.tick);

  const noteEvents: (MidiEvent & { order: number })[] = [];
  for (const n of chart.notes) {
    const tick = Math.max(0, Math.round(n.tick));
    const note = noteForVoice(n.voice);
    const velocity = Math.min(127, Math.max(1, Math.round(n.velocity * 127)));
    noteEvents.push({ type: 'noteOn', tick, channel, note, velocity, order: 1 });
    noteEvents.push({ type: 'noteOff', tick: tick + noteLength, channel, note, velocity: 0, order: 0 });
  }
  noteEvents.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const drumEvents: MidiEvent[] = noteEvents.map(({ order: _order, ...ev }) => ev as MidiEvent);

  const lastTick = drumEvents.length ? drumEvents[drumEvents.length - 1].tick : 0;
  const endTick = Math.max(lastTick, Math.round(secondsToTicks(chart.duration, chart.tempoMap, ppq)));
  metaEvents.push({ type: 'endOfTrack', tick: endTick });
  drumEvents.push({ type: 'endOfTrack', tick: endTick });

  return {
    format: 1,
    ppq,
    tracks: [
      { name: trackName, events: metaEvents },
      { name: 'Drums', events: drumEvents },
    ],
  };
}

// ─────────────────────────── Performance → Chart ───────────────────────────

/**
 * Turn recorded performance notes (seconds) into a chart, rounding each note
 * to the nearest tick under the given tempo map. `time` is re-derived from the
 * rounded tick so ticks and seconds always agree. Exact duplicates (same tick +
 * voice) collapse into one (loudest wins). Time signature defaults to 4/4.
 */
export function performanceToChart(notes: PerformanceNote[], tempoMap: TempoEvent[], ppq: number): Chart {
  const map = tempoMap.length ? tempoMap : constantTempoMap(120);
  const byKey = new Map<string, ChartNote>();
  for (const n of notes) {
    const tick = Math.round(secondsToTicks(n.time, map, ppq));
    const key = `${tick}:${n.voice}`;
    const velocity = Math.min(1, Math.max(0, n.velocity));
    const existing = byKey.get(key);
    if (existing) existing.velocity = Math.max(existing.velocity, velocity);
    else byKey.set(key, { tick, time: ticksToSeconds(tick, map, ppq), voice: n.voice, velocity });
  }
  const chartNotes = sortChartNotes([...byKey.values()]);
  return {
    ppq,
    tempoMap: map.map((t) => ({ ...t })),
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    notes: chartNotes,
    duration: durationFor(chartNotes),
  };
}
