/**
 * Look-ahead scheduling against the Transport.
 *
 * A 25 ms timer wakes up, asks the transport where the song will be 100 ms from now, and
 * schedules every event whose song position falls inside [lastWindowEnd, horizon).
 * Transport `generation` changes (play / seek / setRate / pause) reset the window so nothing
 * double-fires and nothing scheduled under a stale rate/anchor keeps playing.
 */

import type { ChartNote, DrumVoice, PerformanceNote } from '@/types';
import type { AudioEngine } from './engine';
import type { DrumKit, TriggerHandle } from './kit';
import type { Transport } from './transport';
import { collectWindow, lowerBound } from './dsp';

export const LOOKAHEAD_SECONDS = 0.1;
export const TICK_MS = 25;

export interface WindowState {
  lastEnd: number;
  generation: number;
  wasPlaying: boolean;
}

export function createWindowState(): WindowState {
  return { lastEnd: -Infinity, generation: -1, wasPlaying: false };
}

/**
 * Pure window-advance step. Returns the song-position range to schedule this tick,
 * or null when nothing should be scheduled. `reset` is true when the transport changed
 * segment (play/seek/rate) — callers should cancel pending scheduled hits.
 */
export function nextWindow(
  state: WindowState,
  playing: boolean,
  generation: number,
  segmentStart: number,
  horizon: number,
): { from: number; to: number; reset: boolean } | null {
  if (!playing) {
    const wasPlaying = state.wasPlaying;
    state.wasPlaying = false;
    return wasPlaying ? { from: 0, to: 0, reset: true } : null;
  }
  let reset = false;
  if (!state.wasPlaying || generation !== state.generation) {
    state.lastEnd = segmentStart;
    state.generation = generation;
    state.wasPlaying = true;
    reset = true;
  }
  if (horizon <= state.lastEnd) return reset ? { from: state.lastEnd, to: state.lastEnd, reset } : null;
  const from = state.lastEnd;
  state.lastEnd = horizon;
  return { from, to: horizon, reset };
}

type ScheduledNote = ChartNote | PerformanceNote;

export class ChartPlayer {
  private notes: ScheduledNote[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private state = createWindowState();
  private pending: TriggerHandle[] = [];
  private enabled = true;
  private offset = 0;

  /** Voices that will not be played (practice mode: the player supplies them). */
  readonly muteVoices = new Set<DrumVoice>();

  constructor(
    private readonly engine: AudioEngine,
    private readonly kit: DrumKit,
    private readonly transport: Transport,
  ) {}

  /** Replace the notes (chart notes or a recorded performance). Sorted by time internally. */
  setNotes(notes: readonly ScheduledNote[]): void {
    this.notes = [...notes].sort((a, b) => a.time - b.time);
    // Force a resync so the new notes are picked up from the current position.
    this.state = createWindowState();
    this.cancelPending();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.cancelPending();
    else this.state = createWindowState();
  }

  /** Song audio position = note.time + offset (SongMeta.offset). */
  setOffset(seconds: number): void {
    if (this.offset === seconds) return;
    this.offset = seconds;
    this.state = createWindowState();
    this.cancelPending();
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Drop everything scheduled and re-scan from the transport's current position (call after seek/rate change). */
  resync(): void {
    this.state = createWindowState();
    this.cancelPending();
    if (this.timer) this.tick();
  }

  start(): void {
    if (this.timer) return;
    this.state = createWindowState();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = createWindowState();
    this.cancelPending();
  }

  /** One scheduler step (public for tests / manual pumping). */
  tick(): void {
    const t = this.transport;
    const playing = t.playing;
    let horizon = 0;
    let segStart = 0;
    if (playing) {
      const now = this.engine.ctx.currentTime;
      horizon = t.positionAtAudioTime(now + LOOKAHEAD_SECONDS) - this.offset;
      segStart = t.segmentStart - this.offset;
    }
    const w = nextWindow(this.state, playing, t.generation, segStart, horizon);
    if (!w) return;
    if (w.reset) this.cancelPending();
    if (!playing || !this.enabled || w.to <= w.from) return;

    const start = lowerBound(this.notes, w.from);
    const { items } = collectWindow(this.notes, start, w.from, w.to);
    for (const n of items) {
      if (this.muteVoices.has(n.voice)) continue;
      const when = t.audioTimeAtPosition(n.time + this.offset);
      const h = this.kit.trigger(n.voice, n.velocity, when);
      if (h) this.pending.push(h);
    }
    this.prunePending();
  }

  private prunePending(): void {
    if (this.pending.length < 32) return;
    const now = this.engine.ctx.currentTime;
    this.pending = this.pending.filter((h) => h.when > now - 0.05);
  }

  private cancelPending(): void {
    if (!this.pending.length) return;
    let now = 0;
    try {
      now = this.engine.ctx.currentTime;
    } catch {
      now = Infinity;
    }
    for (const h of this.pending) if (h.when > now) h.cancel();
    this.pending = [];
  }
}
