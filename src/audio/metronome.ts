/**
 * Metronome — synthesized accent/normal clicks scheduled from a tempo map in sync with the Transport.
 */

import type { TempoEvent, TimeSignatureEvent } from '@/types';
import type { AudioEngine } from './engine';
import type { Transport } from './transport';
import { beatsInRange, normalize, tauFor60dB } from './dsp';
import { LOOKAHEAD_SECONDS, TICK_MS, createWindowState, nextWindow, type WindowState } from './scheduler';

const CLICK_RATE = 44100;

async function renderClick(freq: number, decay: number, level: number): Promise<AudioBuffer> {
  const dur = 0.08;
  const ctx = new OfflineAudioContext(1, Math.ceil(dur * CLICK_RATE), CLICK_RATE);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(1, 0);
  g.gain.setTargetAtTime(0.0001, 0.001, tauFor60dB(decay));
  // Tick transient.
  const o2 = ctx.createOscillator();
  o2.type = 'square';
  o2.frequency.value = freq * 3;
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.3, 0);
  g2.gain.setTargetAtTime(0.0001, 0, 0.002);
  o.connect(g).connect(ctx.destination);
  o2.connect(g2).connect(ctx.destination);
  o.start(0);
  o2.start(0);
  o.stop(dur);
  o2.stop(0.02);
  const buf = await ctx.startRendering();
  normalize([buf.getChannelData(0)], level);
  return buf;
}

export class Metronome {
  private accent: AudioBuffer | null = null;
  private normal: AudioBuffer | null = null;
  private out: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: WindowState = createWindowState();
  private pending: { src: AudioBufferSourceNode; when: number }[] = [];
  private enabled = true;
  private offset = 0;
  private volume = 0.8;

  private tempoMap: TempoEvent[] = [{ tick: 0, time: 0, bpm: 120 }];
  private ppq = 480;
  private timeSignatures: TimeSignatureEvent[] = [{ tick: 0, numerator: 4, denominator: 4 }];

  constructor(
    private readonly engine: AudioEngine,
    private readonly transport: Transport,
  ) {}

  /** Render the click buffers (needs only OfflineAudioContext). */
  async load(): Promise<void> {
    [this.accent, this.normal] = await Promise.all([renderClick(1760, 0.05, 0.9), renderClick(1175, 0.04, 0.7)]);
  }

  get loaded(): boolean {
    return !!this.accent && !!this.normal;
  }

  /** Idempotent load(): renders click buffers once. */
  async prepare(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /** Drop scheduled clicks and re-scan from the transport's current position (call after seek/rate change). */
  resync(): void {
    this.state = createWindowState();
    this.cancelPending();
    if (this.timer) this.tick();
  }

  setTempoMap(tempoMap: TempoEvent[], ppq: number, timeSignatures: TimeSignatureEvent[]): void {
    this.tempoMap = tempoMap.length ? tempoMap : [{ tick: 0, time: 0, bpm: 120 }];
    this.ppq = ppq;
    this.timeSignatures = timeSignatures.length ? timeSignatures : [{ tick: 0, numerator: 4, denominator: 4 }];
    this.state = createWindowState();
  }

  /** Song audio position = chart time + offset. */
  setOffset(seconds: number): void {
    this.offset = seconds;
    this.state = createWindowState();
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.out) this.out.gain.setTargetAtTime(this.volume, this.engine.ctx.currentTime, 0.01);
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.cancelPending();
    else this.state = createWindowState();
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

  /**
   * Schedule a count-in of `bars` bars at `bpm` starting at audio-clock time `atAudioTime`.
   * Returns the audio time at which the count-in ends (= where the song should start).
   */
  countIn(bars: number, bpm: number, atAudioTime: number, beatsPerBar = 4): number {
    const beat = 60 / bpm;
    for (let i = 0; i < bars * beatsPerBar; i++) {
      this.click(atAudioTime + i * beat, i % beatsPerBar === 0);
    }
    return atAudioTime + bars * beatsPerBar * beat;
  }

  /** Play a single click now (or at `when`). */
  click(when?: number, accent = false): void {
    const buf = accent ? this.accent : this.normal;
    if (!buf) return;
    const ctx = this.engine.ctx;
    const t = when === undefined ? ctx.currentTime : Math.max(when, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.output());
    src.start(t);
    const entry = { src, when: t };
    this.pending.push(entry);
    src.onended = () => {
      this.pending = this.pending.filter((p) => p !== entry);
    };
  }

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
    const beats = beatsInRange(w.from, w.to, this.tempoMap, this.ppq, this.timeSignatures);
    for (const b of beats) {
      this.click(t.audioTimeAtPosition(b.time + this.offset), b.accent);
    }
  }

  private output(): GainNode {
    if (!this.out) {
      this.out = this.engine.ctx.createGain();
      this.out.gain.value = this.volume;
      this.out.connect(this.engine.master);
    }
    return this.out;
  }

  private cancelPending(): void {
    if (!this.pending.length) return;
    let now = 0;
    try {
      now = this.engine.ctx.currentTime;
    } catch {
      now = Infinity;
    }
    for (const p of this.pending) {
      if (p.when > now) {
        p.src.onended = null;
        try {
          p.src.stop();
        } catch {
          /* ignore */
        }
      }
    }
    this.pending = this.pending.filter((p) => p.when <= now);
  }
}
