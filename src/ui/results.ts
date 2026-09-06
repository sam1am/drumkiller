import type { App, Screen } from '@/app';
import type { Difficulty, HighScore, HitWindows, ScoreSummary, SongPackage } from '@/types';
import { h, button, fmtScore, pct, downloadBlob } from './dom';
import { fileExtensionFor, type RecordedVideo } from '@/game/videoRecorder';
import { topbar } from './topbar';
import { hitWindowsFor, starString, verdictFor } from '@/game/scoring';
import { drawTimingHeatmap, timingSummary, type TimingHit } from '@/game/timingHeatmap';

export function resultsScreen(app: App, params?: Record<string, unknown>): Screen {
  const pkg = params?.pkg as SongPackage;
  const difficulty = params?.difficulty as Difficulty;
  const mode = params?.mode as string;
  const summary = params?.summary as ScoreSummary;
  const rate = (params?.rate as number) ?? 1;
  const timing = (params?.timing as { mean: number; count: number } | undefined) ?? { mean: 0, count: 0 };
  const suggestedOffset = Math.round((app.settings.inputOffset - timing.mean) * 1000);
  const showTiming = timing.count >= 4;
  const timingBox: HTMLElement | null = showTiming
    ? h('div', { class: 'hint-box', style: { marginTop: '16px' } },
        h('div', null, `Timing: your hits averaged ${Math.round(Math.abs(timing.mean) * 1000)} ms ${timing.mean > 0 ? 'LATE' : 'EARLY'} (${timing.count} hits, offset ${Math.round(app.settings.inputOffset * 1000)} ms).`),
        Math.abs(timing.mean) > 0.015
          ? h('div', { class: 'btn-row', style: { marginTop: '8px' } }, button(`SET INPUT OFFSET TO ${suggestedOffset} MS`, () => { app.settingsStore.update({ inputOffset: suggestedOffset / 1000 }); timingBox?.replaceChildren(h('span', { class: 'pill ok' }, `Input offset set to ${suggestedOffset} ms`)); }, 'primary small'))
          : h('div', { class: 'small dim' }, 'Nice — your timing offset is dialled in.'),
      )
    : null;
  // Timing heatmap: every judged hit at the strike line, early above / late below.
  const hits = (params?.hits as TimingHit[] | undefined) ?? [];
  const windows = (params?.windows as HitWindows | undefined) ?? hitWindowsFor(difficulty, app.settings.hitWindowScale);
  let heatBox: HTMLElement | null = null;
  let heatObserver: ResizeObserver | null = null;
  if (hits.length) {
    const ts = timingSummary(hits);
    const ms = (s: number) => `${s > 0 ? '+' : ''}${Math.round(s * 1000)} ms`;
    const heatCanvas = h('canvas', { class: 'heatmap-canvas' });
    const redraw = () => drawTimingHeatmap(heatCanvas, { hits, windows, laneOrder: app.settings.laneOrder });
    heatObserver = new ResizeObserver(redraw);
    heatObserver.observe(heatCanvas);
    heatBox = h('div', { class: 'heatmap' },
      h('div', { class: 'small dim', style: { marginBottom: '6px' } }, 'TIMING HEATMAP — every hit piled up where it landed on the strike line: above = early, below = late'),
      heatCanvas,
      h('div', { class: 'legend' },
        h('span', null, h('span', { class: 'swatch' }), 'fewer → more hits'),
        h('span', null, `${ts.count} hits · mean ${ms(ts.mean)} · spread ±${Math.round(ts.spread * 1000)} ms`),
        h('span', null, `${Math.round((ts.early / ts.count) * 100)}% early · ${Math.round((ts.late / ts.count) * 100)}% late`),
      ),
    );
  }
  // Performance video. It arrives either finished or as a promise (the recorder is still adding the
  // closing results card): show a placeholder until it is ready. It sits at the bottom of the left column.
  const videoParam = params?.video as RecordedVideo | Promise<RecordedVideo | undefined> | undefined;
  let videoUrl: string | null = null;
  let disposed = false;
  const videoSlot = h('div', { class: 'video-slot' });
  const showVideo = (video: RecordedVideo) => {
    videoUrl = URL.createObjectURL(video.blob);
    const ext = fileExtensionFor(video.mimeType);
    const safe = (t: string) => t.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'song';
    const filename = `drumkiller-${safe(pkg.meta.title)}-${difficulty}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.${ext}`;
    const mb = (video.blob.size / 1_048_576).toFixed(1);
    videoSlot.replaceChildren(h('div', { class: 'video-box', style: { marginTop: '24px' } },
      h('video', { src: videoUrl, controls: true, playsInline: true, preload: 'metadata' }),
      h('div', { class: 'btn-row', style: { marginTop: '10px' } },
        button(`SAVE VIDEO (${mb} MB)`, () => downloadBlob(video.blob, filename), 'primary'),
        h('span', { class: 'small dim' }, `${video.width}×${video.height} · ${Math.round(video.duration)}s · ${ext.toUpperCase()}${ext === 'webm' ? ' — plays in Chrome/Firefox/VLC' : ''}`),
      ),
    ));
  };
  if (videoParam instanceof Promise) {
    videoSlot.appendChild(h('div', { class: 'video-box pending', style: { marginTop: '24px' } }, h('span', { class: 'spinner' }), h('span', { class: 'dim' }, 'Finishing the video — adding the results card…')));
    videoParam.then(
      (v) => {
        if (disposed) return;
        if (v && v.blob.size) showVideo(v);
        else videoSlot.replaceChildren();
      },
      () => videoSlot.replaceChildren(),
    );
  } else if (videoParam && videoParam.blob.size) {
    showVideo(videoParam);
  }
  const saved = mode === 'play';
  let rankInfo: { rank: number; isNewBest: boolean } | null = null;
  const entry: HighScore = { ...summary, songId: pkg.meta.id, difficulty, player: app.settings.playerName || 'PLAYER', date: Date.now() };
  if (saved && summary.totalNotes > 0) rankInfo = app.scores.submit(entry);

  const top = app.scores.getTop(pkg.meta.id, difficulty, 10);
  const total = Math.max(1, summary.totalNotes);
  const bar = (label: string, n: number, color: string) => h('div', { class: 'jb' }, h('span', null, label), h('div', { class: 'bar' }, h('div', { style: { width: `${(n / total) * 100}%`, background: color } })), h('span', { style: { textAlign: 'right' } }, String(n)));

  const verdict = verdictFor(summary);

  const el = h(
    'div',
    { class: 'screen' },
    topbar(app, 'RESULTS'),
    h(
      'div',
      { class: 'screen-body center' },
      h(
        'div',
        { class: 'results' },
        h(
          'div',
          { class: 'panel' },
          h('div', { class: 'dim' }, `${pkg.meta.title} — ${pkg.meta.artist} · ${difficulty.toUpperCase()}${mode === 'practice' ? ` · PRACTICE ${Math.round(rate * 100)}%` : ''}`),
          h('h2', { class: 'display', style: { marginTop: '6px' } }, verdict),
          h('div', { class: 'big-score' }, fmtScore(summary.score)),
          h('div', { class: 'stars-big' }, starString(summary.stars)),
          summary.fullCombo ? h('div', { style: { marginTop: '10px' } }, h('span', { class: 'fc-badge' }, 'FULL COMBO')) : null,
          rankInfo?.isNewBest ? h('div', { style: { marginTop: '10px' } }, h('span', { class: 'pill accent' }, 'NEW PERSONAL BEST')) : null,
          !saved ? h('div', { style: { marginTop: '10px' } }, h('span', { class: 'pill warn' }, 'PRACTICE — SCORE NOT SAVED')) : null,
          h('div', { class: 'grid-3', style: { marginTop: '20px' } },
            h('div', { class: 'stat' }, h('div', { class: 'v' }, pct(summary.accuracy)), h('div', { class: 'k' }, 'Accuracy')),
            h('div', { class: 'stat' }, h('div', { class: 'v' }, String(summary.maxCombo)), h('div', { class: 'k' }, 'Max combo')),
            h('div', { class: 'stat' }, h('div', { class: 'v' }, `${summary.totalNotes - summary.hits.miss}/${summary.totalNotes}`), h('div', { class: 'k' }, 'Notes hit')),
          ),
          h('div', { class: 'judge-bars' },
            bar('PERFECT', summary.hits.perfect, 'var(--perfect)'),
            bar('GREAT', summary.hits.great, 'var(--great)'),
            bar('GOOD', summary.hits.good, 'var(--good)'),
            bar('MISS', summary.hits.miss, 'var(--miss)'),
          ),
          heatBox,
          timingBox,
          h('div', { class: 'btn-row', style: { marginTop: '24px' } },
            button('PLAY AGAIN', () => app.navigate('game', { pkg, difficulty, mode, back: params?.back }), 'primary'),
            params?.back === 'studio' ? button('BACK TO STUDIO', () => app.navigate('studio')) : null,
            button('SONG LIST', () => app.navigate(mode === 'practice' ? 'songs-practice' : 'songs')),
            button('TITLE', () => app.navigate('title'), 'ghost'),
          ),
          videoSlot,
        ),
        h(
          'div',
          { class: 'panel' },
          h('h3', { style: { marginTop: 0 } }, `Leaderboard · ${difficulty}`),
          h('table', { class: 'leaderboard' },
            h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Player'), h('th', null, 'Score'), h('th', null, 'Acc'), h('th', null, 'Combo'), h('th', null, 'Date'))),
            h('tbody', null, top.length ? top.map((s, i) => h('tr', { class: rankInfo && i === rankInfo.rank - 1 && s.date === entry.date ? 'you' : '' }, h('td', null, String(i + 1)), h('td', null, s.player), h('td', null, fmtScore(s.score)), h('td', null, pct(s.accuracy)), h('td', null, `${s.maxCombo}${s.fullCombo ? ' FC' : ''}`), h('td', null, new Date(s.date).toLocaleDateString()))) : h('tr', null, h('td', { colSpan: 6, class: 'mute' }, 'No saved scores yet.'))),
          ),
        ),
      ),
    ),
  );
  return {
    el,
    dispose: () => {
      disposed = true;
      heatObserver?.disconnect();
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    },
  };
}
