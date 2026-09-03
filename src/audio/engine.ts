/**
 * AudioEngine — owns the AudioContext and the master gain graph.
 *
 *   songBus ─┐
 *            ├─▶ master ─▶ destination
 *   drumBus ─┘
 *
 * Also provides the clock bridge between performance.now() (used by MIDI event
 * timestamps) and the audio clock (AudioContext.currentTime).
 */

import { clamp01 } from './dsp';

export class AudioEngine {
  private _ctx: AudioContext | null = null;
  private _master: GainNode | null = null;
  private _songBus: GainNode | null = null;
  private _drumBus: GainNode | null = null;
  private _capture: MediaStreamAudioDestinationNode | null = null;

  private songVolume = 0.9;
  private drumVolume = 0.9;
  private masterVolume = 1;

  /** Create the AudioContext. Must be called from a user gesture on most browsers. */
  async init(): Promise<void> {
    if (this._ctx) {
      if (this._ctx.state !== 'running') await this._ctx.resume().catch(() => undefined);
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this._ctx = ctx;

    this._master = ctx.createGain();
    this._master.gain.value = this.masterVolume;
    this._master.connect(ctx.destination);

    this._songBus = ctx.createGain();
    this._songBus.gain.value = this.songVolume;
    this._songBus.connect(this._master);

    this._drumBus = ctx.createGain();
    this._drumBus.gain.value = this.drumVolume;
    this._drumBus.connect(this._master);

    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
  }

  /** Resume a suspended context (e.g. after a tab was backgrounded). */
  async resume(): Promise<void> {
    if (this._ctx && this._ctx.state !== 'running') await this._ctx.resume();
  }

  get ready(): boolean {
    return !!this._ctx && this._ctx.state === 'running';
  }

  get ctx(): AudioContext {
    if (!this._ctx) throw new Error('AudioEngine not initialised — call init() from a user gesture first');
    return this._ctx;
  }

  get master(): GainNode {
    this.ctx;
    return this._master!;
  }

  get songBus(): GainNode {
    this.ctx;
    return this._songBus!;
  }

  get drumBus(): GainNode {
    this.ctx;
    return this._drumBus!;
  }

  /**
   * A MediaStream carrying everything that reaches the speakers (song + drums via master).
   * Used by the performance video recorder; created lazily and kept for the life of the context.
   */
  get captureNode(): MediaStreamAudioDestinationNode {
    const ctx = this.ctx;
    if (!this._capture) {
      this._capture = ctx.createMediaStreamDestination();
      this._master!.connect(this._capture);
    }
    return this._capture;
  }

  get sampleRate(): number {
    return this._ctx ? this._ctx.sampleRate : 44100;
  }

  setSongVolume(v: number): void {
    this.songVolume = clamp01(v);
    if (this._songBus) this.smoothGain(this._songBus, this.songVolume);
  }

  setDrumVolume(v: number): void {
    this.drumVolume = clamp01(v);
    if (this._drumBus) this.smoothGain(this._drumBus, this.drumVolume);
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp01(v);
    if (this._master) this.smoothGain(this._master, this.masterVolume);
  }

  private smoothGain(node: GainNode, value: number): void {
    const t = this.ctx.currentTime;
    node.gain.cancelScheduledValues(t);
    node.gain.setTargetAtTime(value, t, 0.01);
  }

  /** Decode compressed/PCM audio. Copies the input because decodeAudioData detaches the buffer. */
  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    const copy = data.slice(0);
    return this.ctx.decodeAudioData(copy);
  }

  /** Output latency in seconds (best effort). */
  get outputLatency(): number {
    if (!this._ctx) return 0;
    const c = this._ctx as AudioContext & { outputLatency?: number };
    const out = typeof c.outputLatency === 'number' && c.outputLatency > 0 ? c.outputLatency : undefined;
    return out ?? (typeof c.baseLatency === 'number' ? c.baseLatency : 0) ?? 0;
  }

  // ─────────────────────────── Clock bridge ───────────────────────────

  /** performance.now() in milliseconds. */
  nowMs(): number {
    return performance.now();
  }

  /**
   * Sample the (audioTime, perfMs) pair that describe the same instant.
   * Uses getOutputTimestamp() when available; falls back to reading both clocks back-to-back.
   */
  private clockPair(): { audio: number; perf: number } {
    const ctx = this.ctx;
    if (typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp();
      if (
        ts &&
        typeof ts.contextTime === 'number' &&
        typeof ts.performanceTime === 'number' &&
        Number.isFinite(ts.contextTime) &&
        Number.isFinite(ts.performanceTime) &&
        ts.performanceTime > 0
      ) {
        this.outputTimestampUsed = true;
        return { audio: ts.contextTime, perf: ts.performanceTime };
      }
    }
    this.outputTimestampUsed = false;
    return { audio: ctx.currentTime, perf: performance.now() };
  }

  private outputTimestampUsed = false;

  /**
   * Seconds to subtract from a perf-timestamped input hit to line it up with what the player HEARD.
   * getOutputTimestamp() already describes the sample leaving the speakers, so no extra compensation
   * is needed on that path; the back-to-back fallback needs the output latency removed.
   */
  get inputLatencyCompensation(): number {
    this.clockPair();
    return this.outputTimestampUsed ? 0 : this.outputLatency;
  }

  /** Convert an audio-clock time (seconds) to a performance.now() timestamp (ms). */
  audioTimeToPerf(audioTime: number): number {
    const p = this.clockPair();
    return p.perf + (audioTime - p.audio) * 1000;
  }

  /** Convert a performance.now() timestamp (ms) to audio-clock seconds. */
  perfToAudioTime(perfMs: number): number {
    const p = this.clockPair();
    return p.audio + (perfMs - p.perf) / 1000;
  }

  /** Tear everything down (mostly for tests / hot reload). */
  async close(): Promise<void> {
    if (this._ctx) {
      await this._ctx.close().catch(() => undefined);
      this._ctx = null;
      this._master = this._songBus = this._drumBus = this._capture = null;
    }
  }
}

/** Shared default engine. */
export const audioEngine = new AudioEngine();
