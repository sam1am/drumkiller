/**
 * Timing heatmap for the results screen: the highway's strike line and lane receptors, with every judged
 * hit plotted where it landed relative to its note — above the line = early, below = late — and piled up
 * into a heat map so the player can see at a glance whether they rush, drag, or scatter on each drum.
 */
import { LANE_FOR_VOICE, LANE_LABELS, type DrumVoice, type HitWindows, type Judgement, type Lane } from '@/types';
import { JUDGE_COLORS, LANE_COLORS, hexA } from './renderer';

/** One judged hit: which drum, and its signed timing error (hit − note, seconds; negative = early). */
export interface TimingHit {
  voice: DrumVoice;
  delta: number;
  judgement: Judgement;
}

/** Columns of the heatmap: the player's five lanes in their order, then CRASH (a full-width bar on the highway). */
export function heatmapColumns(laneOrder: readonly Lane[]): Lane[] {
  return [...laneOrder.filter((l) => l !== 'crash'), 'crash'];
}

export interface LaneTiming {
  lane: Lane;
  count: number;
  /** Mean signed error (seconds). 0 when there are no hits. */
  mean: number;
  early: number;
  late: number;
}

/** Per-lane hit counts and mean error, in column order. */
export function laneTiming(hits: readonly TimingHit[], columns: readonly Lane[]): LaneTiming[] {
  const out = columns.map((lane) => ({ lane, count: 0, mean: 0, early: 0, late: 0 }));
  const byLane = new Map(out.map((o) => [o.lane, o]));
  for (const h of hits) {
    const o = byLane.get(LANE_FOR_VOICE[h.voice]);
    if (!o) continue;
    o.count++;
    o.mean += h.delta;
    if (h.delta < 0) o.early++;
    else if (h.delta > 0) o.late++;
  }
  for (const o of out) if (o.count) o.mean /= o.count;
  return out;
}

export interface TimingSummary {
  count: number;
  mean: number;
  /** Standard deviation of the signed error (seconds). */
  spread: number;
  early: number;
  late: number;
}

/** Overall mean / spread / early-vs-late split. */
export function timingSummary(hits: readonly TimingHit[]): TimingSummary {
  const count = hits.length;
  if (!count) return { count: 0, mean: 0, spread: 0, early: 0, late: 0 };
  let sum = 0;
  let early = 0;
  let late = 0;
  for (const h of hits) {
    sum += h.delta;
    if (h.delta < 0) early++;
    else if (h.delta > 0) late++;
  }
  const mean = sum / count;
  let sq = 0;
  for (const h of hits) sq += (h.delta - mean) ** 2;
  return { count, mean, spread: Math.sqrt(sq / count), early, late };
}

export interface Density {
  /** Row-major `rows × cols` grid; row 0 is the earliest (top). */
  grid: Float32Array;
  cols: number;
  rows: number;
  /** Largest cell value. */
  max: number;
}

/**
 * Pile the hits into a density grid: one column per lane, `rows` bins across ±`range` seconds (early at
 * the top). Each hit adds a gaussian bump (peak 1, σ = `sigma` bins) so neighbouring hits merge into heat.
 * Hits outside ±range are clamped to the edge rows.
 */
export function timingDensity(hits: readonly TimingHit[], columns: readonly Lane[], range: number, rows: number, sigma = 1.5): Density {
  const cols = columns.length;
  const grid = new Float32Array(rows * cols);
  const colOf = new Map(columns.map((l, i) => [l, i]));
  const reach = Math.ceil(sigma * 3);
  let max = 0;
  for (const h of hits) {
    const c = colOf.get(LANE_FOR_VOICE[h.voice]);
    if (c === undefined) continue;
    const u = Math.max(-1, Math.min(1, h.delta / range));
    const centre = ((u + 1) / 2) * (rows - 1);
    const r0 = Math.max(0, Math.floor(centre - reach));
    const r1 = Math.min(rows - 1, Math.ceil(centre + reach));
    for (let r = r0; r <= r1; r++) {
      const d = (r - centre) / sigma;
      const v = (grid[r * cols + c] += Math.exp(-0.5 * d * d));
      if (v > max) max = v;
    }
  }
  return { grid, cols, rows, max };
}

/** Heat colour ramp: 0 → nothing, then deep violet → accent pink → yellow → white. */
const RAMP: [number, number, number, number][] = [
  [0.0, 0x2a, 0x0f, 0x5e],
  [0.45, 0xff, 0x2d, 0x75],
  [0.8, 0xff, 0xe6, 0x00],
  [1.0, 0xff, 0xff, 0xff],
];

/** rgba for an intensity 0..1. Alpha ramps in quickly so a lone hit is still visible. */
export function heatColor(t: number): [number, number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < RAMP.length - 2 && x > RAMP[i + 1][0]) i++;
  const [t0, r0, g0, b0] = RAMP[i];
  const [t1, r1, g1, b1] = RAMP[i + 1];
  const f = t1 > t0 ? (x - t0) / (t1 - t0) : 0;
  return [Math.round(r0 + (r1 - r0) * f), Math.round(g0 + (g1 - g0) * f), Math.round(b0 + (b1 - b0) * f), Math.round(255 * Math.min(1, x * 3.5))];
}

export interface HeatmapOptions {
  hits: readonly TimingHit[];
  windows: HitWindows;
  laneOrder: readonly Lane[];
}

const TOP = 20;
const BOTTOM = 38;
const LEFT = 58;
const RIGHT = 12;

/** Explicit size for an offscreen render (the video's closing card); defaults to the canvas' CSS size. */
export interface HeatmapSize {
  width: number;
  height: number;
  /** Device pixels per CSS pixel; text and line widths are in CSS pixels. */
  dpr?: number;
}

