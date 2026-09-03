#!/usr/bin/env node
/**
 * DRUMKILLER demo-song generator.
 *
 * Synthesizes two complete drum-less backing tracks plus GM drum charts into
 *   public/songs/<slug>/{song.json, audio.wav, expert.mid}
 * and writes public/songs/index.json.
 *
 * Pure Node ESM, zero dependencies. Run: node scripts/make-demo-song.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.resolve(__dirname, '..', 'public', 'songs');

const SR = 44100;
const PPQ = 480;
const OFFSET_SECONDS = 1.0; // silence before chart tick 0
const TAIL_SECONDS = 3.0; // reverb-ish tail + fade after the last bar

// GM drum map (channel 10).
const GM = {
  kick: 36,
  snare: 38,
  tomHigh: 50,
  tomMid: 47,
  tomLow: 45,
  hihatClosed: 42,
  hihatOpen: 46,
  ride: 51,
  crash: 49,
};

// ═══════════════════════════════════════════════════════════════════════════
//  MIDI writer / reader
// ═══════════════════════════════════════════════════════════════════════════

function varlen(n) {
  const bytes = [n & 0x7f];
  n >>>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  return bytes;
}

function u32be(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u16be(n) {
  return [(n >>> 8) & 0xff, n & 0xff];
}
function ascii(s) {
  return [...s].map((c) => c.charCodeAt(0));
}

/** events: [{tick, bytes:number[]}] (bytes = full message w/o delta). Adds end-of-track. */
function encodeTrack(events) {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out = [];
  let last = 0;
  for (const ev of sorted) {
    out.push(...varlen(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  out.push(...varlen(0), 0xff, 0x2f, 0x00);
  return [...ascii('MTrk'), ...u32be(out.length), ...out];
}

function metaEvent(type, data) {
  return [0xff, type, ...varlen(data.length), ...data];
}

/**
 * Build a format-1 MIDI file.
 * notes: [{tick, note, velocity(0..1), durationTicks}] on channel 9.
 */
function buildMidi({ bpm, notes, name }) {
  const tempoTrack = [
    { tick: 0, order: 0, bytes: metaEvent(0x03, ascii(`${name} (tempo)`)) },
    { tick: 0, order: 1, bytes: metaEvent(0x58, [4, 2, 24, 8]) },
    { tick: 0, order: 2, bytes: metaEvent(0x51, u32be(Math.round(60_000_000 / bpm)).slice(1)) },
  ];
  const drumTrack = [{ tick: 0, order: 0, bytes: metaEvent(0x03, ascii('Drums')) }];
  let order = 1;
  for (const n of notes) {
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
    drumTrack.push({ tick: n.tick, order: order + 1, bytes: [0x99, n.note, vel] });
    drumTrack.push({ tick: n.tick + n.durationTicks, order: order, bytes: [0x89, n.note, 0] });
    order += 2;
  }
  const header = [...ascii('MThd'), ...u32be(6), ...u16be(1), ...u16be(2), ...u16be(PPQ)];
  return Uint8Array.from([...header, ...encodeTrack(tempoTrack), ...encodeTrack(drumTrack)]);
}

/** Minimal parser used as a sanity check: returns { ppq, tracks, noteOns, tempoBpm, lastTick, byNote }. */
function inspectMidi(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
  if (str(0, 4) !== 'MThd') throw new Error('bad MThd');
  const ntracks = dv.getUint16(10);
  const ppq = dv.getUint16(12);
  let pos = 14;
  let noteOns = 0;
  let tempoBpm = 0;
  let lastTick = 0;
  const byNote = {};
  for (let t = 0; t < ntracks; t++) {
    if (str(pos, 4) !== 'MTrk') throw new Error('bad MTrk');
    const len = dv.getUint32(pos + 4);
    let p = pos + 8;
    const end = p + len;
    let tick = 0;
    let running = 0;
    while (p < end) {
      let d = 0;
      let b;
      do {
        b = bytes[p++];
        d = (d << 7) | (b & 0x7f);
      } while (b & 0x80);
      tick += d;
      let status = bytes[p];
      if (status & 0x80) p++;
      else status = running;
      if (status === 0xff) {
        const type = bytes[p++];
        let l = 0;
        do {
          b = bytes[p++];
          l = (l << 7) | (b & 0x7f);
        } while (b & 0x80);
        if (type === 0x51) tempoBpm = 60_000_000 / ((bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2]);
        p += l;
      } else if (status === 0xf0 || status === 0xf7) {
        let l = 0;
        do {
          b = bytes[p++];
          l = (l << 7) | (b & 0x7f);
        } while (b & 0x80);
        p += l;
      } else {
        running = status;
        const hi = status & 0xf0;
        const d1 = bytes[p++];
        const d2 = hi === 0xc0 || hi === 0xd0 ? 0 : bytes[p++];
        if (hi === 0x90 && d2 > 0) {
          noteOns++;
          byNote[d1] = (byNote[d1] || 0) + 1;
          lastTick = Math.max(lastTick, tick);
        }
      }
    }
    pos = end;
  }
  return { ppq, tracks: ntracks, noteOns, tempoBpm, lastTick, byNote };
}

// ═══════════════════════════════════════════════════════════════════════════
//  WAV writer
// ═══════════════════════════════════════════════════════════════════════════

function encodeWav16(left, right, sampleRate) {
  const frames = left.length;
  const dataSize = frames * 4;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    buf.writeInt16LE(Math.round(l < 0 ? l * 32768 : l * 32767), o);
    buf.writeInt16LE(Math.round(r < 0 ? r * 32768 : r * 32767), o + 2);
    o += 4;
  }
  return buf;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Synth toolkit
// ═══════════════════════════════════════════════════════════════════════════

const TWO_PI = Math.PI * 2;
const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

/** Deterministic PRNG so output is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(1337);

// ─── Band-limited wavetables ─────────────────────────────────────────────────
const TABLE_SIZE = 2048;
const tableCache = new Map();
function wavetable(type, harmonics) {
  const key = `${type}:${harmonics}`;
  let t = tableCache.get(key);
  if (t) return t;
  t = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) {
    const ph = (i / TABLE_SIZE) * TWO_PI;
    let v = 0;
    for (let h = 1; h <= harmonics; h++) {
      if (type === 'saw') v += Math.sin(ph * h) / h;
      else if (type === 'square') {
        if (h % 2 === 1) v += Math.sin(ph * h) / h;
      } else if (type === 'triangle') {
        if (h % 2 === 1) v += (Math.pow(-1, (h - 1) / 2) * Math.sin(ph * h)) / (h * h);
      }
    }
    t[i] = v;
  }
  // Normalise to ±1.
  let p = 0;
  for (let i = 0; i < TABLE_SIZE; i++) p = Math.max(p, Math.abs(t[i]));
  for (let i = 0; i < TABLE_SIZE; i++) t[i] /= p;
  tableCache.set(key, t);
  return t;
}
function tableFor(type, freq) {
  const maxH = Math.max(1, Math.floor(SR / 2 / freq));
  let h = 1;
  while (h * 2 <= maxH && h < 64) h *= 2;
  return wavetable(type, h);
}

/** Read a wavetable at phase [0,1). */
function readTable(t, phase) {
  const x = (phase - Math.floor(phase)) * TABLE_SIZE;
  const i = x | 0;
  const f = x - i;
  const a = t[i];
  const b = t[(i + 1) & (TABLE_SIZE - 1)];
  return a + (b - a) * f;
}

// ─── Envelopes ──────────────────────────────────────────────────────────────
/** ADSR: attack/decay/release in seconds, sustain 0..1, gate length in seconds. Returns fn(t). */
function adsr(a, d, s, r, gate) {
  return (t) => {
    if (t < 0) return 0;
    let v;
    if (t < a) v = t / a;
    else if (t < a + d) v = 1 - (1 - s) * ((t - a) / d);
    else v = s;
    if (t > gate) {
      const g = gate < a ? gate / a : gate < a + d ? 1 - (1 - s) * ((gate - a) / d) : s;
      v = g * Math.max(0, 1 - (t - gate) / r);
    }
    return v;
  };
}
const expDecay = (t, tau) => (t < 0 ? 0 : Math.exp(-t / tau));

// ─── State-variable lowpass (Chamberlin) ────────────────────────────────────
class SVF {
  constructor() {
    this.low = 0;
    this.band = 0;
  }
  /** cutoff Hz, q 0.5..~5 */
  process(x, cutoff, q) {
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff, SR * 0.22)) / SR);
    const damp = 1 / Math.max(q, 0.5);
    this.low += f * this.band;
    const high = x - this.low - damp * this.band;
    this.band += f * high;
    this.low += f * this.band;
    const high2 = x - this.low - damp * this.band;
    this.band += f * high2;
    return this.low;
  }
}

