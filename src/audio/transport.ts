/**
 * Transport — plays a song AudioBuffer with a variable playback rate.
 *
 * Position model: while playing we keep an anchor (audioTime, songPosition, rate).
 *   position(t) = anchorPos + (t - anchorAudioTime) * rate
 * Changing the rate re-anchors at the current position, so `position` never jumps.
 * Negative positions (pre-roll) are supported: the buffer source is scheduled to start
 * in the future and position counts up from the negative value.
 */

import type { AudioEngine } from './engine';
import { clamp } from './dsp';

export const MIN_RATE = 0.25;
export const MAX_RATE = 1.5;

export class Transport {
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private _playing = false;
  private _rate = 1;

  /** Anchor: at audio time `anchorAudio` the song position was `anchorPos`. */
  private anchorAudio = 0;
  private anchorPos = 0;
  /** Song position while paused/stopped. */
  private pausedPos = 0;

  /** Incremented on every play / seek / setRate / pause / stop so schedulers can resync. */
  private _generation = 0;
  /** Song position at which the current playing segment started (play/seek/setRate target). */
  private _segmentStart = 0;

  /** Called when the buffer plays to its end (not on stop/pause/seek). */
  onEnded: (() => void) | null = null;

  constructor(readonly engine: AudioEngine) {}

  load(buffer: AudioBuffer): void {
    this.stop();
    this.buffer = buffer;
    this.pausedPos = 0;
  }

  get duration(): number {
    return this.buffer ? this.buffer.duration : 0;
  }

  get playing(): boolean {
    return this._playing;
  }

  get rate(): number {
    return this._rate;
  }

  get loaded(): boolean {
    return !!this.buffer;
  }

  get generation(): number {
    return this._generation;
  }

  get segmentStart(): number {
    return this._segmentStart;
  }

  /** Song position in seconds (may be negative during pre-roll). */
  get position(): number {
    if (!this._playing) return this.pausedPos;
    return this.positionAtAudioTime(this.engine.ctx.currentTime);
  }

  /** Song position at a given audio-clock time. */
  positionAtAudioTime(audioTime: number): number {
    if (!this._playing) return this.pausedPos;
    return this.anchorPos + (audioTime - this.anchorAudio) * this._rate;
  }

  /** Song position at a given performance.now() timestamp (ms) — for precise input timing. */
  positionAtPerfTime(perfMs: number): number {
    if (!this._playing) return this.pausedPos;
    return this.positionAtAudioTime(this.engine.perfToAudioTime(perfMs));
  }

  /** Audio-clock time at which the given song position will be (or was) reached. */
  audioTimeAtPosition(songPos: number): number {
    if (!this._playing) return this.engine.ctx.currentTime + (songPos - this.pausedPos) / this._rate;
    return this.anchorAudio + (songPos - this.anchorPos) / this._rate;
  }

  /** Start playback from `fromSeconds` (defaults to the current paused position). Negative = pre-roll. */
  play(fromSeconds?: number): void {
    if (!this.buffer) throw new Error('Transport.play: no buffer loaded');
    const from = fromSeconds ?? this.pausedPos;
    this.killSource();
    this._playing = true;
    this.startSourceAt(from, this.engine.ctx.currentTime + 0.005);
  }

  pause(): void {
    if (!this._playing) return;
    this.pausedPos = this.position;
    this._playing = false;
    this._generation++;
    this.killSource();
  }

  stop(): void {
    this._playing = false;
    this.pausedPos = 0;
    this._generation++;
    this.killSource();
  }

  seek(seconds: number): void {
    if (this._playing) {
      this.killSource();
      this.startSourceAt(seconds, this.engine.ctx.currentTime + 0.005);
    } else {
      this.pausedPos = seconds;
    }
  }

  /** Change playback rate (0.25..1.5). Pitch follows rate. Position is continuous across the change. */
  setRate(rate: number): void {
    const r = clamp(rate, MIN_RATE, MAX_RATE);
    if (r === this._rate) return;
    if (this._playing) {
      const now = this.engine.ctx.currentTime;
      const startAt = now + 0.005;
      const pos = this.positionAtAudioTime(startAt);
      this.killSource();
      this._rate = r;
      this.startSourceAt(pos, startAt);
    } else {
      this._rate = r;
    }
  }

  // ─────────────────────────── internals ───────────────────────────

  /** (Re)create the buffer source so that song position `pos` is reached at audio time `at`. */
  private startSourceAt(pos: number, at: number): void {
    const ctx = this.engine.ctx;
    const buffer = this.buffer!;
    this.anchorAudio = at;
    this.anchorPos = pos;
    this._segmentStart = pos;
    this._generation++;

    if (pos >= buffer.duration) {
      // Nothing left to play; emit ended asynchronously.
      this._playing = false;
      this.pausedPos = buffer.duration;
      queueMicrotask(() => this.onEnded?.());
      return;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = this._rate;
    src.connect(this.engine.songBus);
    const mySource = src;
    src.onended = () => {
      if (this.source !== mySource) return; // replaced by seek/rate change/stop
      this.source = null;
      if (this._playing) {
        this._playing = false;
        this.pausedPos = buffer.duration;
        this.onEnded?.();
      }
    };
    this.source = src;

    if (pos < 0) {
      // Pre-roll: start the buffer at its beginning when position reaches 0.
      src.start(at + -pos / this._rate, 0);
    } else {
      src.start(at, pos);
    }
  }

  private killSource(): void {
    const src = this.source;
    if (!src) return;
    this.source = null;
    src.onended = null;
    try {
      src.stop();
    } catch {
      /* not started yet or already stopped */
    }
    try {
      src.disconnect();
    } catch {
      /* ignore */
    }
  }
}