/** Draw the heatmap onto `canvas` at its current CSS size (or `size`). Safe to call again on resize. */
export function drawTimingHeatmap(canvas: HTMLCanvasElement, opts: HeatmapOptions, size?: HeatmapSize): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = size?.dpr ?? Math.min(2, devicePixelRatio || 1);
  const W = Math.max(1, Math.floor(size?.width ?? canvas.clientWidth));
  const H = Math.max(1, Math.floor(size?.height ?? canvas.clientHeight));
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#08080c';
  ctx.fillRect(0, 0, W, H);

  const columns = heatmapColumns(opts.laneOrder);
  const plotX = LEFT;
  const plotW = Math.max(1, W - LEFT - RIGHT);
  const plotY = TOP;
  const plotH = Math.max(1, H - TOP - BOTTOM);
  const cy = plotY + plotH / 2;
  const range = opts.windows.good * 1.15; // seconds at the top/bottom edge
  const yOf = (delta: number) => cy + (Math.max(-1, Math.min(1, delta / range)) * plotH) / 2;
  const colW = plotW / columns.length;
  const colX = (i: number) => plotX + (i + 0.5) * colW;

  // judgement bands (±perfect / ±great / ±good) behind everything
  const bands: [number, string][] = [
    [opts.windows.good, JUDGE_COLORS.good],
    [opts.windows.great, JUDGE_COLORS.great],
    [opts.windows.perfect, JUDGE_COLORS.perfect],
  ];
  for (const [w, color] of bands) {
    ctx.fillStyle = hexA(color, 0.07);
    ctx.fillRect(plotX, yOf(-w), plotW, yOf(w) - yOf(-w));
  }
  // lane stripes
  columns.forEach((lane, i) => {
    ctx.fillStyle = hexA(LANE_COLORS[lane], i % 2 ? 0.03 : 0.05);
    ctx.fillRect(plotX + i * colW, plotY, colW, plotH);
  });

  // heat: density per column, spread sideways with a bell profile so each lane reads as a glowing pile
  const rows = Math.max(2, Math.floor(plotH));
  const dens = timingDensity(opts.hits, columns, range, rows, Math.max(2, rows / 60));
  if (dens.max > 0) {
    const norm = Math.max(dens.max * 0.9, 2.5);
    const img = ctx.createImageData(Math.floor(plotW * dpr), Math.floor(plotH * dpr));
    const iw = img.width;
    const ih = img.height;
    const data = img.data;
    const halfCol = (colW * dpr) / 2;
    for (let py = 0; py < ih; py++) {
      const r = Math.min(rows - 1, Math.floor((py / ih) * rows));
      for (let px = 0; px < iw; px++) {
        const c = Math.min(dens.cols - 1, Math.floor(px / (colW * dpr)));
        const v = dens.grid[r * dens.cols + c];
        if (v <= 0) continue;
        const dx = (px - (c + 0.5) * colW * dpr) / halfCol; // -1..1 across the column
        const profile = Math.max(0, 1 - dx * dx) ** 1.6;
        const t = (v / norm) * profile;
        if (t <= 0.002) continue;
        const [cr, cg, cb, ca] = heatColor(t);
        const o = (py * iw + px) * 4;
        data[o] = cr;
        data[o + 1] = cg;
        data[o + 2] = cb;
        data[o + 3] = ca;
      }
    }
    // putImageData replaces pixels rather than compositing, so go through an offscreen canvas to keep the bands under the heat
    const off = document.createElement('canvas');
    off.width = iw;
    off.height = ih;
    off.getContext('2d')?.putImageData(img, 0, 0);
    ctx.drawImage(off, plotX, plotY, plotW, plotH);
  }

  // window edges + ms scale on the left
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const [w, color] of bands) {
    for (const sign of [-1, 1]) {
      const y = yOf(sign * w);
      ctx.strokeStyle = hexA(color, 0.35);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(plotX, y);
      ctx.lineTo(plotX + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = hexA(color, 0.8);
      ctx.fillText(`${sign < 0 ? '−' : '+'}${Math.round(w * 1000)}`, plotX - 6, y);
    }
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '700 10px "Space Grotesk", sans-serif';
  ctx.fillText('EARLY ▲', 6, TOP / 2);
  ctx.fillText('LATE ▼', 6, plotY + plotH + 12);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.fillText('ms', 6, cy);

  // strike line
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.shadowColor = '#fff';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(plotX, cy);
  ctx.lineTo(plotX + plotW, cy);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // receptors on the line (outline only, so the heat under them stays visible) + per-lane mean tick + labels
  const stats = laneTiming(opts.hits, columns);
  columns.forEach((lane, i) => {
    const x = colX(i);
    const color = LANE_COLORS[lane];
    const rad = Math.min(colW * 0.34, 28);
    ctx.beginPath();
    ctx.ellipse(x, cy, rad, rad * 0.42, 0, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(color, 0.8);
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;
    const st = stats[i];
    if (st.count) {
      // mean: a white tick across the lane at the average error
      const y = yOf(st.mean);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - rad, y);
      ctx.lineTo(x + rad, y);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = hexA(color, 0.85);
    ctx.font = '700 11px "Space Grotesk", sans-serif';
    ctx.fillText(`${LANE_LABELS[lane]}${st.count ? ` · ${st.count}` : ''}`, x, plotY + plotH + 12);
    ctx.fillStyle = st.count ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)';
    ctx.font = '10px "JetBrains Mono", monospace';
    const ms = Math.round(st.mean * 1000);
    ctx.fillText(st.count ? `${ms > 0 ? '+' : ''}${ms} ms` : '—', x, plotY + plotH + 27);
  });
  ctx.textBaseline = 'alphabetic';
}