// ─── Mixer / buses ──────────────────────────────────────────────────────────
class Bus {
  constructor(seconds) {
    const n = Math.ceil(seconds * SR);
    this.L = new Float32Array(n);
    this.R = new Float32Array(n);
    this.length = n;
  }
  /** Mix a mono Float32Array at startSec with gain and pan (-1..1). */
  add(mono, startSec, gain = 1, pan = 0) {
    const start = Math.round(startSec * SR);
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    const n = Math.min(mono.length, this.length - start);
    for (let i = 0; i < n; i++) {
      const s = mono[i];
      this.L[start + i] += s * gl;
      this.R[start + i] += s * gr;
    }
  }
  addStereo(other, gain = 1) {
    for (let i = 0; i < this.length; i++) {
      this.L[i] += other.L[i] * gain;
      this.R[i] += other.R[i] * gain;
    }
  }
}

// ─── Effects ────────────────────────────────────────────────────────────────
/** Stereo ping-pong delay applied in place. */
function pingPongDelay(bus, delaySec, feedback, wet) {
  const d = Math.round(delaySec * SR);
  const bufL = new Float32Array(d);
  const bufR = new Float32Array(d);
  let idx = 0;
  const outL = new Float32Array(bus.length);
  const outR = new Float32Array(bus.length);
  for (let i = 0; i < bus.length; i++) {
    const dl = bufL[idx];
    const dr = bufR[idx];
    // cross-feed: left delay feeds right and vice-versa
    bufL[idx] = bus.L[i] * 0.7 + dr * feedback;
    bufR[idx] = bus.R[i] * 0.7 + dl * feedback;
    outL[i] = bus.L[i] + dl * wet;
    outR[i] = bus.R[i] + dr * wet;
    idx = (idx + 1) % d;
  }
  bus.L = outL;
  bus.R = outR;
}

/** Schroeder reverb: 4 parallel combs + 2 series allpass per channel. Returns a new wet Bus. */
function reverb(bus, decay = 0.82, damp = 0.25) {
  const combs = [1557, 1617, 1491, 1422];
  const allpasses = [225, 556];
  const wet = new Bus(bus.length / SR);
  for (const [src, dst, spread] of [
    [bus.L, wet.L, 0],
    [bus.R, wet.R, 23],
  ]) {
    const cb = combs.map((n) => ({ buf: new Float32Array(n + spread), i: 0, lp: 0 }));
    const ap = allpasses.map((n) => ({ buf: new Float32Array(n + spread), i: 0 }));
    for (let n = 0; n < src.length; n++) {
      const x = src[n];
      let y = 0;
      for (const c of cb) {
        const out = c.buf[c.i];
        c.lp = out * (1 - damp) + c.lp * damp;
        c.buf[c.i] = x + c.lp * decay;
        c.i = (c.i + 1) % c.buf.length;
        y += out;
      }
      y *= 0.25;
      for (const a of ap) {
        const bufOut = a.buf[a.i];
        const v = y + bufOut * 0.5;
        a.buf[a.i] = v;
        a.i = (a.i + 1) % a.buf.length;
        y = bufOut - v * 0.5;
      }
      dst[n] = y;
    }
  }
  return wet;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Instruments — each returns a mono Float32Array for one note.
// ═══════════════════════════════════════════════════════════════════════════

/** Warm synthwave pad: 3 detuned saws through a slow lowpass, long attack/release. */
function padNote(midi, dur, vel = 1) {
  const f = midiHz(midi);
  const rel = 1.2;
  const n = Math.ceil((dur + rel) * SR);
  const out = new Float32Array(n);
  const env = adsr(0.8, 0.5, 0.8, rel, dur);
  const tabs = [tableFor('saw', f), tableFor('saw', f * 1.004), tableFor('saw', f * 0.996)];
  const ph = [0, 0.33, 0.66];
  const inc = [f / SR, (f * 1.004) / SR, (f * 0.996) / SR];
  const filt = new SVF();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (let k = 0; k < 3; k++) {
      s += readTable(tabs[k], ph[k]);
      ph[k] += inc[k];
    }
    const cutoff = 400 + 1400 * env(t) + 300 * Math.sin(TWO_PI * 0.15 * t);
    out[i] = filt.process(s / 3, cutoff, 0.8) * env(t) * vel;
  }
  return out;
}

/** Plucky arp: pulse-ish saw with a snappy filter envelope. */
function arpNote(midi, dur, vel = 1) {
  const f = midiHz(midi);
  const n = Math.ceil((dur + 0.15) * SR);
  const out = new Float32Array(n);
  const env = adsr(0.003, 0.12, 0.35, 0.15, dur);
  const tab = tableFor('saw', f);
  const tab2 = tableFor('square', f);
  let ph = 0;
  let ph2 = 0.25;
  const inc = f / SR;
  const filt = new SVF();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const s = readTable(tab, ph) * 0.7 + readTable(tab2, ph2) * 0.3;
    ph += inc;
    ph2 += inc * 1.002;
    const cutoff = 600 + 4500 * expDecay(t, 0.09) * vel;
    out[i] = filt.process(s, cutoff, 1.6) * env(t) * vel;
  }
  return out;
}

/** Synthwave bass: saw + sub sine, punchy filter env. */
function synthBassNote(midi, dur, vel = 1) {
  const f = midiHz(midi);
  const n = Math.ceil((dur + 0.08) * SR);
  const out = new Float32Array(n);
  const env = adsr(0.004, 0.15, 0.7, 0.08, dur);
  const tab = tableFor('saw', f);
  let ph = 0;
  let phs = 0;
  const filt = new SVF();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const s = readTable(tab, ph) * 0.6 + Math.sin(TWO_PI * phs) * 0.6;
    ph += f / SR;
    phs += (f / 2) / SR;
    const cutoff = 150 + 1800 * expDecay(t, 0.12) * vel + 200 * vel;
    out[i] = Math.tanh(filt.process(s, cutoff, 1.2) * 1.8) * env(t) * vel;
  }
  return out;
}

