/**
 * Procedural drum voice recipes rendered through an OfflineAudioContext.
 * Each recipe wires oscillators / noise / filters into `out` starting at t=0.
 */

import type { DrumVoice } from '@/types';
import { METALLIC_FREQS, makeSaturationCurve, mulberry32, normalize, tauFor60dB, whiteNoise } from './dsp';

export const KIT_SAMPLE_RATE = 44100;

/** Seconds of audio rendered per voice. */
export const VOICE_DURATIONS: Record<DrumVoice, number> = {
  kick: 0.55,
  snare: 0.45,
  tomHigh: 0.45,
  tomMid: 0.55,
  tomLow: 0.7,
  hihatClosed: 0.18,
  hihatOpen: 0.7,
  ride: 1.8,
  crash: 2.8,
};

type Recipe = (ctx: BaseAudioContext, out: AudioNode) => void;

/** Render one voice into a new AudioBuffer (mono), normalised to `peakTarget`. */
export async function renderDrumVoice(voice: DrumVoice, peakTarget = 0.9): Promise<AudioBuffer> {
  const duration = VOICE_DURATIONS[voice];
  const ctx = new OfflineAudioContext(1, Math.ceil(duration * KIT_SAMPLE_RATE), KIT_SAMPLE_RATE);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  RECIPES[voice](ctx, out);
  const buffer = await ctx.startRendering();
  const chans: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  normalize(chans, peakTarget);
  // Tiny fade at the very end so looping/truncation never clicks.
  const fade = Math.min(256, buffer.length);
  for (const ch of chans) for (let i = 0; i < fade; i++) ch[buffer.length - 1 - i] *= i / fade;
  return buffer;
}

// ─────────────────────────── building blocks ───────────────────────────

function noiseBuffer(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const len = Math.ceil(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  buf.getChannelData(0).set(whiteNoise(len, mulberry32(seed)));
  return buf;
}

function noiseSource(ctx: BaseAudioContext, seconds: number, seed: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, seconds, seed);
  return src;
}

/** Gain node with an attack/exponential-decay envelope. */
function env(ctx: BaseAudioContext, peakGain: number, attack: number, decay: number, start = 0): GainNode {
  const g = ctx.createGain();
  const p = g.gain;
  p.setValueAtTime(0.0001, start);
  if (attack > 0) p.linearRampToValueAtTime(peakGain, start + attack);
  else p.setValueAtTime(peakGain, start);
  p.setTargetAtTime(0.0001, start + attack, tauFor60dB(decay));
  return g;
}

function osc(ctx: BaseAudioContext, type: OscillatorType, freq: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, 0);
  return o;
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 1): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, 0);
  f.Q.setValueAtTime(q, 0);
  return f;
}

function chain(...nodes: AudioNode[]): void {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
}

function metallicStack(ctx: BaseAudioContext, mult: number, stop: number): GainNode {
  const sum = ctx.createGain();
  sum.gain.value = 1 / METALLIC_FREQS.length;
  for (const f of METALLIC_FREQS) {
    const o = osc(ctx, 'square', f * mult);
    o.connect(sum);
    o.start(0);
    o.stop(stop);
  }
  return sum;
}

// ─────────────────────────── recipes ───────────────────────────

const kick: Recipe = (ctx, out) => {
  const dur = VOICE_DURATIONS.kick;
  // Body: sine sweeping 150 → 45 Hz over 60 ms.
  const body = osc(ctx, 'sine', 150);
  body.frequency.exponentialRampToValueAtTime(45, 0.06);
  body.frequency.exponentialRampToValueAtTime(38, 0.4);
  const bodyEnv = env(ctx, 1, 0.002, 0.5);
  // Click transient: short filtered noise + a fast 1.2 kHz blip.
  const click = noiseSource(ctx, 0.02, 11);
  const clickFilt = filter(ctx, 'bandpass', 2500, 0.8);
  const clickEnv = env(ctx, 0.5, 0, 0.012);
  const blip = osc(ctx, 'sine', 1200);
  blip.frequency.exponentialRampToValueAtTime(200, 0.015);
  const blipEnv = env(ctx, 0.6, 0, 0.02);
  // Saturation + lowpass to glue.
  const shaper = ctx.createWaveShaper();
  shaper.curve = makeSaturationCurve(2.5);
  shaper.oversample = '2x';
  const lp = filter(ctx, 'lowpass', 5000, 0.7);
  chain(body, bodyEnv, shaper);
  chain(click, clickFilt, clickEnv, shaper);
  chain(blip, blipEnv, shaper);
  chain(shaper, lp, out);
  body.start(0);
  body.stop(dur);
  click.start(0);
  blip.start(0);
  blip.stop(0.05);
};

const snare: Recipe = (ctx, out) => {
  const dur = VOICE_DURATIONS.snare;
  // Two detuned triangle bodies.
  for (const [f, g] of [
    [180, 0.8],
    [330, 0.5],
  ] as const) {
    const o = osc(ctx, 'triangle', f);
    o.frequency.exponentialRampToValueAtTime(f * 0.9, 0.08);
    const e = env(ctx, g, 0.001, 0.11);
    chain(o, e, out);
    o.start(0);
    o.stop(0.25);
  }
  // Snare wires: highpassed noise, 150 ms decay.
  const wires = noiseSource(ctx, dur, 21);
  const hp = filter(ctx, 'highpass', 1800, 0.7);
  const wireEnv = env(ctx, 0.9, 0.001, 0.15);
  chain(wires, hp, wireEnv, out);
  wires.start(0);
  // Crack: bandpassed noise, very short.
  const crack = noiseSource(ctx, 0.08, 22);
  const bp = filter(ctx, 'bandpass', 3200, 1.5);
  const crackEnv = env(ctx, 1.0, 0, 0.035);
  chain(crack, bp, crackEnv, out);
  crack.start(0);
  // Light saturation on the whole thing is applied by the caller's normalise; keep clean here.
};

