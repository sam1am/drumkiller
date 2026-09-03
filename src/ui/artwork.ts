import type { SongMeta } from '@/types';

/** Deterministic procedural cover art for songs without artwork. Every song gets its own look. */
export function drawProceduralArt(canvas: HTMLCanvasElement, meta: SongMeta): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const hgt = canvas.height;
  let seed = 0;
  for (const ch of meta.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const hue = Math.floor(rnd() * 360);
  const accent = meta.accent ?? `hsl(${hue} 90% 60%)`;
  const g = ctx.createLinearGradient(0, 0, w, hgt);
  g.addColorStop(0, `hsl(${(hue + 200) % 360} 40% 12%)`);
  g.addColorStop(1, `hsl(${(hue + 260) % 360} 50% 8%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, hgt);
  // sunburst rings
  const cx = w * (0.3 + rnd() * 0.4);
  const cy = hgt * (0.3 + rnd() * 0.4);
  for (let i = 12; i >= 1; i--) {
    ctx.beginPath();
    ctx.arc(cx, cy, (i / 12) * Math.max(w, hgt) * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 ? `${accent}` : `hsl(${(hue + 40) % 360} 90% 55%)`;
    ctx.globalAlpha = 0.04 + (12 - i) * 0.012;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // bars (like a waveform)
  const bars = 28;
  const bw = w / bars;
  for (let i = 0; i < bars; i++) {
    const amp = 0.15 + rnd() * 0.6;
    const bh = hgt * amp * 0.55;
    ctx.fillStyle = i % 3 === 0 ? accent : `hsl(${(hue + 40 * (i % 2)) % 360} 85% ${50 + (i % 5) * 6}%)`;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(i * bw + 1, hgt * 0.78 - bh, bw - 2, bh);
  }
  ctx.globalAlpha = 1;
  // diagonal slash
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(w * 0.62, 0);
  ctx.lineTo(w * 0.7, 0);
  ctx.lineTo(w * 0.28, hgt);
  ctx.lineTo(w * 0.2, hgt);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  // bpm text
  ctx.font = `700 ${Math.round(hgt * 0.14)}px "Bungee", Impact, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(meta.bpm)}`, w - 10, hgt * 0.22);
}
