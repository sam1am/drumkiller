import type { App } from '@/app';
import { Transport, Metronome } from '@/audio';
import { constantTempoMap, DEFAULT_PPQ } from '@/midi';
import { computeEnvelope } from '@/game/waveform';
import { h, button } from './dom';

export interface OffsetPicker {
  el: HTMLElement;
  setOffset(seconds: number): void;
  setBpm(bpm: number): void;
  getOffset(): number;
  stop(): void;
  dispose(): void;
}

const ZOOMS = [3, 1, 0.25];

/**
 * Visual offset picker for the Studio: drop a mark on the whole-song waveform, fine-tune it on a
 * zoomed view (±3 s / ±1 s / ±0.25 s), nudge by ms, and audition ±3 s around the mark with the
 * metronome clicking exactly on the mark and every beat after it.
 */
export function offsetPicker(app: App, buffer: AudioBuffer, initialOffset: number, initialBpm: number, onChange: (offset: number) => void): OffsetPicker {
  const duration = buffer.duration;
  let offset = clamp(initialOffset);
  let bpm = initialBpm;
  let zoom = ZOOMS[0];
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const env = computeEnvelope(channels, buffer.sampleRate, 200);

  function clamp(v: number): number {
    return Math.max(0, Math.min(duration, Math.round(v * 1000) / 1000));
  }

  // ── transport for auditioning ──
  let transport: Transport | null = null;
  let metro: Metronome | null = null;
  let raf = 0;
  let playing = false;

  async function play(): Promise<void> {
    stop();
    await app.boot();
    transport = new Transport(app.engine);
    transport.load(buffer);
    metro = new Metronome(app.engine, transport);
    metro.setTempoMap(constantTempoMap(bpm), DEFAULT_PPQ, [{ tick: 0, numerator: 4, denominator: 4 }]);
    metro.setOffset(offset); // chart time 0 = the mark → first click lands exactly on it
    await metro.prepare();
    const from = Math.max(0, offset - 3);
    const until = Math.min(duration, offset + 3);
    transport.play(from);
    metro.start();
    playing = true;
    playBtn.textContent = '■ STOP';
    const loop = () => {
      if (!transport) return;
      if (transport.position >= until) {
        stop();
        return;
      }
      draw();
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function stop(): void {
    cancelAnimationFrame(raf);
    metro?.stop();
    transport?.stop();
    metro = null;
    transport = null;
    playing = false;
    playBtn.textContent = '▶ PLAY ±3s AROUND MARK';
    draw();
  }

  // ── canvases ──
  const overview = h('canvas', { class: 'offset-overview' });
  const zoomCanvas = h('canvas', { class: 'offset-zoom' });
  const readout = h('span', { class: 'mono', style: { minWidth: '92px', display: 'inline-block', textAlign: 'center' } });

  function setupCanvas(c: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const rect = c.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const hh = Math.max(1, Math.floor(rect.height));
    if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(hh * dpr)) {
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(hh * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h: hh };
  }

  function drawOverview(): void {
    const { ctx, w, h: hh } = setupCanvas(overview);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, hh);
    const mid = hh / 2;
    const amp = hh / 2 - 2;
    const binsPerPx = env.max.length / w;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor(x * binsPerPx);
      const b1 = Math.min(env.max.length - 1, Math.ceil((x + 1) * binsPerPx));
      let lo = 0;
      let hi = 0;
      for (let b = b0; b <= b1; b++) {
        if (env.max[b] > hi) hi = env.max[b];
        if (env.min[b] < lo) lo = env.min[b];
      }
      ctx.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
    // zoom window
    const zx0 = ((offset - zoom) / duration) * w;
    const zx1 = ((offset + zoom) / duration) * w;
    ctx.fillStyle = 'rgba(255,45,117,0.15)';
    ctx.fillRect(zx0, 0, Math.max(2, zx1 - zx0), hh);
    // mark
    const mx = (offset / duration) * w;
    ctx.strokeStyle = '#ff2d75';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mx, 0);
    ctx.lineTo(mx, hh);
    ctx.stroke();
    if (transport) {
      const px = (transport.position / duration) * w;
      ctx.fillStyle = '#fff';
      ctx.fillRect(px - 1, 0, 2, hh);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('whole song — click to place the mark', 4, 11);
  }

  function drawZoom(): void {
    const { ctx, w, h: hh } = setupCanvas(zoomCanvas);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, hh);
    const t0 = offset - zoom;
    const t1 = offset + zoom;
    const xOf = (t: number) => ((t - t0) / (t1 - t0)) * w;
    const mid = hh / 2;
    const amp = hh / 2 - 14;
    // waveform straight from samples (accurate at any zoom)
    const sr = buffer.sampleRate;
    const spp = ((t1 - t0) * sr) / w; // samples per pixel
    const inv = 1 / channels.length;
    for (let x = 0; x < w; x++) {
      const s0 = Math.floor((t0 + (x / w) * (t1 - t0)) * sr);
      const s1 = Math.floor(s0 + spp);
      if (s1 < 0 || s0 >= buffer.length) continue;
      let lo = 0;
      let hi = 0;
      const step = Math.max(1, Math.floor(spp / 64)); // cap work per pixel
      for (let i = Math.max(0, s0); i < Math.min(buffer.length, s1); i += step) {
        let v = 0;
        for (const ch of channels) v += ch[i];
        v *= inv;
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
      const past = t0 + (x / w) * (t1 - t0) < offset;
      ctx.fillStyle = past ? 'rgba(255,255,255,0.35)' : '#ff2d75';
      ctx.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
    // beat grid after the mark (and before, faint) from the bpm
    const beat = 60 / bpm;
    for (let k = -Math.ceil(zoom / beat); k * beat <= zoom; k++) {
      const t = offset + k * beat;
      if (t < t0 || t > t1) continue;
      const x = xOf(t);
      const bar = k % 4 === 0;
      ctx.strokeStyle = k < 0 ? 'rgba(255,255,255,0.08)' : bar ? 'rgba(255,230,0,0.6)' : 'rgba(255,230,0,0.25)';
      ctx.lineWidth = bar ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, hh);
      ctx.stroke();
      if (k >= 0 && (bar || zoom <= 1)) {
        ctx.fillStyle = 'rgba(255,230,0,0.7)';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(k === 0 ? 'BEAT 1' : `${Math.floor(k / 4) + 1}.${(k % 4) + 1}`, x + 3, hh - 4);
      }
    }
    // mark
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#ff2d75';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, hh);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(w / 2 - 6, 0);
    ctx.lineTo(w / 2 + 6, 0);
    ctx.lineTo(w / 2, 7);
    ctx.closePath();
    ctx.fill();
    // playhead
    if (transport) {
      const px = xOf(transport.position);
      if (px >= 0 && px <= w) {
        ctx.fillStyle = '#3ef2ff';
        ctx.fillRect(px - 1, 0, 2, hh);
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`−${zoom}s`, 4, 11);
    ctx.textAlign = 'right';
    ctx.fillText(`+${zoom}s`, w - 4, 11);
    ctx.textAlign = 'center';
    ctx.fillText('drag to fine-tune', w / 2, 11 + 12);
  }

  function draw(): void {
    drawOverview();
    drawZoom();
    readout.textContent = `${offset.toFixed(3)} s`;
  }

  function set(v: number, notify = true): void {
    offset = clamp(v);
    draw();
    if (notify) onChange(offset);
  }

  // ── pointer handling ──
  let dragging: 'overview' | 'zoom' | null = null;
  let dragStartX = 0;
  let dragStartOffset = 0;
  const overviewAt = (e: PointerEvent) => {
    const r = overview.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * duration;
  };
  overview.addEventListener('pointerdown', (e) => {
    overview.setPointerCapture(e.pointerId);
    dragging = 'overview';
    set(overviewAt(e));
  });
  overview.addEventListener('pointermove', (e) => {
    if (dragging === 'overview') set(overviewAt(e));
  });
  overview.addEventListener('pointerup', () => {
    dragging = null;
  });
  zoomCanvas.addEventListener('pointerdown', (e) => {
    zoomCanvas.setPointerCapture(e.pointerId);
    dragging = 'zoom';
    dragStartX = e.clientX;
    dragStartOffset = offset;
  });
  zoomCanvas.addEventListener('pointermove', (e) => {
    if (dragging !== 'zoom') return;
    // Dragging the waveform left moves the audio left under the fixed mark → later offset.
    const r = zoomCanvas.getBoundingClientRect();
    const secPerPx = (zoom * 2) / r.width;
    set(dragStartOffset - (e.clientX - dragStartX) * secPerPx);
  });
  zoomCanvas.addEventListener('pointerup', () => {
    dragging = null;
  });
  zoomCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(offset + (e.deltaY > 0 ? 1 : -1) * (zoom <= 0.25 ? 0.001 : zoom <= 1 ? 0.005 : 0.02));
  }, { passive: false });

  // ── controls ──
  const playBtn = button('▶ PLAY ±3s AROUND MARK', () => (playing ? stop() : play()), 'primary');
  const nudge = (ms: number) => button(`${ms > 0 ? '+' : '−'}${Math.abs(ms)}`, () => set(offset + ms / 1000), 'icon small');
  const zoomBtns = ZOOMS.map((z) => button(`±${z}s`, () => { zoom = z; zoomBtns.forEach((b, i) => b.classList.toggle('primary', ZOOMS[i] === z)); draw(); }, `icon small ${z === zoom ? 'primary' : ''}`));
  const el = h('div', { class: 'offset-picker', tabIndex: 0 },
    overview,
    zoomCanvas,
    h('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } },
      playBtn,
      h('span', { class: 'small dim' }, 'Mark:'), readout,
      nudge(-100), nudge(-10), nudge(-1), nudge(1), nudge(10), nudge(100),
      h('span', { class: 'small dim', style: { marginLeft: '6px' } }, 'ms'),
      h('span', { class: 'spacer', style: { flex: 1 } }),
      h('span', { class: 'small dim' }, 'Zoom'), ...zoomBtns,
    ),
    h('div', { class: 'small mute', style: { marginTop: '4px' } }, 'The white line is beat 1 of bar 1. Yellow lines show where the beats will fall at the current BPM. Arrow keys nudge ±10 ms (shift: ±1 ms).'),
  );
  el.addEventListener('keydown', (e) => {
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      set(offset + (e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.001 : 0.01));
    } else if (e.code === 'Space') {
      e.preventDefault();
      if (playing) stop();
      else void play();
    }
  });
  const ro = new ResizeObserver(() => draw());
  ro.observe(el);
  requestAnimationFrame(draw);

  return {
    el,
    setOffset: (v) => set(v, false),
    setBpm: (b) => {
      bpm = b;
      draw();
    },
    getOffset: () => offset,
    stop,
    dispose: () => {
      stop();
      ro.disconnect();
    },
  };
}
