import { LANE_FOR_VOICE, LANE_LABELS, LANE_ORDER, type DrumVoice, type Judgement, type Lane, type PerformanceNote } from '@/types';
import type { TrackedNote } from './scoring';

export const LANE_COLORS: Record<Lane, string> = {
  hihat: '#ffe600',
  snare: '#ff2d75',
  kick: '#ff7a1a',
  toms: '#4d8dff',
  ride: '#8dff5a',
  crash: '#2b8cff',
};

export const VOICE_COLORS: Record<DrumVoice, string> = {
  kick: '#ff7a1a',
  snare: '#ff2d75',
  tomHigh: '#3ef2ff',
  tomMid: '#4d8dff',
  tomLow: '#9d6bff',
  hihatClosed: '#ffe600',
  hihatOpen: '#fff7a8',
  ride: '#8dff5a',
  crash: '#2b8cff',
};

const JUDGE_COLORS: Record<Judgement, string> = { perfect: '#ffe600', great: '#8dff5a', good: '#3ef2ff', miss: '#ff3b3b' };

export interface BeatMark {
  time: number;
  bar: boolean;
}

export interface RenderState {
  /** Current chart time in seconds. */
  time: number;
  /** Seconds of highway visible ahead of the strike line. */
  window: number;
  notes: TrackedNote[];
  beats: BeatMark[];
  combo: number;
  multiplier: number;
  mode: 'play' | 'practice' | 'record';
  /** Recorded hits (record mode) — drawn receding away from the strike line. */
  recorded?: PerformanceNote[];
  /** Notes hit by the user that the chart didn't ask for (drawn as ghost flashes). */
  paused?: boolean;
  /** Song accent color for the road glow. */
  accent?: string;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}

interface Flash {
  lane: Lane;
  t0: number; // performance ms
  color: string;
  judgement: Judgement | 'over';
}

/** A slow-fading imprint of a hit note, pinned where it was relative to the strike line when it was hit. */
interface HitGhost {
  voice: DrumVoice;
  /** Signed timing error in seconds (hit − note): early < 0 → drawn above the strike line, late > 0 → below. */
  delta: number;
  velocity: number;
  judgement: Judgement;
  t0: number; // performance ms
}

/** A soft ring spreading out from the horizon when a drum is hit (background visualisation). */
interface Ripple {
  color: string;
  t0: number; // performance ms
  strength: number;
}

/** How long a hit ghost lingers (ms). Several stack up to show whether you're running early or late. */
export const HIT_GHOST_LIFE_MS = 2600;
const RIPPLE_LIFE_MS = 1400;

/**
 * Canvas 2D pseudo-3D highway renderer. Independent of game logic; the session feeds it a RenderState each frame.
 */
export class HighwayRenderer {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private particles: Particle[] = [];
  private flashes: Flash[] = [];
  private ghosts: HitGhost[] = [];
  private ripples: Ripple[] = [];
  private analyser: AnalyserNode | null = null;
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private waveData: Uint8Array<ArrayBuffer> | null = null;
  /** Smoothed spectrum (0..1 per column) so the visualiser breathes instead of flickering. */
  private spectrum: Float32Array = new Float32Array(0);
  /** Smoothed time-domain waveform (−1..1) for the oscilloscope ring. */
  private wave: Float32Array = new Float32Array(0);
  private bassLevel = 0;
  private energy = 0;
  private spin = 0;
  private stars: { a: number; r: number; s: number; tw: number }[] = [];
  private shake = 0;
  private flashAlpha = 0;
  private lastFrame = performance.now();
  private reduced = false;
  private lastNoteWindowStart = 0;