function tomRecipe(from: number, to: number, decay: number, dur: number): Recipe {
  return (ctx, out) => {
    const body = osc(ctx, 'sine', from);
    body.frequency.exponentialRampToValueAtTime(to, 0.08);
    body.frequency.exponentialRampToValueAtTime(to * 0.92, dur);
    const bodyEnv = env(ctx, 1, 0.002, decay);
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeSaturationCurve(1.6);
    // Second harmonic for some ring.
    const ring = osc(ctx, 'triangle', from * 1.5);
    ring.frequency.exponentialRampToValueAtTime(to * 1.5, 0.08);
    const ringEnv = env(ctx, 0.25, 0.002, decay * 0.5);
    // Attack noise (stick).
    const stick = noiseSource(ctx, 0.05, 31);
    const stickFilt = filter(ctx, 'bandpass', 1800, 1);
    const stickEnv = env(ctx, 0.35, 0, 0.02);
    chain(body, bodyEnv, shaper, out);
    chain(ring, ringEnv, out);
    chain(stick, stickFilt, stickEnv, out);
    body.start(0);
    body.stop(dur);
    ring.start(0);
    ring.stop(dur);
    stick.start(0);
  };
}

function hatRecipe(decay: number, dur: number, noiseDecay: number): Recipe {
  return (ctx, out) => {
    const stack = metallicStack(ctx, 2, dur);
    const bp = filter(ctx, 'bandpass', 10000, 1);
    const hp = filter(ctx, 'highpass', 7000, 0.7);
    const e = env(ctx, 1, 0.001, decay);
    chain(stack, bp, hp, e, out);
    const n = noiseSource(ctx, dur, 41);
    const nhp = filter(ctx, 'highpass', 8000, 0.7);
    const ne = env(ctx, 0.5, 0, noiseDecay);
    chain(n, nhp, ne, out);
    n.start(0);
  };
}

const ride: Recipe = (ctx, out) => {
  const dur = VOICE_DURATIONS.ride;
  const stack = metallicStack(ctx, 1.4, dur);
  const hp = filter(ctx, 'highpass', 4000, 0.7);
  const e = env(ctx, 0.7, 0.002, 1.5);
  chain(stack, hp, e, out);
  // Bell-ish ping at ~3.5 kHz.
  const ping = osc(ctx, 'sine', 3500);
  const pingEnv = env(ctx, 0.5, 0.001, 0.8);
  chain(ping, pingEnv, out);
  ping.start(0);
  ping.stop(dur);
  const ping2 = osc(ctx, 'sine', 5250);
  const ping2Env = env(ctx, 0.2, 0.001, 0.4);
  chain(ping2, ping2Env, out);
  ping2.start(0);
  ping2.stop(dur);
  // Stick attack.
  const n = noiseSource(ctx, 0.06, 51);
  const nbp = filter(ctx, 'bandpass', 6000, 1);
  const ne = env(ctx, 0.6, 0, 0.03);
  chain(n, nbp, ne, out);
  n.start(0);
};

const crash: Recipe = (ctx, out) => {
  const dur = VOICE_DURATIONS.crash;
  // Bright noise with a slow (15 ms) attack.
  const n = noiseSource(ctx, dur, 61);
  const nhp = filter(ctx, 'highpass', 5000, 0.5);
  const nbp = filter(ctx, 'bandpass', 9000, 0.4);
  // Shimmer: LFO wobbling the bandpass centre.
  const lfo = osc(ctx, 'sine', 5.5);
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 2500;
  lfo.connect(lfoGain);
  lfoGain.connect(nbp.frequency);
  lfo.start(0);
  lfo.stop(dur);
  const ne = env(ctx, 1, 0.015, 2.5);
  chain(n, nhp, nbp, ne, out);
  n.start(0);
  // Metallic stack for the wash.
  const stack = metallicStack(ctx, 1.7, dur);
  const shp = filter(ctx, 'highpass', 5500, 0.7);
  const se = env(ctx, 0.35, 0.01, 2.0);
  chain(stack, shp, se, out);
  // Initial hit.
  const hit = noiseSource(ctx, 0.05, 62);
  const hitEnv = env(ctx, 0.7, 0, 0.03);
  chain(hit, hitEnv, out);
  hit.start(0);
};

export const RECIPES: Record<DrumVoice, Recipe> = {
  kick,
  snare,
  tomHigh: tomRecipe(300, 200, 0.3, VOICE_DURATIONS.tomHigh),
  tomMid: tomRecipe(220, 150, 0.4, VOICE_DURATIONS.tomMid),
  tomLow: tomRecipe(160, 100, 0.6, VOICE_DURATIONS.tomLow),
  hihatClosed: hatRecipe(0.06, VOICE_DURATIONS.hihatClosed, 0.03),
  hihatOpen: hatRecipe(0.5, VOICE_DURATIONS.hihatOpen, 0.25),
  ride,
  crash,
};
