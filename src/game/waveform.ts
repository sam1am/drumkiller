import type { Lane } from '@/types';
import type { BeatMark } from './renderer';

/** Min/max peak envelope of an audio buffer at `binsPerSecond` resolution (mono-summed). Pure and testable. */
export function computeEnvelope(channels: Float32Array[], sampleRate: number, binsPerSecond = 100): { min: Float32Array; max: Float32Array; binsPerSecond: number } {
  const length = channels[0]?.length ?? 0;
  const samplesPerBin = Math.max(1, Math.floor(sampleRate / binsPerSecond));
  const bins = Math.ceil(length / samplesPerBin);
  const min = new Float32Array(bins);
  const max = new Float32Array(bins);
  const inv = 1 / Math.max(1, channels.length);
  for (let b = 0; b < bins; b++) {
    let lo = 0;
    let hi = 0;
    const start = b * samplesPerBin;
    const end = Math.min(length, start + samplesPerBin);
    for (let i = start; i < end; i++) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      v *= inv;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max, binsPerSecond };
}

export interface WaveformStripOptions {
  /** Seconds shown on each side of the playhead. */
  halfWindow: number;
  accent: string;
}

/**
 * A scrolling waveform strip with a fixed centre playhead: shows the audio ±halfWindow seconds
 * around the current position plus beat/bar lines, so a performer can anticipate hits and changes.
 */
export class WaveformStrip {
  private ctx: CanvasRenderingContext2D;
  private env: ReturnType<typeof computeEnvelope>;
  private w = 0;
  private h = 0;
  private dpr = 1;
  readonly opts: WaveformStripOptions;

  constructor(private canvas: HTMLCanvasElement, buffer: AudioBuffer, opts: Partial<WaveformStripOptions> = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
    this.opts = { halfWindow: 5, accent: '#ff2d75', ...opts };
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    this.env = computeEnvelope(channels, buffer.sampleRate, 100);
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.floor(rect.width));
    this.h = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /**
   * @param position audio position in seconds (playhead)
   * @param beats beat marks in CHART seconds; `offset` converts them to audio seconds
   * @param hits recent recorded hits in chart seconds (drawn as ticks under the wave)
   */
  draw(position: number, beats: BeatMark[], offset: number, hits: { time: number; lane: Lane; color: string }[] = []): void {
    const { ctx, w, h } = this;
    const half = this.opts.halfWindow;
    const t0 = position - half;
    const t1 = position + half;
    const xOf = (t: number) => ((t - t0) / (t1 - t0)) * w;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, w, h);

    // beat / bar lines
    for (const b of beats) {
      const t = b.time + offset;
      if (t < t0) continue;
      if (t > t1) break;
      const x = xOf(t);
      ctx.strokeStyle = b.bar ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = b.bar ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // waveform (past = dim, future = bright)
    const mid = h * 0.5;
    const amp = h * 0.42;
    const bps = this.env.binsPerSecond;
    const b0 = Math.max(0, Math.floor(t0 * bps));
    const b1 = Math.min(this.env.max.length - 1, Math.ceil(t1 * bps));
    const binW = w / ((t1 - t0) * bps);
    for (let b = b0; b <= b1; b++) {
      const t = b / bps;
      const x = xOf(t);
      const future = t >= position;
      ctx.fillStyle = future ? this.opts.accent : 'rgba(255,255,255,0.35)';
      const top = mid - this.env.max[b] * amp;
      const bot = mid - this.env.min[b] * amp;
      ctx.fillRect(x, top, Math.max(1, binW), Math.max(1, bot - top));
    }

    // recorded hits as ticks along the bottom
    for (const hit of hits) {
      const t = hit.time + offset;
      if (t < t0 || t > t1) continue;
      ctx.fillStyle = hit.color;
      ctx.fillRect(xOf(t) - 1, h - 6, 2, 6);
    }

    // playhead
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // time labels
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`−${half}s`, 4, 11);
    ctx.textAlign = 'right';
    ctx.fillText(`+${half}s`, w - 4, 11);
    ctx.textAlign = 'center';
    ctx.fillText(fmt(position), w / 2, h - 3);
  }
}

function fmt(s: number): string {
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(s);
  return `${sign}${Math.floor(a / 60)}:${String(Math.floor(a % 60)).padStart(2, '0')}.${String(Math.floor((a % 1) * 10))}`;
}