/** Chord stab: bright saw with medium decay. */
function stabNote(midi, dur, vel = 1) {
  const f = midiHz(midi);
  const n = Math.ceil((dur + 0.2) * SR);
  const out = new Float32Array(n);
  const env = adsr(0.005, 0.25, 0.5, 0.2, dur);
  const tabs = [tableFor('saw', f), tableFor('saw', f * 1.006)];
  let ph = 0;
  let ph2 = 0.5;
  const filt = new SVF();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const s = (readTable(tabs[0], ph) + readTable(tabs[1], ph2)) * 0.5;
    ph += f / SR;
    ph2 += (f * 1.006) / SR;
    const cutoff = 500 + 3500 * expDecay(t, 0.2) * vel;
    out[i] = filt.process(s, cutoff, 1.0) * env(t) * vel;
  }
  return out;
}

/** Lead: saw with vibrato and a gentle glide-in. */
function leadNote(midi, dur, vel = 1) {
  const f = midiHz(midi);
  const n = Math.ceil((dur + 0.25) * SR);
  const out = new Float32Array(n);
  const env = adsr(0.02, 0.2, 0.75, 0.25, dur);
  const tab = tableFor('saw', f);
  const tab2 = tableFor('square', f);
  let ph = 0;
  let ph2 = 0;
  const filt = new SVF();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const vib = 1 + 0.006 * Math.sin(TWO_PI * 5.5 * t) * Math.min(1, t / 0.25);
    const glide = 1 - 0.03 * Math.exp(-t / 0.03);
    const fi = f * vib * glide;
    const s = readTable(tab, ph) * 0.65 + readTable(tab2, ph2) * 0.35;
    ph += fi / SR;
    ph2 += (fi * 0.5) / SR;
    const cutoff = 1200 + 2500 * env(t);
    out[i] = filt.process(s, cutoff, 0.9) * env(t) * vel;
  }
  return out;
}

/** Rhodes-ish electric piano: detuned sines + tine partial + tremolo, exponential decay. */
function rhodesNote(midi, dur, vel = 1) {
  const f = midiHz(midi);
  const rel = 0.35;
  const n = Math.ceil((dur + rel) * SR);
  const out = new Float32Array(n);
  const gateEnv = adsr(0.004, 0.0, 1, rel, dur);
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  let p4 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const body = expDecay(t, 1.4);
    const tine = expDecay(t, 0.12) * vel * 0.9;
    const bark = expDecay(t, 0.03) * vel;
    const s =
      Math.sin(TWO_PI * p1) * body +
      Math.sin(TWO_PI * p2) * body * 0.25 +
      Math.sin(TWO_PI * p3) * tine * 0.35 +
      Math.sin(TWO_PI * p4) * bark * 0.15;
    p1 += f / SR;
    p2 += (f * 1.003) / SR;
    p3 += (f * 4) / SR; // tine partial
    p4 += (f * 7.02) / SR; // bark
    const trem = 1 - 0.18 * (0.5 + 0.5 * Math.sin(TWO_PI * 4.8 * t));
    out[i] = Math.tanh(s * (0.8 + 0.6 * vel)) * gateEnv(t) * trem * vel * 0.8;
  }
  return out;
}

/** Slap-style bass: sine + triangle, very fast attack, a bit of grit, slap click on hard hits. */
function slapBassNote(midi, dur, vel = 1) {
  const f = midiHz(midi);
  const rel = 0.05;
  const n = Math.ceil((dur + rel) * SR);
  const out = new Float32Array(n);
  const env = adsr(0.002, 0.18, 0.55, rel, dur);
  const tri = tableFor('triangle', f);
  const saw = tableFor('saw', f);
  let ph = 0;
  let ph2 = 0;
  const filt = new SVF();
  const slap = vel > 0.8;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = Math.sin(TWO_PI * ph) * 0.7 + readTable(tri, ph) * 0.5 + readTable(saw, ph2) * 0.25 * expDecay(t, 0.15);
    ph += f / SR;
    ph2 += (f * 2.0) / SR;
    if (slap && t < 0.03) s += (rand() * 2 - 1) * expDecay(t, 0.006) * 0.8;
    const cutoff = 250 + 2600 * expDecay(t, 0.07) * vel;
    out[i] = Math.tanh(filt.process(s, cutoff, 1.5) * 1.6) * env(t) * vel;
  }
  return out;
}

/** Breathy lead for the funk tune: sine + soft square, vibrato. */
function fluteNote(midi, dur, vel = 1) {
  const f = midiHz(midi);
  const rel = 0.2;
  const n = Math.ceil((dur + rel) * SR);
  const out = new Float32Array(n);
  const env = adsr(0.04, 0.1, 0.8, rel, dur);
  const sq = tableFor('square', f);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const vib = 1 + 0.008 * Math.sin(TWO_PI * 5 * t) * Math.min(1, t / 0.3);
    const s = Math.sin(TWO_PI * ph) * 0.8 + readTable(sq, ph) * 0.2 + (rand() * 2 - 1) * 0.02;
    ph += (f * vib) / SR;
    out[i] = s * env(t) * vel;
  }
  return out;
}

