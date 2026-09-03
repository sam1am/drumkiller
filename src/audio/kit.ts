/**
 * DrumKit — one AudioBuffer per DrumVoice, played through engine.drumBus.
 */

import { DRUM_VOICES, type DrumVoice } from '@/types';
import type { AudioEngine } from './engine';
import { randomDetune, velocityToGain } from './dsp';
import { renderDrumVoice } from './kitSynth';
import { audioBufferToWav } from './wav';

/** Voices that get a little random pitch variation per hit (±spread). */
const DETUNE_SPREAD: Partial<Record<DrumVoice, number>> = {
  snare: 0.02,
  tomHigh: 0.02,
  tomMid: 0.02,
  tomLow: 0.02,
};

const HAT_CHOKE_FADE = 0.03;

/** Handle to a triggered hit so a scheduler can cancel it before it plays. */
export interface TriggerHandle {
  voice: DrumVoice;
  /** Audio-clock time the hit starts. */
  when: number;
  /** Stop the hit (immediately if already sounding). */
  cancel(): void;
}

interface ActiveHit {
  source: AudioBufferSourceNode;
  gain: GainNode;
  when: number;
}

export class DrumKit {
  private buffers = new Map<DrumVoice, AudioBuffer>();
  private gain = 1;
  private openHats: ActiveHit[] = [];

  constructor(private readonly engine: AudioEngine) {}

  /** Synthesize the built-in kit. Safe to call before init() resolves? No — needs OfflineAudioContext only, so yes. */
  async loadDefault(): Promise<void> {
    const rendered = await Promise.all(DRUM_VOICES.map((v) => this.renderVoice(v)));
    DRUM_VOICES.forEach((v, i) => this.buffers.set(v, rendered[i]));
  }

  /** Render a single built-in voice (does not install it). */
  renderVoice(voice: DrumVoice): Promise<AudioBuffer> {
    return renderDrumVoice(voice);
  }

  /** Replace a voice with a user sample. */
  async loadSample(voice: DrumVoice, data: ArrayBuffer): Promise<void> {
    const buf = await this.engine.decode(data);
    this.buffers.set(voice, buf);
  }

  /** Install an already-decoded buffer. */
  setBuffer(voice: DrumVoice, buffer: AudioBuffer): void {
    this.buffers.set(voice, buffer);
  }

  getBuffer(voice: DrumVoice): AudioBuffer | undefined {
    return this.buffers.get(voice);
  }

  /** Export the currently loaded buffer for a voice as a 16-bit WAV. */
  exportVoiceWav(voice: DrumVoice): Blob {
    const buf = this.buffers.get(voice);
    if (!buf) throw new Error(`DrumKit: voice ${voice} not loaded`);
    return audioBufferToWav(buf);
  }

  get loaded(): Set<DrumVoice> {
    return new Set(this.buffers.keys());
  }

  /** Per-song linear gain multiplier (SongMeta.sampleGain). */
  setGain(g: number): void {
    this.gain = Math.max(0, g);
  }

  /**
   * Play a voice. `when` is an audio-clock time (defaults to now).
   * Returns a handle that can cancel the hit, or null if the voice is not loaded.
   */
  trigger(voice: DrumVoice, velocity = 1, when?: number): TriggerHandle | null {
    const buffer = this.buffers.get(voice);
    if (!buffer) return null;
    const ctx = this.engine.ctx;
    const t = when === undefined ? ctx.currentTime : Math.max(when, ctx.currentTime);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const spread = DETUNE_SPREAD[voice];
    if (spread) src.playbackRate.value = randomDetune(spread);

    const g = ctx.createGain();
    g.gain.value = velocityToGain(velocity) * this.gain;
    src.connect(g);
    g.connect(this.engine.drumBus);
    src.start(t);

    const hit: ActiveHit = { source: src, gain: g, when: t };
    src.onended = () => {
      try {
        g.disconnect();
      } catch {
        /* ignore */
      }
      if (voice === 'hihatOpen') this.openHats = this.openHats.filter((h) => h !== hit);
    };

    if (voice === 'hihatOpen') {
      this.openHats.push(hit);
    } else if (voice === 'hihatClosed') {
      this.chokeOpenHats(t);
    }

    return {
      voice,
      when: t,
      cancel: () => {
        try {
          src.stop();
        } catch {
          /* not started or already stopped */
        }
        try {
          src.disconnect();
          g.disconnect();
        } catch {
          /* ignore */
        }
      },
    };
  }

  /** Fade out any open hi-hat that is sounding at time t (30 ms). */
  private chokeOpenHats(t: number): void {
    for (const h of this.openHats) {
      if (h.when > t) continue; // an open hat scheduled after this closed one — leave it
      const p = h.gain.gain;
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(0, t + HAT_CHOKE_FADE);
      try {
        h.source.stop(t + HAT_CHOKE_FADE + 0.005);
      } catch {
        /* ignore */
      }
    }
  }
}
