/**
 * Pure DSP / math helpers used by the audio module.
 * No Web Audio here — everything is testable in Node.
 */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const clamp01 = (v: number): number => clamp(v, 0, 1);

/**
 * Map a 0..1 velocity to a linear gain. Slightly convex curve so soft hits are
 * clearly softer and hard hits punch.
 */
export function velocityToGain(velocity: number, curve = 1.5): number {
  const v = clamp01(velocity);
  return Math.pow(v, curve);
}

/** Random pitch factor in ±cents/100 percent (e.g. 0.02 → ±2%). */
export function randomDetune(spread: number, rng: () => number = Math.random): number {
  return 1 + (rng() * 2 - 1) * spread;
}

/** Exponential decay envelope value at time t (seconds) with time constant tau. */
export function expDecay(t: number, tau: number): number {
  return t < 0 ? 0 : Math.exp(-t / tau);
}

/** Time constant such that the envelope reaches -60 dB after `seconds`. */
export function tauFor60dB(seconds: number): number {
  return seconds / 6.9078; // ln(1000)
}

/** Linear attack then exponential decay. */
export function attackDecay(t: number, attack: number, decay: number): number {
  if (t < 0) return 0;
  if (t < attack) return attack <= 0 ? 1 : t / attack;
  return Math.exp(-(t - attack) / tauFor60dB(decay));
}

/** Peak absolute value across channels. */
export function peak(channels: Float32Array[]): number {
  let p = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > p) p = a;
    }
  }
  return p;
}

/** Scale channels in place so the peak equals `target` (no-op for silence). Returns the applied gain. */
export function normalize(channels: Float32Array[], target = 0.9): number {
  const p = peak(channels);
  if (p <= 1e-9) return 1;
  const g = target / p;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  return g;
}

/** tanh soft saturation curve for a WaveShaperNode. `drive` > 1 pushes harder. */
export function makeSaturationCurve(drive = 2, samples = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const norm = Math.tanh(drive);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

/** Deterministic PRNG (mulberry32) for reproducible noise in tests / offline rendering. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fill a Float32Array with white noise in [-1, 1). */
export function whiteNoise(length: number, rng: () => number = Math.random): Float32Array<ArrayBuffer> {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = rng() * 2 - 1;
  return out;
}

/** Apply a linear fade-out over the last `fadeSamples` of each channel (in place). */
export function fadeOutTail(channels: Float32Array[], fadeSamples: number): void {
  for (const ch of channels) {
    const n = Math.min(fadeSamples, ch.length);
    const start = ch.length - n;
    for (let i = 0; i < n; i++) ch[start + i] *= 1 - i / n;
  }
}

/** Metallic partial ratios used for hi-hat / ride / crash stacks (Hz, before multiplier). */
export const METALLIC_FREQS: readonly number[] = [205.3, 304.4, 369.6, 522.7, 540, 800];

// ─────────────────────────── Tempo-map math ───────────────────────────

export interface TempoPoint {
  tick: number;
  time: number;
  bpm: number;
}

/** Convert a tick to seconds using a sorted tempo map (>= 1 entry at tick 0). */
export function tickToSeconds(tick: number, tempoMap: readonly TempoPoint[], ppq: number): number {
  let ev = tempoMap[0];
  for (let i = 1; i < tempoMap.length; i++) {
    if (tempoMap[i].tick <= tick) ev = tempoMap[i];
    else break;
  }
  return ev.time + ((tick - ev.tick) / ppq) * (60 / ev.bpm);
}

/** Convert seconds to a (fractional) tick using a sorted tempo map. */
export function secondsToTick(seconds: number, tempoMap: readonly TempoPoint[], ppq: number): number {
  let ev = tempoMap[0];
  for (let i = 1; i < tempoMap.length; i++) {
    if (tempoMap[i].time <= seconds) ev = tempoMap[i];
    else break;
  }
  return ev.tick + ((seconds - ev.time) / (60 / ev.bpm)) * ppq;
}

export interface BeatEvent {
  tick: number;
  time: number;
  /** True on the first beat of a bar. */
  accent: boolean;
  bar: number;
  beat: number;
}

/**
 * Enumerate beats (as click events) with chart time in [fromTime, toTime) using tempo + time signature maps.
 * Beats are placed on the denominator subdivision (e.g. 4/4 → quarter notes, 6/8 → eighth notes).
 */
export function beatsInRange(
  fromTime: number,
  toTime: number,
  tempoMap: readonly TempoPoint[],
  ppq: number,
  timeSignatures: readonly { tick: number; numerator: number; denominator: number }[],
): BeatEvent[] {
  const out: BeatEvent[] = [];
  if (toTime <= fromTime) return out;
  const sigs = timeSignatures.length ? timeSignatures : [{ tick: 0, numerator: 4, denominator: 4 }];
  const startTick = secondsToTick(fromTime, tempoMap, ppq);
  const endTick = secondsToTick(toTime, tempoMap, ppq);

  let bar = 0;
  for (let s = 0; s < sigs.length; s++) {
    const sig = sigs[s];
    const segEnd = s + 1 < sigs.length ? sigs[s + 1].tick : Infinity;
    const beatTicks = (ppq * 4) / sig.denominator;
    const barTicks = beatTicks * sig.numerator;
    if (sig.tick >= endTick) break;
    if (segEnd <= startTick) {
      // Whole segment is before the range: just count its bars.
      bar += Math.ceil((segEnd - sig.tick) / barTicks);
      continue;
    }
    let barStart = sig.tick;
    if (startTick > barStart) {
      const skip = Math.floor((startTick - barStart) / barTicks);
      barStart += skip * barTicks;
      bar += skip;
    }
    for (; barStart < segEnd && barStart < endTick; barStart += barTicks, bar++) {
      for (let b = 0; b < sig.numerator; b++) {
        const tick = barStart + b * beatTicks;
        if (tick >= segEnd || tick >= endTick) break;
        const time = tickToSeconds(tick, tempoMap, ppq);
        if (time < fromTime) continue;
        if (time >= toTime) break;
        out.push({ tick, time, accent: b === 0, bar, beat: b });
      }
    }
    if (segEnd !== Infinity && barStart < segEnd) bar += Math.ceil((segEnd - barStart) / barTicks);
  }
  return out;
}

/** Given a look-ahead window, select notes with time in [from, to) starting at index `cursor` (notes sorted by time). */
export function collectWindow<T extends { time: number }>(
  notes: readonly T[],
  cursor: number,
  from: number,
  to: number,
): { items: T[]; cursor: number } {
  const items: T[] = [];
  let i = cursor;
  while (i < notes.length && notes[i].time < from) i++;
  while (i < notes.length && notes[i].time < to) {
    items.push(notes[i]);
    i++;
  }
  return { items, cursor: i };
}

/** Binary search: first index with notes[i].time >= t. */
export function lowerBound<T extends { time: number }>(notes: readonly T[], t: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