/** Clav-ish stab: square through a resonant filter, very short. */
function clavNote(midi, dur, vel = 1) {
  const f = midiHz(midi);
  const n = Math.ceil((dur + 0.05) * SR);
  const out = new Float32Array(n);
  const env = adsr(0.002, 0.1, 0.3, 0.05, dur);
  const sq = tableFor('square', f);
  let ph = 0;
  const filt = new SVF();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const s = readTable(sq, ph);
    ph += f / SR;
    const cutoff = 800 + 3000 * expDecay(t, 0.05) * vel;
    out[i] = filt.process(s, cutoff, 2.5) * env(t) * vel;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Music helpers
// ═══════════════════════════════════════════════════════════════════════════

const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
/** 'A2' → midi 45 */
function n(name) {
  const m = /^([A-G]#?)(-?\d)$/.exec(name);
  return NOTE[m[1]] + (parseInt(m[2], 10) + 1) * 12;
}

/** Song-time context: beat → seconds (including the leading offset). */
function makeClock(bpm) {
  const beatSec = 60 / bpm;
  return {
    bpm,
    beatSec,
    barSec: beatSec * 4,
    /** seconds in the audio file for a chart beat */
    sec: (beat) => OFFSET_SECONDS + beat * beatSec,
    /** seconds for a number of beats */
    len: (beats) => beats * beatSec,
    tick: (beat) => Math.round(beat * PPQ),
  };
}

class DrumChart {
  constructor(clock) {
    this.clock = clock;
    this.notes = [];
  }
  /** Add a hit at chart beat (may be fractional). Velocity 0..1. */
  hit(voice, beat, velocity = 0.9, tickOffset = 0) {
    this.notes.push({ tick: this.clock.tick(beat) + tickOffset, note: GM[voice], voice, velocity, durationTicks: 60 });
  }
  finalize() {
    // Sort, and de-duplicate same voice on the same tick (keep the loudest).
    this.notes.sort((a, b) => a.tick - b.tick || a.note - b.note);
    const out = [];
    for (const x of this.notes) {
      const prev = out[out.length - 1];
      if (prev && prev.tick === x.tick && prev.note === x.note) {
        prev.velocity = Math.max(prev.velocity, x.velocity);
      } else out.push(x);
    }
    this.notes = out;
    return out;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Song 1 — NEON OVERDRIVE (128 BPM, A minor, synthwave / rock)
// ═══════════════════════════════════════════════════════════════════════════

function buildNeonOverdrive() {
  const BPM = 128;
  const clock = makeClock(BPM);
  const { sec, len } = clock;

  // ── Arrangement (bars) ──
  const SECTIONS = [
    { name: 'intro', bars: 8 },
    { name: 'verse', bars: 16 },
    { name: 'chorus', bars: 16 },
    { name: 'breakdown', bars: 8 },
    { name: 'chorus2', bars: 8 },
    { name: 'outro', bars: 2 },
  ];
  let barCursor = 0;
  for (const s of SECTIONS) {
    s.start = barCursor;
    barCursor += s.bars;
  }
  const TOTAL_BARS = barCursor;
  const totalSeconds = OFFSET_SECONDS + TOTAL_BARS * clock.barSec + TAIL_SECONDS;

  // Chords: [root midi, quality] — chord tones for arp/pads.
  const CH = {
    Am: { root: n('A2'), tones: [n('A3'), n('C4'), n('E4')], pad: [n('A2'), n('E3'), n('A3'), n('C4'), n('E4')] },
    F: { root: n('F2'), tones: [n('F3'), n('A3'), n('C4')], pad: [n('F2'), n('C3'), n('F3'), n('A3'), n('C4')] },
    C: { root: n('C3'), tones: [n('G3'), n('C4'), n('E4')], pad: [n('C3'), n('G3'), n('C4'), n('E4'), n('G4')] },
    G: { root: n('G2'), tones: [n('G3'), n('B3'), n('D4')], pad: [n('G2'), n('D3'), n('G3'), n('B3'), n('D4')] },
    E: { root: n('E2'), tones: [n('E3'), n('G#3'), n('B3')], pad: [n('E2'), n('B2'), n('E3'), n('G#3'), n('B3')] },
    Dm: { root: n('D3'), tones: [n('F3'), n('A3'), n('D4')], pad: [n('D3'), n('A3'), n('D4'), n('F4'), n('A4')] },
  };
  // Chord per bar for each section.
  const introProg = ['Am', 'Am', 'F', 'F', 'C', 'C', 'G', 'G'];
  const verseProg = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G', 'Dm', 'F', 'E', 'E'];
  const chorusProg = ['F', 'G', 'Am', 'Am', 'F', 'G', 'C', 'E', 'F', 'G', 'Am', 'Am', 'F', 'G', 'C', 'E'];
  const breakProg = ['Am', 'Am', 'Am', 'Am', 'F', 'F', 'F', 'E'];
  const chorus2Prog = ['F', 'G', 'Am', 'Am', 'F', 'G', 'C', 'E'];
  const outroProg = ['Am', 'Am'];
  const barChords = [...introProg, ...verseProg, ...chorusProg, ...breakProg, ...chorus2Prog, ...outroProg];
  const chordAt = (bar) => CH[barChords[Math.min(bar, barChords.length - 1)]];
  const sectionOf = (bar) => SECTIONS.find((s) => bar >= s.start && bar < s.start + s.bars)?.name ?? 'outro';

  // ── Buses ──
  const padBus = new Bus(totalSeconds);
  const arpBus = new Bus(totalSeconds);
  const bassBus = new Bus(totalSeconds);
  const stabBus = new Bus(totalSeconds);
  const leadBus = new Bus(totalSeconds);

  // ── Pads (every bar, sustained across identical chords) ──
  for (let bar = 0; bar < TOTAL_BARS; ) {
    const ch = chordAt(bar);
    let span = 1;
    while (bar + span < TOTAL_BARS && chordAt(bar + span) === ch && span < 4) span++;
    const sect = sectionOf(bar);
    const g = sect === 'intro' ? 0.5 : sect === 'breakdown' ? 0.6 : sect === 'verse' ? 0.35 : 0.45;
    const dur = len(span * 4) - 0.05;
    ch.pad.forEach((m, i) => padBus.add(padNote(m, dur, 0.5), sec(bar * 4), g * (i === 0 ? 0.7 : 0.55), (i % 2 ? 0.4 : -0.4) * 0.6));
    bar += span;
  }

  // ── Arp: 16th notes over chord tones, pattern up-down over two octaves ──
  for (let bar = 0; bar < TOTAL_BARS; bar++) {
    const sect = sectionOf(bar);
    if (sect === 'outro') break;
    const ch = chordAt(bar);
    const tones = [...ch.tones, ...ch.tones.map((m) => m + 12)];
    const pattern = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 2, 4, 5, 3, 1];
    const gain = sect === 'intro' ? 0.35 : sect === 'breakdown' ? 0.22 : sect.startsWith('chorus') ? 0.32 : 0.3;
    for (let s = 0; s < 16; s++) {
      if (sect === 'intro' && bar < 2 && s % 2 === 1) continue; // sparser start
      const beat = bar * 4 + s / 4;
      const vel = s % 4 === 0 ? 1 : s % 2 === 0 ? 0.8 : 0.65;
      const midi = tones[pattern[s]] + (sect === 'breakdown' ? -12 : 0);
      arpBus.add(arpNote(midi, len(0.25) * 0.9, vel), sec(beat), gain, s % 2 ? 0.35 : -0.35);
    }
  }

  // ── Bass: driving 8ths with octave pops; sustained in breakdown ──
  for (let bar = 0; bar < TOTAL_BARS; bar++) {
    const sect = sectionOf(bar);
    if (sect === 'intro' && bar < 4) continue;
    const ch = chordAt(bar);
    const root = ch.root;
    if (sect === 'breakdown') {
      bassBus.add(synthBassNote(root, len(4) - 0.05, 0.7), sec(bar * 4), 0.6);
      continue;
    }
    if (sect === 'outro') {
      bassBus.add(synthBassNote(root, len(8), 0.9), sec(bar * 4), 0.7);
      break;
    }
    for (let e = 0; e < 8; e++) {
      const beat = bar * 4 + e / 2;
      const isOct = e === 3 || e === 7;
      const midi = isOct ? root + 12 : root;
      const vel = e === 0 ? 1 : e % 2 === 0 ? 0.85 : 0.7;
      const dur = len(0.5) * (e === 7 ? 0.6 : 0.85);
      bassBus.add(synthBassNote(midi, dur, vel), sec(beat), 0.62);
    }
  }

  // ── Chord stabs: off-beat pushes in verse, big hits in chorus ──
  for (let bar = 0; bar < TOTAL_BARS; bar++) {
    const sect = sectionOf(bar);
    const ch = chordAt(bar);
    const voicing = ch.pad.slice(1);
    if (sect === 'verse') {
      // "and of 2" and "and of 4" stabs
      for (const off of [1.5, 3.5]) {
        voicing.forEach((m, i) => stabBus.add(stabNote(m, len(0.4), 0.8), sec(bar * 4 + off), 0.2, (i % 2 ? 1 : -1) * 0.3));
      }
    } else if (sect.startsWith('chorus')) {
      // beat 1 (long), and of 2, beat 4
      for (const [off, d, v] of [
        [0, 1.4, 1],
        [1.5, 0.45, 0.8],
        [3, 0.9, 0.85],
      ]) {
        voicing.forEach((m, i) => stabBus.add(stabNote(m, len(d), v), sec(bar * 4 + off), 0.24, (i % 2 ? 1 : -1) * 0.35));
      }
    } else if (sect === 'outro') {
      voicing.forEach((m, i) => stabBus.add(stabNote(m, len(8), 1), sec(bar * 4), 0.26, (i % 2 ? 1 : -1) * 0.35));
      break;
    }
  }

  // ── Lead melody (choruses). [beatOffset within 8 bars, midi, durationBeats] ──
  const A4 = n('A4'), B4 = n('B4'), C5 = n('C5'), D5 = n('D5'), E5 = n('E5'), F5 = n('F5'), G5 = n('G5'), G4 = n('G4'), E4 = n('E4');
  const phrase = [
    // bar 1 (F)
    [0, A4, 0.75], [1, C5, 0.5], [1.5, D5, 0.5], [2, E5, 1.5],
    // bar 2 (G)
    [4, D5, 0.5], [4.5, E5, 0.5], [5, D5, 0.5], [5.5, B4, 1.5], [7, G4, 1],
    // bar 3–4 (Am)
    [8, A4, 0.75], [9, C5, 0.5], [9.5, E5, 0.5], [10, A4, 0.5], [10.5, C5, 0.5], [11, E5, 1], [12, D5, 0.5], [12.5, C5, 0.5], [13, B4, 0.5], [13.5, A4, 2],
    // bar 5 (F)
    [16, F5, 0.75], [17, E5, 0.5], [17.5, D5, 0.5], [18, C5, 1.5],
    // bar 6 (G)
    [20, D5, 0.5], [20.5, E5, 0.5], [21, G5, 1], [22.5, E5, 0.5], [23, D5, 1],
    // bar 7 (C)
    [24, E5, 0.75], [25, G5, 0.5], [25.5, E5, 0.5], [26, C5, 1.5],
    // bar 8 (E)
    [28, B4, 0.75], [29, E4 + 12, 0.5], [29.5, D5, 0.5], [30, B4, 2],
  ];
  const chorusStarts = SECTIONS.filter((s) => s.name.startsWith('chorus')).flatMap((s) => {
    const starts = [];
    for (let b = s.start; b < s.start + s.bars; b += 8) starts.push(b);
    return starts;
  });
  for (const startBar of chorusStarts) {
    for (const [off, midi, d] of phrase) {
      leadBus.add(leadNote(midi, len(d) - 0.03, 0.9), sec(startBar * 4 + off), 0.3, 0.1);
    }
  }
  // Breakdown: a quiet echoing lead motif
  const bd = SECTIONS.find((s) => s.name === 'breakdown');
  for (const [off, midi, d] of [[0, E5, 1], [1.5, C5, 0.5], [2, A4, 2], [8, E5, 1], [9.5, D5, 0.5], [10, C5, 1], [11, B4, 3]]) {
    for (const rep of [0, 16]) leadBus.add(leadNote(midi, len(d), 0.6), sec(bd.start * 4 + rep + off), 0.16, -0.2);
  }

  // ── Effects & mix ──
  pingPongDelay(arpBus, clock.beatSec * 0.75, 0.35, 0.28);
  pingPongDelay(leadBus, clock.beatSec * 0.75, 0.45, 0.4);
  const master = new Bus(totalSeconds);
  master.addStereo(padBus, 1);
  master.addStereo(arpBus, 1);
  master.addStereo(bassBus, 1);
  master.addStereo(stabBus, 1);
  master.addStereo(leadBus, 1);
  const send = new Bus(totalSeconds);
  send.addStereo(padBus, 0.35);
  send.addStereo(stabBus, 0.5);
  send.addStereo(leadBus, 0.5);
  send.addStereo(arpBus, 0.15);
  master.addStereo(reverb(send, 0.84, 0.3), 0.35);

  // ── Drum chart ──
  const chart = new DrumChart(clock);
  const b = (bar, beat) => bar * 4 + beat;
  const fill = (bar, kind) => {
    // kind: 'short' = last beat, 'long' = last 2 beats
    if (kind === 'short') {
      chart.hit('tomHigh', b(bar, 3), 0.85);
      chart.hit('tomHigh', b(bar, 3.25), 0.7);
      chart.hit('tomMid', b(bar, 3.5), 0.85);
      chart.hit('tomLow', b(bar, 3.75), 0.95);
    } else {
      chart.hit('snare', b(bar, 2), 0.9);
      chart.hit('snare', b(bar, 2.25), 0.6);
      chart.hit('snare', b(bar, 2.5), 0.8);
      chart.hit('tomHigh', b(bar, 2.75), 0.8);
      chart.hit('tomHigh', b(bar, 3), 0.9);
      chart.hit('tomMid', b(bar, 3.25), 0.85);
      chart.hit('tomMid', b(bar, 3.5), 0.85);
      chart.hit('tomLow', b(bar, 3.75), 1);
    }
  };
  const sectionStarts = new Set(SECTIONS.map((s) => s.start));
  for (let bar = 0; bar < TOTAL_BARS; bar++) {
    const sect = sectionOf(bar);
    const inSection = bar - SECTIONS.find((s) => s.name === sect).start;
    const sectionLen = SECTIONS.find((s) => s.name === sect).bars;
    const isLastBar = inSection === sectionLen - 1;
    const isChorus = sect.startsWith('chorus');

    if (sect === 'outro') {
      if (inSection === 0) {
        chart.hit('crash', b(bar, 0), 1);
        chart.hit('kick', b(bar, 0), 1);
      }
      if (inSection === 1) {
        chart.hit('crash', b(bar, 2), 0.9);
        chart.hit('kick', b(bar, 2), 0.95);
      }
      continue;
    }

    if (sect === 'intro') {
      if (bar < 4) {
        // Sparse: a few kicks to feel the pulse.
        chart.hit('kick', b(bar, 0), 0.7);
        if (bar === 3) {
          chart.hit('kick', b(bar, 2), 0.7);
          chart.hit('snare', b(bar, 3), 0.75);
          chart.hit('snare', b(bar, 3.5), 0.85);
        }
        continue;
      }
      for (let e = 0; e < 8; e++) chart.hit('hihatClosed', b(bar, e / 2), e % 2 ? 0.5 : 0.75);
      chart.hit('kick', b(bar, 0), 0.9);
      chart.hit('kick', b(bar, 2), 0.85);
      chart.hit('snare', b(bar, 1), 0.85);
      chart.hit('snare', b(bar, 3), 0.9);
      if (isLastBar) fill(bar, 'long');
      continue;
    }

    // Crash on section changes.
    if (sectionStarts.has(bar)) chart.hit('crash', b(bar, 0), 1);

    // Hats / ride.
    if (sect === 'breakdown') {
      for (let e = 0; e < 8; e++) chart.hit('ride', b(bar, e / 2), e % 2 ? 0.55 : e === 0 ? 0.9 : 0.75);
    } else {
      for (let e = 0; e < 8; e++) {
        const beat = e / 2;
        if (isChorus && e === 7 && !isLastBar) chart.hit('hihatOpen', b(bar, beat), 0.85);
        else if (isChorus && inSection % 4 === 3 && e >= 6) continue; // room for fills
        else if (!(isLastBar && e >= 4)) chart.hit('hihatClosed', b(bar, beat), e % 2 ? 0.55 : e === 0 ? 0.9 : 0.75);
      }
    }

    // Kick.
    chart.hit('kick', b(bar, 0), 1);
    chart.hit('kick', b(bar, 2), 0.9);
    if (sect === 'verse') {
      if (inSection % 2 === 0) chart.hit('kick', b(bar, 2.5), 0.8);
      else chart.hit('kick', b(bar, 3.5), 0.85);
    } else if (isChorus) {
      chart.hit('kick', b(bar, 1.5), 0.8);
      if (inSection % 2 === 1) chart.hit('kick', b(bar, 3.5), 0.85);
    } else if (sect === 'breakdown') {
      if (inSection % 2 === 1) chart.hit('kick', b(bar, 3.5), 0.7);
    }

    // Snare.
    chart.hit('snare', b(bar, 1), sect === 'breakdown' ? 0.75 : 0.9);
    if (!(isLastBar && sect !== 'breakdown')) chart.hit('snare', b(bar, 3), sect === 'breakdown' ? 0.75 : 0.95);
    if (sect === 'verse') {
      if (inSection % 4 === 1) chart.hit('snare', b(bar, 1.75), 0.3);
      if (inSection % 4 === 2) chart.hit('snare', b(bar, 3.25), 0.28);
      if (inSection % 4 === 3) {
        chart.hit('snare', b(bar, 1.75), 0.3);
        chart.hit('snare', b(bar, 2.25), 0.28);
      }
    }

    // Fills.
    if (isLastBar) fill(bar, 'long');
    else if (isChorus && inSection % 4 === 3) fill(bar, 'short');
    else if (sect === 'verse' && inSection === 7) fill(bar, 'short');
  }

  return {
    slug: 'neon-overdrive',
    title: 'Neon Overdrive',
    bpm: BPM,
    genre: 'Synthwave',
    accent: '#ff2fb3',
    preview: { start: sec(SECTIONS[2].start * 4), length: 20 },
    master,
    totalSeconds,
    notes: chart.finalize(),
    sections: SECTIONS,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Song 2 — BACK POCKET (96 BPM, E minor, funk / hip-hop)
// ═══════════════════════════════════════════════════════════════════════════

function buildBackPocket() {
  const BPM = 96;
  const clock = makeClock(BPM);
  const { sec, len } = clock;
  const TOTAL_BARS = 30; // 75 s at 96 BPM
  const totalSeconds = OFFSET_SECONDS + TOTAL_BARS * clock.barSec + TAIL_SECONDS;
  const SWING_TICKS = Math.round(0.12 * (PPQ / 4)); // ~12% of a 16th

  // Sections: A 8 | B 8 | A' 8 | B' 4 | outro 2  (crash at the top of each 16-bar section: bars 0 and 16)
  const SECTIONS = [
    { name: 'A', start: 0, bars: 8 },
    { name: 'B', start: 8, bars: 8 },
    { name: 'A2', start: 16, bars: 8 },
    { name: 'B2', start: 24, bars: 4 },
    { name: 'outro', start: 28, bars: 2 },
  ];
  const sectionOf = (bar) => SECTIONS.find((s) => bar >= s.start && bar < s.start + s.bars);

  // Rhodes voicings (E minor). [chord midi notes], bass root
  const V = {
    Em9: { notes: [n('E3'), n('G3'), n('B3'), n('D4'), n('F#4')], root: n('E1') },
    Am7: { notes: [n('A2'), n('G3'), n('C4'), n('E4')], root: n('A1') },
    B7: { notes: [n('B2'), n('A3'), n('D#4'), n('F#4')], root: n('B1') },
    Cmaj7: { notes: [n('C3'), n('G3'), n('B3'), n('E4')], root: n('C2') },
    D9: { notes: [n('D3'), n('F#3'), n('C4'), n('E4')], root: n('D2') },
    Gmaj7: { notes: [n('G2'), n('F#3'), n('B3'), n('D4')], root: n('G1') },
  };
  // 8-bar loops (chord per bar).
  const loopA = ['Em9', 'Em9', 'Am7', 'B7', 'Em9', 'Em9', 'Cmaj7', 'B7'];
  const loopB = ['Am7', 'D9', 'Gmaj7', 'Cmaj7', 'Am7', 'B7', 'Em9', 'B7'];
  const barChords = [...loopA, ...loopB, ...loopA, ...loopB.slice(0, 4), 'Em9', 'Em9'];
  const chordAt = (bar) => V[barChords[Math.min(bar, barChords.length - 1)]];

  const rhodesBus = new Bus(totalSeconds);
  const bassBus = new Bus(totalSeconds);
  const leadBus = new Bus(totalSeconds);
  const clavBus = new Bus(totalSeconds);

  // ── Rhodes comping. Pattern per bar in beats: [offset, duration, velocity] ──
  const compA = [
    [0, 1.4, 0.9],
    [1.5, 0.4, 0.6],
    [2.5, 1.4, 0.75],
  ];
  const compB = [
    [0, 0.9, 0.9],
    [1.75, 0.6, 0.7],
    [2.5, 0.4, 0.6],
    [3.5, 0.45, 0.8],
  ];
  for (let bar = 0; bar < TOTAL_BARS; bar++) {
    const sect = sectionOf(bar).name;
    const ch = chordAt(bar);
    if (sect === 'outro') {
      if (bar === 28) ch.notes.forEach((m, i) => rhodesBus.add(rhodesNote(m + (i === 0 ? -12 : 0), len(8), 1), sec(bar * 4), 0.36, (i % 2 ? 1 : -1) * 0.3));
      continue;
    }
    if (bar === 27) {
      // Turnaround into the ending: three big hits.
      for (const off of [0, 1.5, 3]) ch.notes.forEach((m, i) => rhodesBus.add(rhodesNote(m, len(0.6), 0.85), sec(bar * 4 + off), 0.3, (i % 2 ? 1 : -1) * 0.3));
      continue;
    }
    const pattern = bar % 2 === 0 ? compA : compB;
    for (const [off, d, v] of pattern) {
      ch.notes.forEach((m, i) => {
        const hum = 1 + (rand() - 0.5) * 0.06;
        rhodesBus.add(rhodesNote(m, len(d), v * hum), sec(bar * 4 + off) + i * 0.006, 0.3, (i % 2 ? 1 : -1) * 0.3);
      });
    }
  }

  // ── Slap bass. Patterns in 16th steps per 2 bars: [step, interval from root, lengthSteps, vel] ──
  const bassA = [
    [0, 0, 3, 1], [3, 0, 1, 0.7], [6, 12, 1, 0.95], [8, 0, 2, 0.85], [11, 10, 1, 0.7], [12, 12, 1, 0.9], [14, 7, 2, 0.75],
    [16, 0, 3, 1], [19, 0, 1, 0.7], [22, 12, 1, 0.95], [24, 0, 1, 0.85], [26, 3, 1, 0.75], [27, 5, 1, 0.75], [28, 7, 2, 0.9], [30, 10, 1, 0.7], [31, 11, 1, 0.8],
  ];
  const bassB = [
    [0, 0, 2, 1], [2, 0, 1, 0.7], [4, 12, 1, 0.95], [7, 0, 1, 0.8], [8, 0, 2, 0.9], [11, 7, 1, 0.75], [12, 12, 1, 0.95], [14, 10, 1, 0.7], [15, 12, 1, 0.75],
    [16, 0, 3, 1], [20, 12, 1, 0.95], [22, 0, 1, 0.8], [24, 0, 2, 0.9], [27, 3, 1, 0.75], [28, 5, 1, 0.8], [30, 7, 1, 0.85], [31, 10, 1, 0.7],
  ];
  for (let bar = 0; bar < TOTAL_BARS; bar += 2) {
    const sect = sectionOf(bar).name;
    if (sect === 'outro') {
      bassBus.add(slapBassNote(n('E1'), len(7), 1), sec(bar * 4), 0.7);
      continue;
    }
    if (bar === 26) {
      for (const [step, iv, l, v] of bassA.filter((x) => x[0] < 16)) bassBus.add(slapBassNote(chordAt(bar).root + iv, len(l / 4) * 0.9, v), sec(bar * 4 + step / 4), 0.7);
      bassBus.add(slapBassNote(n('B1'), len(0.5), 0.9), sec(b(27, 0)), 0.7);
      bassBus.add(slapBassNote(n('B1'), len(0.5), 0.9), sec(b(27, 1.5)), 0.7);
      bassBus.add(slapBassNote(n('B1'), len(0.5), 0.9), sec(b(27, 3)), 0.7);
      bassBus.add(slapBassNote(n('D2'), len(0.5), 0.9), sec(b(27, 3.5)), 0.7);
      continue;
    }
    const pattern = sect.startsWith('B') ? bassB : bassA;
    for (const [step, iv, l, v] of pattern) {
      const barOfStep = bar + Math.floor(step / 16);
      const root = chordAt(barOfStep).root;
      const swing = step % 2 === 1 ? 0.12 * (clock.beatSec / 4) : 0;
      bassBus.add(slapBassNote(root + iv, len(l / 4) * 0.85, v), sec(bar * 4 + step / 4) + swing, 0.7);
    }
  }

  // ── Section B: airy lead. [beat offset within 8 bars, midi, duration beats] ──
  const B = SECTIONS.find((s) => s.name === 'B');
  const E4 = n('E4'), G4 = n('G4'), A4 = n('A4'), B4 = n('B4'), D5 = n('D5'), E5 = n('E5'), FS4 = n('F#4'), C5 = n('C5');
  const melody = [
    [0.5, E4, 1], [2, G4, 0.5], [2.5, A4, 1.5], [4.5, B4, 1], [6, A4, 0.5], [6.5, G4, 1],
    [8.5, FS4, 1], [10, G4, 0.5], [10.5, B4, 1], [12, D5, 1.5], [14, C5, 0.5], [14.5, B4, 1.5],
    [16.5, E5, 1], [18, D5, 0.5], [18.5, B4, 1.5], [20.5, A4, 1], [22, G4, 0.5], [22.5, FS4, 1.5],
    [24.5, E4, 1], [26, G4, 0.5], [26.5, A4, 0.5], [27, B4, 2.5], [30, A4, 0.5], [30.5, G4, 1],
  ];
  const B2 = SECTIONS.find((s) => s.name === 'B2');
  for (const [off, midi, d] of melody) {
    const swing = (off * 4) % 2 === 1 ? 0.12 * (clock.beatSec / 4) : 0;
    leadBus.add(fluteNote(midi, len(d) - 0.05, 0.8), sec(B.start * 4 + off) + swing, 0.22, 0.15);
    if (off < 12) leadBus.add(fluteNote(midi, len(d) - 0.05, 0.85), sec(B2.start * 4 + off) + swing, 0.22, 0.15);
  }

  // ── A' section: clav stabs on off-beats for lift ──
  const A2 = SECTIONS.find((s) => s.name === 'A2');
  for (let bar = A2.start; bar < A2.start + A2.bars; bar++) {
    const ch = chordAt(bar);
    const stabs = bar % 2 === 0 ? [0.75, 1.5, 2.75, 3.5] : [0.5, 1.75, 2.5, 3.25];
    for (const off of stabs) {
      const swing = (off * 4) % 2 === 1 ? 0.12 * (clock.beatSec / 4) : 0;
      ch.notes.slice(1, 3).forEach((m, i) => clavBus.add(clavNote(m + 12, len(0.2), 0.8), sec(bar * 4 + off) + swing, 0.12, i ? 0.5 : -0.5));
    }
  }

  // ── Mix ──
  pingPongDelay(leadBus, clock.beatSec * 0.75, 0.3, 0.3);
  const master = new Bus(totalSeconds);
  master.addStereo(rhodesBus, 1);
  master.addStereo(bassBus, 1);
  master.addStereo(leadBus, 1);
  master.addStereo(clavBus, 1);
  const send = new Bus(totalSeconds);
  send.addStereo(rhodesBus, 0.4);
  send.addStereo(leadBus, 0.6);
  send.addStereo(clavBus, 0.4);
  master.addStereo(reverb(send, 0.8, 0.4), 0.3);

  // ── Drum chart ──
  const chart = new DrumChart(clock);
  function b(bar, beat) {
    return bar * 4 + beat;
  }
  const swingOff = (step) => (step % 2 === 1 ? SWING_TICKS : 0);
  const crashBars = new Set([0, 16]);
  for (let bar = 0; bar < TOTAL_BARS; bar++) {
    const sect = sectionOf(bar);
    const inLoop = bar - sect.start;

    if (sect.name === 'outro') {
      if (bar === 28) {
        chart.hit('crash', b(bar, 0), 1);
        chart.hit('kick', b(bar, 0), 1);
        chart.hit('kick', b(bar, 2.5), 0.8);
        chart.hit('snare', b(bar, 3), 0.9);
      }
      if (bar === 29) {
        chart.hit('crash', b(bar, 0), 0.95);
        chart.hit('kick', b(bar, 0), 1);
      }
      continue;
    }

    if (crashBars.has(bar)) chart.hit('crash', b(bar, 0), 1);

    const openHatBar = bar % 4 === 3;
    const fillBar = inLoop === sect.bars - 1;

    // Swung 16th hats.
    for (let s = 0; s < 16; s++) {
      const beat = s / 4;
      if (fillBar && s >= 12) continue;
      if (openHatBar && s === 14) {
        chart.hit('hihatOpen', b(bar, beat), 0.85, swingOff(s));
        continue;
      }
      if (openHatBar && s === 15) continue; // let the open hat ring
      const vel = s % 4 === 0 ? 0.85 : s % 2 === 0 ? 0.6 : 0.4;
      chart.hit('hihatClosed', b(bar, beat), vel, swingOff(s));
    }

    // Kick syncopations (two-bar pattern; B sections push a little harder).
    const pushy = sect.name.startsWith('B');
    if (bar % 2 === 0) {
      chart.hit('kick', b(bar, 0), 1);
      chart.hit('kick', b(bar, 0.75), 0.8, SWING_TICKS);
      chart.hit('kick', b(bar, 2.5), 0.9);
      if (pushy) chart.hit('kick', b(bar, 3.25), 0.7, SWING_TICKS);
    } else {
      chart.hit('kick', b(bar, 0), 1);
      chart.hit('kick', b(bar, 1.75), 0.8, SWING_TICKS);
      chart.hit('kick', b(bar, 2.5), 0.9);
      if (!fillBar) chart.hit('kick', b(bar, 3.5), 0.75);
    }

    // Backbeat + ghost notes.
    chart.hit('snare', b(bar, 1), 0.95);
    if (!fillBar) chart.hit('snare', b(bar, 3), 1);
    chart.hit('snare', b(bar, 1.75), 0.3, SWING_TICKS);
    chart.hit('snare', b(bar, 2.25), 0.28, SWING_TICKS);
    if (bar % 2 === 1) chart.hit('snare', b(bar, 3.75), 0.32, SWING_TICKS);

    // Short tom fill at the end of each loop.
    if (fillBar) {
      chart.hit('snare', b(bar, 3), 0.9);
      chart.hit('tomHigh', b(bar, 3.25), 0.8, SWING_TICKS);
      chart.hit('tomMid', b(bar, 3.5), 0.85);
      chart.hit('tomLow', b(bar, 3.75), 0.95, SWING_TICKS);
    }
  }

  return {
    slug: 'back-pocket',
    title: 'Back Pocket',
    bpm: BPM,
    genre: 'Funk',
    accent: '#ffb02f',
    preview: { start: sec(B.start * 4), length: 20 },
    master,
    totalSeconds,
    notes: chart.finalize(),
    sections: SECTIONS,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Mastering + output
// ═══════════════════════════════════════════════════════════════════════════

function masterize(bus) {
  const { L, R, length } = bus;
  // Gentle soft clip then normalise to -1 dBFS.
  let peak = 0;
  for (let i = 0; i < length; i++) {
    L[i] = Math.tanh(L[i] * 1.1);
    R[i] = Math.tanh(R[i] * 1.1);
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const g = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < length; i++) {
    L[i] *= g;
    R[i] *= g;
  }
  // Fade out the tail (last TAIL_SECONDS).
  const fade = Math.round(TAIL_SECONDS * SR);
  for (let i = 0; i < fade; i++) {
    const k = 1 - i / fade;
    const idx = length - fade + i;
    L[idx] *= k * k;
    R[idx] *= k * k;
  }
  // Ensure the first OFFSET_SECONDS are silent (nothing should be scheduled there, but be exact).
  const off = Math.round(OFFSET_SECONDS * SR);
  for (let i = 0; i < off; i++) L[i] = R[i] = 0;
}

function writeSong(song) {
  const dir = path.join(OUT_ROOT, song.slug);
  fs.mkdirSync(dir, { recursive: true });

  masterize(song.master);
  const wav = encodeWav16(song.master.L, song.master.R, SR);
  fs.writeFileSync(path.join(dir, 'audio.wav'), wav);

  const midi = buildMidi({ bpm: song.bpm, notes: song.notes, name: song.title });
  fs.writeFileSync(path.join(dir, 'expert.mid'), midi);

  const meta = {
    format: 1,
    id: song.slug,
    title: song.title,
    artist: 'DRUMKILLER',
    charter: 'make-demo-song',
    genre: song.genre,
    year: 2026,
    bpm: song.bpm,
    offset: OFFSET_SECONDS,
    audio: 'audio.wav',
    charts: { expert: 'expert.mid' },
    preview: song.preview,
    accent: song.accent,
    length: Math.round(song.totalSeconds * 100) / 100,
  };
  // Optional: compress to AAC (m4a) with ffmpeg when available, so the bundled songs stay small.
  // The WAV is kept only when ffmpeg is missing. Set DK_KEEP_WAV=1 to skip compression.
  if (!process.env.DK_KEEP_WAV) {
    const m4a = path.join(dir, 'audio.m4a');
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(dir, 'audio.wav'), '-c:a', 'aac', '-b:a', '192k', m4a], { stdio: 'inherit' });
    if (r.status === 0 && fs.existsSync(m4a)) {
      fs.unlinkSync(path.join(dir, 'audio.wav'));
      meta.audio = 'audio.m4a';
      console.log(`  compressed  audio.m4a ${(fs.statSync(m4a).size / 1024 / 1024).toFixed(2)} MB (AAC 192k)`);
    } else console.log('  ffmpeg not available — keeping audio.wav');
  }
  fs.writeFileSync(path.join(dir, 'song.json'), JSON.stringify(meta, null, 2) + '\n');

  // ── Sanity checks ──
  const wavBytes = wav;
  const declared = wavBytes.readUInt32LE(40);
  if (wavBytes.length !== 44 + declared) throw new Error(`${song.slug}: WAV size mismatch`);
  if (wavBytes.readUInt32LE(4) !== wavBytes.length - 8) throw new Error(`${song.slug}: RIFF size mismatch`);
  const info = inspectMidi(fs.readFileSync(path.join(dir, 'expert.mid')));
  if (info.noteOns !== song.notes.length) throw new Error(`${song.slug}: MIDI note count mismatch ${info.noteOns} != ${song.notes.length}`);
  if (Math.abs(info.tempoBpm - song.bpm) > 0.01) throw new Error(`${song.slug}: tempo mismatch`);
  const lastNoteSec = OFFSET_SECONDS + (info.lastTick / PPQ) * (60 / song.bpm);
  if (lastNoteSec > song.totalSeconds) throw new Error(`${song.slug}: notes extend past audio`);

  const byVoice = {};
  for (const [note, count] of Object.entries(info.byNote)) {
    const voice = Object.keys(GM).find((k) => GM[k] === Number(note));
    byVoice[voice] = count;
  }
  console.log(`\n${song.title} (${song.slug})`);
  console.log(`  audio.wav   ${(wavBytes.length / 1024 / 1024).toFixed(2)} MB, ${song.totalSeconds.toFixed(2)} s, 16-bit stereo ${SR} Hz`);
  console.log(`  expert.mid  ${midi.length} bytes, format 1, ${info.tracks} tracks, PPQ ${info.ppq}, ${info.tempoBpm.toFixed(2)} BPM`);
  console.log(`  notes       ${info.noteOns} (last at ${lastNoteSec.toFixed(2)} s)`);
  console.log(`  by voice    ${JSON.stringify(byVoice)}`);
  console.log(`  sections    ${song.sections.map((s) => `${s.name}@${s.start}`).join(' ')}`);
  return { slug: song.slug, notes: info.noteOns, bytes: wavBytes.length };
}

// ═══════════════════════════════════════════════════════════════════════════

const t0 = performance.now();
fs.mkdirSync(OUT_ROOT, { recursive: true });
const results = [];
for (const build of [buildNeonOverdrive, buildBackPocket]) {
  const tb = performance.now();
  const song = build();
  results.push(writeSong(song));
  console.log(`  rendered in ${((performance.now() - tb) / 1000).toFixed(1)} s`);
}
const index = results.map((r) => r.slug);
fs.writeFileSync(path.join(OUT_ROOT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`\nWrote ${path.relative(process.cwd(), path.join(OUT_ROOT, 'index.json'))}: ${JSON.stringify(index)}`);
console.log(`Total ${((performance.now() - t0) / 1000).toFixed(1)} s`);
