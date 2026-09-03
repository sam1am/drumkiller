import { LANE_FOR_VOICE, LANE_LABELS, LANE_ORDER, type DrumVoice, type Judgement, type Lane, type PerformanceNote } from '@/types';
import type { TrackedNote } from './scoring';

export const LANE_COLORS: Record<Lane, string> = {
  hihat: '#ffe600',
  snare: '#ff2d75',
  kick: '#ff7a1a',
  toms: '#4d8dff',
  ride: '#8dff5a',
  crash: '#fff6c8',
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
  crash: '#fff6c8',
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

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
    this.resize();
  }

  setReducedMotion(on: boolean): void {
    this.reduced = on;
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
    const i = LANE_ORDER.indexOf(lane);
    const laneW = this.nearW / LANE_ORDER.length;
    return this.cx - this.nearW / 2 + laneW * (i + 0.5);
  }
  private xAt(nearX: number, z: number): number {
    return this.cx + (nearX - this.cx) * this.widthScaleAt(z);
  }

  // ── effects API ──
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
    const bgGrad = ctx.createRadialGradient(this.cx, this.farY, 10, this.cx, this.strikeY, h);
    bgGrad.addColorStop(0, hexA(accent, 0.28));
    bgGrad.addColorStop(0.5, hexA(accent, 0.06));
    bgGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // shake
    if (this.shake > 0.1 && !this.reduced) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= Math.pow(0.001, dt);
    } else this.shake = 0;

    this.drawRoad(state);
    this.drawBeats(state);
    this.drawReceptors(state, now);
    this.drawNotes(state);
    if (state.mode === 'record' && state.recorded) this.drawRecorded(state);
    this.drawComboFire(state, dt);
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
    rg.addColorStop(0, 'rgba(20,18,30,0.2)');
    rg.addColorStop(1, 'rgba(26,22,40,0.95)');
    ctx.fillStyle = rg;
    ctx.fill();
    // lane stripes
    const laneW = this.nearW / LANE_ORDER.length;
    LANE_ORDER.forEach((lane, i) => {
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
    for (let i = 0; i <= LANE_ORDER.length; i++) {
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
    const laneW = this.nearW / LANE_ORDER.length;
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
    LANE_ORDER.forEach((lane) => {
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
    const laneW = (this.nearW / LANE_ORDER.length) * scale;
    const color = missed ? '#6a6a7a' : VOICE_COLORS[voice];
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.shadowColor = color;
    ctx.shadowBlur = missed ? 0 : (ghost ? 6 : 14) * scale;
    if (ghost) {
      // Recorded imprint: a hollow echo of the note receding into the distance.
      const lane0 = LANE_FOR_VOICE[voice];
      const nx = lane0 === 'crash' ? this.cx : this.laneCenterNear(lane0);
      const gx = this.xAt(nx, z);
      const gw = lane0 === 'crash' ? (this.xAt(this.cx + this.nearW / 2, z) - this.xAt(this.cx - this.nearW / 2, z)) : (this.nearW / LANE_ORDER.length) * scale * 0.8;
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
      const l = this.xAt(this.cx - this.nearW / 2, z);
      const r = this.xAt(this.cx + this.nearW / 2, z);
      const hh = Math.max(3, 7 * scale);
      const g = ctx.createLinearGradient(l, 0, r, 0);
      g.addColorStop(0, hexA(color, 0.2));
      g.addColorStop(0.5, color);
      g.addColorStop(1, hexA(color, 0.2));
      ctx.fillStyle = g;
      ctx.fillRect(l, y - hh / 2, r - l, hh);
      ctx.fillStyle = '#fff';
      ctx.fillRect(l + (r - l) * 0.35, y - hh / 4, (r - l) * 0.3, hh / 2);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      return;
    }
    let nearX = this.laneCenterNear(lane);
    // toms get three sub-positions within their lane
    if (voice === 'tomHigh') nearX -= (this.nearW / LANE_ORDER.length) * 0.27;
    if (voice === 'tomLow') nearX += (this.nearW / LANE_ORDER.length) * 0.27;
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

  private drawComboFire(state: RenderState, dt: number): void {
    if (this.reduced) return;
    const intensity = Math.min(1, state.combo / 50);
    if (intensity <= 0.02) return;
    const ctx = this.ctx;
    const l = this.cx - this.nearW / 2;
    const r = this.cx + this.nearW / 2;
    const t = performance.now() / 1000;
    const flames = 14;
    for (let i = 0; i < flames; i++) {
      const fx = l + ((r - l) * (i + 0.5)) / flames + Math.sin(t * 5 + i) * 6;
      const hgt = (30 + 70 * intensity) * (0.7 + 0.3 * Math.sin(t * 9 + i * 1.7));
      const g = ctx.createLinearGradient(0, this.strikeY, 0, this.strikeY - hgt);
      const hot = state.multiplier >= 4;
      g.addColorStop(0, hexA(hot ? '#ff2d75' : '#ff7a1a', 0.55 * intensity));
      g.addColorStop(0.5, hexA('#ffe600', 0.25 * intensity));
      g.addColorStop(1, 'rgba(255,230,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(fx - 18, this.strikeY + 4);
      ctx.quadraticCurveTo(fx - 6, this.strikeY - hgt * 0.5, fx, this.strikeY - hgt);
      ctx.quadraticCurveTo(fx + 6, this.strikeY - hgt * 0.5, fx + 18, this.strikeY + 4);
      ctx.closePath();
      ctx.fill();
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
    LANE_ORDER.forEach((lane) => {
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
