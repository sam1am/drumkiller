import type { App } from '@/app';
import { Transport, Metronome } from '@/audio';
import { constantTempoMap, DEFAULT_PPQ } from '@/midi';
import { computeEnvelope } from '@/game/waveform';
import { h, button } from './dom';

export interface OffsetPicker {
  el: HTMLElement;
  /** Where the zoomed view is centred (seconds into the audio). */
  getViewCenter(): number;
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
export function offsetPicker(app: App, buffer: AudioBuffer, initialOffset: number, initialBpm: number, onChange: (offset: number) => void, onBpmChange: (bpm: number) => void = () => undefined): OffsetPicker {
  const duration = buffer.duration;
  let offset = clamp(initialOffset);
  let bpm = initialBpm;
  let zoom = ZOOMS[0];
  /** Where the zoomed view is centred. Follows the mark until the user scrolls away to check the tempo. */
  let viewCenter = offset;
  // Copy the channel data out NOW: once the buffer is handed to a playback node the browser detaches
  // the arrays returned by getChannelData(), which is why reading them while auditioning drew nothing.
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const env = computeEnvelope(channels, buffer.sampleRate, 200); // overview
  const fine = computeEnvelope(channels, buffer.sampleRate, 4000); // zoomed view (0.25 ms bins)
  channels.length = 0;

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
    metro.setOffset(offset); // chart time 0 = the mark → clicks land on the mark and every beat after it
    await metro.prepare();
    // Start 3 s before the mark (or before wherever the view was scrolled to), then keep going:
    // the zoomed waveform scrolls under the centred playhead until you stop or the song ends.
    const from = Math.max(0, viewCenter - 3);
    transport.play(from);
    transport.onEnded = () => stop();
    metro.setEnabled(clickOn);
    metro.start();
    playing = true;
    updatePlayLabel();
    const loop = () => {
      if (!transport) return;
      viewCenter = Math.max(0, Math.min(duration, transport.position));
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
    updatePlayLabel();
    draw();
  }

  function updatePlayLabel(): void {
    playBtn.textContent = playing ? '■ STOP' : '▶ PLAY';
    playBtn.title = playing ? 'Stop' : `Play from 3 s before ${Math.abs(viewCenter - offset) < 0.0005 ? 'the mark' : `${viewCenter.toFixed(1)}s`} — the view follows the playhead`;
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
    const zx0 = ((viewCenter - zoom) / duration) * w;
    const zx1 = ((viewCenter + zoom) / duration) * w;
    ctx.fillStyle = 'rgba(255,45,117,0.15)';
    ctx.fillRect(zx0, 0, Math.max(2, zx1 - zx0), hh);
    // bar ticks along the bottom edge: at the right BPM they stay locked to the downbeats all song long
    const barLen = (60 / bpm) * 4;
    ctx.fillStyle = 'rgba(255,230,0,0.7)';
    for (let k = 0; offset + k * barLen <= duration; k++) {
      const x = ((offset + k * barLen) / duration) * w;
      ctx.fillRect(x, hh - (k % 4 === 0 ? 8 : 4), 1, k % 4 === 0 ? 8 : 4);
    }
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
    const t0 = viewCenter - zoom;
    const t1 = viewCenter + zoom;
    const xOf = (t: number) => ((t - t0) / (t1 - t0)) * w;
    const mid = hh / 2;
    const amp = hh / 2 - 14;
    // waveform from the fine envelope (0.25 ms bins — accurate down to the ±0.25 s zoom)
    const bps = fine.binsPerSecond;
    for (let x = 0; x < w; x++) {
      const ta = t0 + (x / w) * (t1 - t0);
      const tb = t0 + ((x + 1) / w) * (t1 - t0);
      const b0 = Math.floor(ta * bps);
      const b1 = Math.max(b0, Math.ceil(tb * bps) - 1);
      if (b1 < 0 || b0 >= fine.max.length) continue;
      let lo = 0;
      let hi = 0;
      for (let b = Math.max(0, b0); b <= Math.min(fine.max.length - 1, b1); b++) {
        if (fine.max[b] > hi) hi = fine.max[b];
        if (fine.min[b] < lo) lo = fine.min[b];
      }
      ctx.fillStyle = ta < offset ? 'rgba(255,255,255,0.35)' : '#ff2d75';
      ctx.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
    // tempo grid: a tick on every beat (tall on bar downbeats) anchored to the mark — if the ticks drift
    // off the transients further into the song, the BPM is off; nudge it until they lock in.
    const beat = 60 / bpm;
    const kFirst = Math.ceil((t0 - offset) / beat);
    const kLast = Math.floor((t1 - offset) / beat);
    for (let k = kFirst; k <= kLast; k++) {
      const t = offset + k * beat;
      const x = xOf(t);
      const bar = ((k % 4) + 4) % 4 === 0;
      const before = k < 0;
      ctx.strokeStyle = before ? 'rgba(255,255,255,0.12)' : bar ? 'rgba(255,230,0,0.55)' : 'rgba(255,230,0,0.22)';
      ctx.lineWidth = bar ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, hh);
      ctx.stroke();
      // solid tick marks at the top and bottom edges so the beat position reads even over loud audio
      ctx.fillStyle = before ? 'rgba(255,255,255,0.4)' : '#ffe600';
      const tl = bar ? 12 : 6;
      ctx.fillRect(x - 1, 0, 2, tl);
      ctx.fillRect(x - 1, hh - tl, 2, tl);
      if (!before && (bar || zoom <= 1)) {
        ctx.fillStyle = 'rgba(255,230,0,0.8)';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(k === 0 ? 'BEAT 1' : `${Math.floor(k / 4) + 1}.${(k % 4) + 1}`, x + 3, hh - 14);
      }
    }
    // mark
    const mx = xOf(offset);
    if (mx >= -2 && mx <= w + 2) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#ff2d75';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, hh);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(mx - 6, 0);
      ctx.lineTo(mx + 6, 0);
      ctx.lineTo(mx, 7);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`mark at ${offset.toFixed(3)}s ${mx < 0 ? '◀' : '▶'}`, w / 2, 11 + 12);
    }
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
    ctx.fillText(`${bpm.toFixed(2)} BPM · drag waveform = move mark`, w / 2, 11);
  }

  function draw(): void {
    drawOverview();
    drawZoom();
    readout.textContent = `${offset.toFixed(3)} s`;
    bpmReadout.textContent = `${bpm.toFixed(2)}`;
    updatePlayLabel();
  }

  function set(v: number, notify = true): void {
    const follow = Math.abs(viewCenter - offset) < 0.0005;
    offset = clamp(v);
    if (follow) viewCenter = offset;
    draw();
    if (notify) onChange(offset);
  }
  function setBpmLocal(b: number, notify = true): void {
    bpm = Math.max(20, Math.min(300, Math.round(b * 100) / 100));
    draw();
    if (notify) onBpmChange(bpm);
  }
  function setView(t: number): void {
    viewCenter = Math.max(0, Math.min(duration, t));
    if (playing) {
      transport?.seek(Math.max(0, viewCenter - 3));
      metro?.resync();
    }
    draw();
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
    if (e.shiftKey) setView(overviewAt(e));
    else {
      viewCenter = offset; // re-follow the mark
      set(overviewAt(e));
    }
  });
  overview.addEventListener('pointermove', (e) => {
    if (dragging === 'overview' && e.shiftKey) setView(overviewAt(e));
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
  const playBtn = button('▶ PLAY', () => (playing ? stop() : play()), 'primary');
  let clickOn = true;
  const clickBtn = button('CLICK: ON', () => { clickOn = !clickOn; clickBtn.textContent = `CLICK: ${clickOn ? 'ON' : 'OFF'}`; metro?.setEnabled(clickOn); }, 'icon small');
  const nudge = (ms: number) => button(`${ms > 0 ? '+' : '−'}${Math.abs(ms)}`, () => set(offset + ms / 1000), 'icon small');
  const barLen = () => (60 / bpm) * 4;
  const bpmReadout = h('span', { class: 'mono', style: { minWidth: '64px', display: 'inline-block', textAlign: 'center' } });
  const bpmNudge = (d: number) => button(`${d > 0 ? '+' : '−'}${Math.abs(d)}`, () => setBpmLocal(bpm + d), 'icon small');
  const viewBtn = (label: string, fn: () => void, title: string) => { const b = button(label, fn, 'icon small'); b.title = title; return b; };
  const zoomBtns = ZOOMS.map((z) => button(`±${z}s`, () => { zoom = z; zoomBtns.forEach((b, i) => b.classList.toggle('primary', ZOOMS[i] === z)); draw(); }, `icon small ${z === zoom ? 'primary' : ''}`));
  const el = h('div', { class: 'offset-picker', tabIndex: 0 },
    overview,
    zoomCanvas,
    h('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } },
      playBtn,
      clickBtn,
      h('span', { class: 'small dim' }, 'Mark:'), readout,
      nudge(-100), nudge(-10), nudge(-1), nudge(1), nudge(10), nudge(100),
      h('span', { class: 'small dim', style: { marginLeft: '6px' } }, 'ms'),
      h('span', { class: 'spacer', style: { flex: 1 } }),
      h('span', { class: 'small dim' }, 'Zoom'), ...zoomBtns,
    ),
    h('div', { class: 'row', style: { marginTop: '6px', gap: '8px' } },
      h('span', { class: 'small dim' }, 'View:'),
      viewBtn('⏮ MARK', () => setView(offset), 'Centre the view on the mark'),
      viewBtn('◀ BAR', () => setView(viewCenter - barLen()), 'One bar earlier'),
      viewBtn('BAR ▶', () => setView(viewCenter + barLen()), 'One bar later'),
      viewBtn('8 BARS ▶', () => setView(viewCenter + barLen() * 8), 'Eight bars later — check the ticks still sit on the beats'),
      viewBtn('32 BARS ▶', () => setView(viewCenter + barLen() * 32), 'Thirty-two bars later'),
      h('span', { class: 'spacer', style: { flex: 1 } }),
      h('span', { class: 'small dim' }, 'BPM:'), bpmReadout,
      bpmNudge(-1), bpmNudge(-0.1), bpmNudge(-0.01), bpmNudge(0.01), bpmNudge(0.1), bpmNudge(1),
    ),
    h('div', { class: 'small mute', style: { marginTop: '4px' } }, 'White line = beat 1 of bar 1 (the mark). Yellow ticks = every beat at the current BPM, tall on downbeats. PLAY starts 3 s before the mark and keeps going with the waveform scrolling under the playhead; watch whether the ticks stay on the hits — if they creep, nudge the BPM until they lock in. Shift-click the overview to move the view without moving the mark. Arrow keys nudge the mark ±10 ms (shift: ±1 ms).'),
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
    getViewCenter: () => viewCenter,
    setOffset: (v) => set(v, false),
    setBpm: (b) => setBpmLocal(b, false),
    getOffset: () => offset,
    stop,
    dispose: () => {
      stop();
      ro.disconnect();
    },
  };
}