  // Layout (computed in resize)
  private cx = 0;
  private strikeY = 0;
  private farY = 0;
  private nearW = 0;
  private farW = 0;
  private readonly K = 2.2; // perspective strength
  private laneOrder: Lane[] = [...LANE_ORDER];

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
    this.resize();
  }

  setReducedMotion(on: boolean): void {
    this.reduced = on;
  }

  /** Left-to-right order of the vertical lanes. */
  setLaneOrder(order: Lane[]): void {
    this.laneOrder = [...order];
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.floor(rect.width));
    this.h = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.cx = this.w / 2;
    this.strikeY = this.h * 0.8;
    this.farY = this.h * 0.1;
    this.nearW = Math.min(this.w * 0.66, 980);
    this.farW = this.nearW * 0.22;
  }

  // ── projection ──
  /** u(z) ∈ [0,1] is the eased distance toward the horizon; z is fraction of the scroll window. */
  private u(z: number): number {
    const s = (zz: number) => 1 / (1 + this.K * zz);
    const sFar = s(1);
    return (1 - s(z)) / (1 - sFar);
  }
  private yAt(z: number): number {
    return this.strikeY - (this.strikeY - this.farY) * this.u(z);
  }
  private widthScaleAt(z: number): number {
    return 1 - (1 - this.farW / this.nearW) * this.u(z);
  }
  private laneCenterNear(lane: Lane): number {
    const i = this.laneOrder.indexOf(lane);
    const laneW = this.nearW / this.laneOrder.length;
    return this.cx - this.nearW / 2 + laneW * (i + 0.5);
  }
  private xAt(nearX: number, z: number): number {
    return this.cx + (nearX - this.cx) * this.widthScaleAt(z);
  }

  // ── effects API ──
  /** Feed the background visualiser from an analyser tapping the mix (song + drums). */
  setAnalyser(analyser: AnalyserNode | null): void {
    this.analyser = analyser;
    this.freqData = analyser ? new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)) : null;
    this.waveData = analyser ? new Uint8Array(new ArrayBuffer(analyser.fftSize)) : null;
  }

  /**
   * Leave a slow-fading copy of a hit note where it was when it was struck: `delta` seconds early puts it
   * above the strike line, late puts it below. Ghosts accumulate so the spread reads as live timing feedback.
   */
  hitGhost(voice: DrumVoice, delta: number, velocity: number, judgement: Judgement): void {
    this.ghosts.push({ voice, delta, velocity, judgement, t0: performance.now() });
    if (this.ghosts.length > 64) this.ghosts.splice(0, this.ghosts.length - 64);
  }

  /** Background ripple for a drum hit (any mode). */
  drumPulse(voice: DrumVoice, velocity = 1): void {
    if (this.reduced) return;
    // Hi-hat and ride are busy: keep their rings faint so kicks, snares and crashes carry the pulse.
    const lane = LANE_FOR_VOICE[voice];
    const weight = lane === 'hihat' || lane === 'ride' ? 0.3 : lane === 'crash' ? 1.4 : 1;
    this.ripples.push({ color: VOICE_COLORS[voice], t0: performance.now(), strength: weight * (0.5 + 0.5 * Math.max(0, Math.min(1, velocity))) });
    if (this.ripples.length > 10) this.ripples.splice(0, this.ripples.length - 10);
  }

  hitFlash(voice: DrumVoice, judgement: Judgement | 'over'): void {
    const lane = LANE_FOR_VOICE[voice];
    this.flashes.push({ lane, t0: performance.now(), color: judgement === 'over' ? '#ff3b3b' : JUDGE_COLORS[judgement], judgement });
    if (judgement === 'miss' || judgement === 'over') return;
    if (this.reduced) return;
    const count = judgement === 'perfect' ? 26 : judgement === 'great' ? 16 : 8;
    const baseX = lane === 'crash' ? this.cx : this.laneCenterNear(lane);
    const color = VOICE_COLORS[voice];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 120 + Math.random() * 380;
      this.particles.push({
        x: baseX + (lane === 'crash' ? (Math.random() - 0.5) * this.nearW : 0),
        y: this.strikeY,
        vx: Math.cos(a) * sp * 0.6,
        vy: -Math.abs(Math.sin(a)) * sp - 80,
        life: 0,
        max: 0.5 + Math.random() * 0.5,
        color: Math.random() < 0.3 ? '#ffffff' : color,
        size: 2 + Math.random() * 4,
      });
    }
    if (voice === 'crash') {
      this.shake = Math.max(this.shake, 10);
      this.flashAlpha = Math.max(this.flashAlpha, 0.35);
    } else if (voice === 'kick') {
      this.shake = Math.max(this.shake, 3);
    }
  }

  streakBurst(): void {
    if (this.reduced) return;
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 200 + Math.random() * 500;
      this.particles.push({ x: this.cx, y: this.strikeY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 200, life: 0, max: 0.8 + Math.random(), color: ['#ffe600', '#ff2d75', '#ffffff', '#3ef2ff'][i % 4], size: 3 + Math.random() * 4 });
    }
    this.shake = 14;
  }

  // ── main draw ──
  draw(state: RenderState): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const ctx = this.ctx;
    const { w, h } = this;

    ctx.save();
    // background
    ctx.fillStyle = '#07070b';
    ctx.fillRect(0, 0, w, h);
    const accent = state.accent ?? '#ff2d75';
    this.sampleAudio(dt, !!state.paused);
    // The horizon glow breathes with the low end of the mix.
    const breathe = this.reduced ? 0 : this.bassLevel * 0.1;
    const bgGrad = ctx.createRadialGradient(this.cx, this.farY, 10, this.cx, this.strikeY, h);
    bgGrad.addColorStop(0, hexA(accent, 0.28 + breathe));
    bgGrad.addColorStop(0.5, hexA(accent, 0.06 + breathe * 0.3));
    bgGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);
    this.drawVisualiser(accent, now, dt);

    // shake
    if (this.shake > 0.1 && !this.reduced) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= Math.pow(0.001, dt);
    } else this.shake = 0;

    this.drawRoad(state);
    this.drawBeats(state);
    this.drawReceptors(state, now);
    this.drawGhosts(state, now);
    this.drawNotes(state);
    if (state.mode === 'record' && state.recorded) this.drawRecorded(state);
    this.drawParticles(dt);
    this.drawLaneLabels();
    ctx.restore();

    if (this.flashAlpha > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${this.flashAlpha})`;
      ctx.fillRect(0, 0, w, h);
      this.flashAlpha *= Math.pow(0.01, dt);
    }
    // vignette
    const vg = ctx.createRadialGradient(this.cx, h * 0.5, h * 0.35, this.cx, h * 0.5, h * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  private drawRoad(state: RenderState): void {
    const ctx = this.ctx;
    const zNear = -0.16;
    const zFar = 1.05;
    const left = (z: number) => this.xAt(this.cx - this.nearW / 2, z);
    const right = (z: number) => this.xAt(this.cx + this.nearW / 2, z);
    // road body
    ctx.beginPath();
    ctx.moveTo(left(zNear), this.yAt(zNear));
    ctx.lineTo(right(zNear), this.yAt(zNear));
    ctx.lineTo(right(zFar), this.yAt(zFar));
    ctx.lineTo(left(zFar), this.yAt(zFar));
    ctx.closePath();
    const rg = ctx.createLinearGradient(0, this.farY, 0, this.strikeY);
    // Mostly opaque so the background visualiser stays behind the road rather than blending into it.
    rg.addColorStop(0, 'rgba(16,14,24,0.82)');
    rg.addColorStop(1, 'rgba(22,19,34,0.97)');
    ctx.fillStyle = rg;
    ctx.fill();
    // lane stripes
    const laneW = this.nearW / this.laneOrder.length;
    this.laneOrder.forEach((lane, i) => {
      const x0 = this.cx - this.nearW / 2 + laneW * i;
      const x1 = x0 + laneW;
      ctx.beginPath();
      ctx.moveTo(this.xAt(x0, zNear), this.yAt(zNear));
      ctx.lineTo(this.xAt(x1, zNear), this.yAt(zNear));
      ctx.lineTo(this.xAt(x1, zFar), this.yAt(zFar));
      ctx.lineTo(this.xAt(x0, zFar), this.yAt(zFar));
      ctx.closePath();
      ctx.fillStyle = hexA(LANE_COLORS[lane], i % 2 ? 0.05 : 0.09);
      ctx.fill();
    });
    // lane dividers
    ctx.lineWidth = 1;
    for (let i = 0; i <= this.laneOrder.length; i++) {
      const x = this.cx - this.nearW / 2 + laneW * i;
      const grad = ctx.createLinearGradient(0, this.strikeY, 0, this.farY);
      grad.addColorStop(0, 'rgba(255,255,255,0.28)');
      grad.addColorStop(1, 'rgba(255,255,255,0.02)');
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(this.xAt(x, zNear), this.yAt(zNear));
      ctx.lineTo(this.xAt(x, zFar), this.yAt(zFar));
      ctx.stroke();
    }
    // edge glow
    ctx.lineWidth = 3;
    ctx.strokeStyle = hexA(state.accent ?? '#ff2d75', 0.7);
    ctx.shadowColor = state.accent ?? '#ff2d75';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(left(zNear), this.yAt(zNear));
    ctx.lineTo(left(zFar), this.yAt(zFar));
    ctx.moveTo(right(zNear), this.yAt(zNear));
    ctx.lineTo(right(zFar), this.yAt(zFar));
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  private drawBeats(state: RenderState): void {
    const ctx = this.ctx;
    const t0 = state.time - state.window * 0.16;
    const t1 = state.time + state.window * 1.05;
    for (const b of state.beats) {
      if (b.time < t0) continue;
      if (b.time > t1) break;
      const z = (b.time - state.time) / state.window;
      const y = this.yAt(z);
      const l = this.xAt(this.cx - this.nearW / 2, z);
      const r = this.xAt(this.cx + this.nearW / 2, z);
      ctx.strokeStyle = b.bar ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = b.bar ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(l, y);
      ctx.lineTo(r, y);
      ctx.stroke();
    }
  }

  private drawReceptors(state: RenderState, now: number): void {
    const ctx = this.ctx;
    const laneW = this.nearW / this.laneOrder.length;
    // strike line
    const l = this.cx - this.nearW / 2;
    const r = this.cx + this.nearW / 2;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.moveTo(l, this.strikeY);
    ctx.lineTo(r, this.strikeY);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // receptors
    this.flashes = this.flashes.filter((f) => now - f.t0 < 260);
    this.laneOrder.forEach((lane) => {
      const x = this.laneCenterNear(lane);
      const flash = this.flashes.filter((f) => f.lane === lane).pop();
      const flashAmt = flash ? 1 - (now - flash.t0) / 260 : 0;
      const color = LANE_COLORS[lane];
      const rad = laneW * 0.34;
      ctx.beginPath();
      ctx.ellipse(x, this.strikeY, rad, rad * 0.42, 0, 0, Math.PI * 2);
      ctx.fillStyle = hexA(color, 0.15 + flashAmt * 0.6);
      ctx.strokeStyle = hexA(flash ? flash.color : color, 0.6 + flashAmt * 0.4);
      ctx.lineWidth = 2 + flashAmt * 4;
      ctx.shadowColor = flash ? flash.color : color;
      ctx.shadowBlur = 8 + flashAmt * 30;
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (flashAmt > 0 && flash) {
        ctx.beginPath();
        ctx.ellipse(x, this.strikeY, rad * (1 + (1 - flashAmt) * 0.9), rad * 0.42 * (1 + (1 - flashAmt) * 0.9), 0, 0, Math.PI * 2);
        ctx.strokeStyle = hexA(flash.color, flashAmt * 0.8);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });
    // crash flash: whole strike line glows
    const crashFlash = this.flashes.filter((f) => f.lane === 'crash').pop();
    if (crashFlash) {
      const amt = 1 - (now - crashFlash.t0) / 260;
      ctx.strokeStyle = hexA(crashFlash.color, amt);
      ctx.lineWidth = 6 + amt * 10;
      ctx.shadowColor = crashFlash.color;
      ctx.shadowBlur = 40 * amt;
      ctx.beginPath();
      ctx.moveTo(l, this.strikeY);
      ctx.lineTo(r, this.strikeY);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  private drawNotes(state: RenderState): void {
    const ctx = this.ctx;
    const t0 = state.time - state.window * 0.16;
    const t1 = state.time + state.window * 1.05;
    const notes = state.notes;
    // find visible range via binary search on time (notes sorted by time)
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].time < t0) lo = mid + 1;
      else hi = mid;
    }
    // draw far → near so near notes overlap far ones
    const visible: TrackedNote[] = [];
    for (let i = lo; i < notes.length && notes[i].time <= t1; i++) visible.push(notes[i]);
    for (let i = visible.length - 1; i >= 0; i--) {
      const n = visible[i];
      if (n.state === 'hit') continue;
      const z = (n.time - state.time) / state.window;
      const missed = n.state === 'missed';
      this.drawNote(n.voice, z, n.velocity, missed ? 0.35 : 1, missed);
    }
  }

  private drawRecorded(state: RenderState): void {
    const rec = state.recorded ?? [];
    // Recorded hits recede into the distance: z = (time - noteTime)/window, drawn newest (near) last.
    const t0 = state.time - state.window;
    for (let i = rec.length - 1; i >= 0; i--) {
      const n = rec[i];
      if (n.time < t0) break;
      const z = (state.time - n.time) / state.window;
      if (z < 0) continue;
      this.drawNote(n.voice, z, n.velocity, 0.75 - z * 0.6, false, true);
    }
  }

  private drawNote(voice: DrumVoice, z: number, velocity: number, alpha: number, missed: boolean, ghost = false): void {
    const ctx = this.ctx;
    const lane = LANE_FOR_VOICE[voice];
    const scale = this.widthScaleAt(z);
    const y = this.yAt(z);
    const laneW = (this.nearW / this.laneOrder.length) * scale;
    const color = missed ? '#6a6a7a' : VOICE_COLORS[voice];
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.shadowColor = color;
    ctx.shadowBlur = missed ? 0 : (ghost ? 6 : 14) * scale;
    if (ghost) {
      // Recorded imprint: a hollow echo of the note receding into the distance.
      const lane0 = LANE_FOR_VOICE[voice];
      const nx = lane0 === 'crash' ? this.cx : this.laneCenterNear(lane0);
      const gx = this.xAt(nx, z);
      const gw = lane0 === 'crash' ? (this.xAt(this.cx + this.nearW / 2, z) - this.xAt(this.cx - this.nearW / 2, z)) : (this.nearW / this.laneOrder.length) * scale * 0.8;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, 2 * scale);
      ctx.setLineDash([4 * scale, 4 * scale]);
      ctx.strokeRect(gx - gw / 2, y - 6 * scale, gw, 12 * scale);
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      return;
    }
    if (lane === 'crash') {
      // Full-width glowing bar: a wide soft halo, a solid gradient body and a white-hot core line,
      // so it reads as a note and never as a measure line.
      const l = this.xAt(this.cx - this.nearW / 2, z);
      const r = this.xAt(this.cx + this.nearW / 2, z);
      const hh = Math.max(6, 16 * scale);
      const halo = hh * 1.6;
      ctx.shadowBlur = missed ? 0 : 32 * scale;
      ctx.fillStyle = hexA(color, missed ? 0.15 : 0.35);
      ctx.fillRect(l, y - halo, r - l, halo * 2);
      ctx.shadowBlur = missed ? 0 : 18 * scale;
      const g = ctx.createLinearGradient(l, 0, r, 0);
      g.addColorStop(0, hexA(color, 0.55));
      g.addColorStop(0.5, color);
      g.addColorStop(1, hexA(color, 0.55));
      ctx.fillStyle = g;
      ctx.fillRect(l, y - hh / 2, r - l, hh);
      ctx.shadowBlur = 0;
      if (!missed) {
        const core = ctx.createLinearGradient(l, 0, r, 0);
        core.addColorStop(0, 'rgba(255,255,255,0.25)');
        core.addColorStop(0.5, 'rgba(255,255,255,0.95)');
        core.addColorStop(1, 'rgba(255,255,255,0.25)');
        ctx.fillStyle = core;
        ctx.fillRect(l, y - hh * 0.16, r - l, hh * 0.32);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = Math.max(1, 1.5 * scale);
        ctx.strokeRect(l, y - hh / 2, r - l, hh);
      }
      ctx.globalAlpha = 1;
      return;
    }
    let nearX = this.laneCenterNear(lane);
    // toms get three sub-positions within their lane
    if (voice === 'tomHigh') nearX -= (this.nearW / this.laneOrder.length) * 0.27;
    if (voice === 'tomLow') nearX += (this.nearW / this.laneOrder.length) * 0.27;
    const x = this.xAt(nearX, z);
    const rx = laneW * (voice === 'kick' ? 0.44 : voice.startsWith('tom') ? 0.2 : 0.3) * (0.85 + velocity * 0.2);
    const ry = rx * 0.45;
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(1, 2 * scale);
    switch (voice) {
      case 'kick': {
        // wide pill
        roundRect(ctx, x - rx, y - ry * 0.8, rx * 2, ry * 1.6, ry * 0.8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        roundRect(ctx, x - rx * 0.9, y - ry * 0.65, rx * 1.8, ry * 0.5, ry * 0.25);
        ctx.fill();
        break;
      }
      case 'snare': {
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath();
        ctx.ellipse(x, y - ry * 0.25, rx * 0.55, ry * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'hihatClosed': {
        // gem with an X
        ctx.beginPath();
        ctx.moveTo(x, y - ry * 1.3);
        ctx.lineTo(x + rx, y);
        ctx.lineTo(x, y + ry * 1.3);
        ctx.lineTo(x - rx, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.65)';
        ctx.lineWidth = Math.max(1.5, 3 * scale);
        ctx.beginPath();
        ctx.moveTo(x - rx * 0.4, y - ry * 0.5);
        ctx.lineTo(x + rx * 0.4, y + ry * 0.5);
        ctx.moveTo(x + rx * 0.4, y - ry * 0.5);
        ctx.lineTo(x - rx * 0.4, y + ry * 0.5);
        ctx.stroke();
        break;
      }
      case 'hihatOpen': {
        // hollow ring with an O
        ctx.lineWidth = Math.max(2, 5 * scale);
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry * 1.1, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = Math.max(1, 1.5 * scale);
        ctx.beginPath();
        ctx.ellipse(x, y, rx * 0.55, ry * 0.6, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'ride': {
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#0b0b10';
        ctx.beginPath();
        ctx.ellipse(x, y, rx * 0.3, ry * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      default: {
        // toms: hexagons, size grows low → high pitch inverse
        const size = voice === 'tomLow' ? 1.25 : voice === 'tomMid' ? 1.1 : 0.95;
        hexagon(ctx, x, y, rx * size, ry * size);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = `700 ${Math.max(7, 11 * scale)}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(voice === 'tomHigh' ? 'H' : voice === 'tomMid' ? 'M' : 'L', x, y + 0.5);
      }
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  // ── background visualiser ──
  /** Pull a fresh spectrum + waveform from the analyser and ease the smoothed copies toward them. */
  private sampleAudio(dt: number, paused: boolean): void {
    const cols = 72;
    const wavePts = 256;
    if (this.spectrum.length !== cols) this.spectrum = new Float32Array(cols);
    if (this.wave.length !== wavePts) this.wave = new Float32Array(wavePts);
    const decay = Math.pow(0.02, dt); // ~ -1 level in 1s when silent
    if (!this.analyser || !this.freqData || !this.waveData || this.reduced || paused) {
      for (let i = 0; i < cols; i++) this.spectrum[i] *= decay;
      for (let i = 0; i < wavePts; i++) this.wave[i] *= decay;
      this.bassLevel *= decay;
      this.energy *= decay;
      return;
    }
    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getByteTimeDomainData(this.waveData);
    const bins = this.freqData.length;
    // Only the musically useful part of the spectrum (~20 Hz – 8 kHz at 48k / fftSize 1024 ≈ bins 1..170).
    const maxBin = Math.max(8, Math.min(bins - 1, Math.floor(bins * 0.35)));
    let bass = 0;
    let sum = 0;
    for (let i = 0; i < cols; i++) {
      // log-spaced columns: more resolution for the lows, where the kick and snare live
      const f0 = Math.pow(i / cols, 1.7);
      const f1 = Math.pow((i + 1) / cols, 1.7);
      const b0 = 1 + Math.floor(f0 * (maxBin - 1));
      const b1 = Math.max(b0 + 1, 1 + Math.ceil(f1 * (maxBin - 1)));
      let acc = 0;
      for (let b = b0; b < b1; b++) acc = Math.max(acc, this.freqData[b]);
      const v = acc / 255;
      const cur = this.spectrum[i];
      // fast attack, slow release
      this.spectrum[i] = v > cur ? cur + (v - cur) * Math.min(1, dt * 18) : Math.max(v, cur * Math.pow(0.15, dt));
      if (i < cols * 0.15) bass = Math.max(bass, v);
      sum += v;
    }
    const step = this.waveData.length / wavePts;
    const k = Math.min(1, dt * 30);
    for (let i = 0; i < wavePts; i++) {
      const v = (this.waveData[Math.floor(i * step)] - 128) / 128;
      this.wave[i] += (v - this.wave[i]) * k;
    }
    const bassTarget = Math.max(0, (bass - 0.45) / 0.55);
    this.bassLevel = bassTarget > this.bassLevel ? this.bassLevel + (bassTarget - this.bassLevel) * Math.min(1, dt * 14) : this.bassLevel * Math.pow(0.05, dt);
    const eTarget = sum / cols;
    this.energy += (eTarget - this.energy) * Math.min(1, dt * 6);
  }

  /**
   * The background: a radial spectrum "sunburst" centred behind the road (two slowly counter-rotating
   * layers, mirrored so it stays symmetrical), a circular oscilloscope of the live waveform, a bass-driven
   * core, a star field that surges on the low end, and a ripple per drum hit. Everything sits behind the
   * road and is kept translucent so the notes always win.
   */
  private drawVisualiser(accent: string, now: number, dt: number): void {
    const cols = this.spectrum.length;
    if (!cols) return;
    const ctx = this.ctx;
    const cy = this.h * 0.5;
    const cx = this.cx;
    const bass = this.bassLevel;
    const energy = this.energy;
    // Outer reach: most of the background, and it swells with the mix — loud passages push it toward the edges.
    const R = Math.hypot(this.w, this.h) * 0.3 * (0.7 + energy * 0.9 + bass * 0.35);
    const accent2 = hexRotate(accent, 48);
    const accent3 = hexRotate(accent, -36);
    if (!this.reduced) this.spin += dt * (0.08 + bass * 0.5);
    const spin = this.spin;

    ctx.save();

    // ── star field: slow outward drift that surges with the low end ──
    if (!this.reduced) {
      if (!this.stars.length) for (let i = 0; i < 140; i++) this.stars.push({ a: Math.random() * Math.PI * 2, r: Math.random(), s: 0.4 + Math.random() * 0.6, tw: Math.random() * Math.PI * 2 });
      const speed = 0.04 + bass * 0.5 + energy * 0.1;
      for (const st of this.stars) {
        st.r += dt * speed * st.s;
        if (st.r > 1) {
          st.r = 0.05 + Math.random() * 0.1;
          st.a = Math.random() * Math.PI * 2;
        }
        const rr = st.r * st.r * R * 1.9 + R * 0.12;
        const x = cx + Math.cos(st.a) * rr;
        const y = cy + Math.sin(st.a) * rr * 0.72;
        const tw = 0.5 + 0.5 * Math.sin(now / 900 + st.tw);
        const a = (0.15 + st.r * 0.45) * tw * (0.5 + energy);
        ctx.fillStyle = `rgba(255,255,255,${Math.min(0.7, a)})`;
        const sz = 1 + st.r * 1.6 + bass * 1.5;
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
    }

    // ── sunburst: two mirrored spectrum layers ──
    const inner = R * (0.22 + bass * 0.06 + energy * 0.04);
    const burst = (rot: number, color: string, gain: number, alpha: number, squash: number) => {
      ctx.beginPath();
      const n = cols;
      // right half: top → bottom, then the mirrored left half bottom → top
      const pt = (i: number, side: 1 | -1) => {
        const idx = Math.max(0, Math.min(n - 1, i));
        const v = (this.spectrum[Math.max(0, idx - 1)] + this.spectrum[idx] * 2 + this.spectrum[Math.min(n - 1, idx + 1)]) / 4;
        const len = inner + Math.pow(v, 1.3) * (R - inner) * gain;
        const ang = -Math.PI / 2 + ((idx + 0.5) / n) * Math.PI;
        const a = side === 1 ? ang : Math.PI - ang;
        const x = Math.cos(a + rot) * len;
        const y = Math.sin(a + rot) * len * squash;
        return [cx + x, cy + y] as const;
      };
      let [x0, y0] = pt(0, 1);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < n; i++) {
        const [x1, y1] = pt(i, 1);
        ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
        x0 = x1;
        y0 = y1;
      }
      for (let i = n - 1; i >= 0; i--) {
        const [x1, y1] = pt(i, -1);
        ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
        x0 = x1;
        y0 = y1;
      }
      ctx.closePath();
      const g = ctx.createRadialGradient(cx, cy, inner * 0.6, cx, cy, R);
      g.addColorStop(0, hexA(color, alpha * 0.9));
      g.addColorStop(0.55, hexA(color, alpha * 0.35));
      g.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = hexA(color, alpha * 1.6);
      ctx.lineWidth = 1.2;
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    ctx.globalCompositeOperation = 'lighter';
    burst(spin * 0.35, accent2, 0.85, 0.11, 0.86);
    burst(-spin * 0.5, accent3, 0.7, 0.09, 0.92);
    burst(0, accent, 1, 0.2, 0.8);
    // rays: a thin line from the core to every other spike tip of the main layer
    ctx.lineWidth = 1;
    for (let i = 0; i < cols; i += 2) {
      const v = this.spectrum[i];
      if (v < 0.08) continue;
      const len = inner + Math.pow(v, 1.3) * (R - inner);
      const ang = -Math.PI / 2 + ((i + 0.5) / cols) * Math.PI;
      ctx.strokeStyle = hexA(accent, 0.05 + v * 0.22);
      for (const a of [ang, Math.PI - ang]) {
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * inner * 0.9, cy + Math.sin(a) * inner * 0.9 * 0.8);
        ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len * 0.8);
        ctx.stroke();
      }
    }

    // ── oscilloscope ring: the live waveform wrapped around the core ──
    const pts = this.wave.length;
    if (pts) {
      const ringR = inner * 1.05;
      const amp = R * (0.05 + bass * 0.04);
      ctx.beginPath();
      for (let i = 0; i <= pts; i++) {
        const v = this.wave[i % pts];
        const a = (i / pts) * Math.PI * 2 - Math.PI / 2 + spin * 0.1;
        const rr = ringR + v * amp;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr * 0.8;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `rgba(255,255,255,${0.16 + energy * 0.3})`;
      ctx.lineWidth = 1.4;
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // ── core: a soft bass-lit orb ──
    const coreR = inner * (0.8 + bass * 0.25);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    core.addColorStop(0, hexA('#ffffff', 0.08 + bass * 0.18));
    core.addColorStop(0.35, hexA(accent, 0.12 + bass * 0.2));
    core.addColorStop(1, hexA(accent, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.ellipse(cx, cy, coreR, coreR * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    // ── ripples: one ring per drum hit, in the drum's colour, spreading from the centre ──
    this.ripples = this.ripples.filter((r) => now - r.t0 < RIPPLE_LIFE_MS);
    ctx.lineWidth = 2;
    for (const r of this.ripples) {
      const p = (now - r.t0) / RIPPLE_LIFE_MS;
      const ease = 1 - Math.pow(1 - p, 2.4);
      const rr = inner + ease * R * 1.5;
      const alpha = (1 - p) * (1 - p) * 0.18 * r.strength;
      ctx.strokeStyle = hexA(r.color, alpha);
      ctx.shadowColor = r.color;
      ctx.shadowBlur = 12 * (1 - p);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rr, rr * 0.8, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // ── hit ghosts ──
  private drawGhosts(state: RenderState, now: number): void {
    this.ghosts = this.ghosts.filter((g) => now - g.t0 < HIT_GHOST_LIFE_MS);
    const ctx = this.ctx;
    for (const g of this.ghosts) {
      const p = (now - g.t0) / HIT_GHOST_LIFE_MS;
      const alpha = 0.42 * (1 - p) * (1 - p);
      if (alpha < 0.01) continue;
      // early → the note was still above the strike line; late → it had passed it
      const z = -g.delta / state.window;
      this.drawNote(g.voice, z, g.velocity, alpha, false);
      // a thin tick in the judgement colour at the exact hit position, so the offset is legible even when
      // the note shape is small
      const lane = LANE_FOR_VOICE[g.voice];
      const y = this.yAt(z);
      const nearX = lane === 'crash' ? this.cx : this.laneCenterNear(lane);
      const x = this.xAt(nearX, z);
      const half = (this.nearW / this.laneOrder.length) * this.widthScaleAt(z) * 0.5;
      ctx.globalAlpha = Math.min(1, alpha * 1.4);
      ctx.strokeStyle = JUDGE_COLORS[g.judgement];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - half, y);
      ctx.lineTo(x + half, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private drawParticles(dt: number): void {
    const ctx = this.ctx;
    const g = 900;
    this.particles = this.particles.filter((p) => p.life < p.max);
    for (const p of this.particles) {
      p.life += dt;
      p.vy += g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const a = 1 - p.life / p.max;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size * 0.6);
    }
    ctx.globalAlpha = 1;
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  }

  private drawLaneLabels(): void {
    const ctx = this.ctx;
    ctx.font = '700 11px "Space Grotesk", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    this.laneOrder.forEach((lane) => {
      const x = this.laneCenterNear(lane);
      ctx.fillStyle = hexA(LANE_COLORS[lane], 0.8);
      ctx.fillText(LANE_LABELS[lane], x, this.strikeY + 34);
    });
    const y = this.yAt(-0.13);
    ctx.fillStyle = hexA(LANE_COLORS.crash, 0.5);
    ctx.font = '700 10px "Space Grotesk", sans-serif';
    ctx.fillText('— CRASH = FULL-WIDTH BAR —', this.cx, y + 4);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function hexagon(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const px = x + Math.cos(a) * rx;
    const py = y + Math.sin(a) * ry;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** '#rrggbb' + alpha → 'rgba()' */
export function hexA(hex: string, a: number): string {
  if (!hex.startsWith('#')) return hex;
  const n = parseInt(hex.slice(1, 7), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}

/** Rotate a '#rrggbb' colour's hue by `deg` degrees (keeps saturation/lightness). */
export function hexRotate(hex: string, deg: number): string {
  if (!hex.startsWith('#') || hex.length < 7) return hex;
  const n = parseInt(hex.slice(1, 7), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  h = (h + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rr = 0;
  let gg = 0;
  let bb = 0;
  if (h < 60) [rr, gg, bb] = [c, x, 0];
  else if (h < 120) [rr, gg, bb] = [x, c, 0];
  else if (h < 180) [rr, gg, bb] = [0, c, x];
  else if (h < 240) [rr, gg, bb] = [0, x, c];
  else if (h < 300) [rr, gg, bb] = [x, 0, c];
  else [rr, gg, bb] = [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(rr)}${to(gg)}${to(bb)}`;
}
