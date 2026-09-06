import type { App, Screen } from '@/app';
import type { Chart, Difficulty, ScoreSummary, SongPackage } from '@/types';
import { DIFFICULTIES, DRUM_VOICES } from '@/types';
import { chartFromMidi, deriveDifficulty, parseMidi, constantTempoMap, DEFAULT_PPQ } from '@/midi';
import { getChartBlob } from '@/song';
import { GameSession, type GameMode } from '@/game/session';
import { CAM_ASPECT, VideoRecorder, openCamera, videoRecordingSupported, type HudSnapshot } from '@/game/videoRecorder';
import { starString } from '@/game/scoring';
import { h, button, toast, fmtScore, clear } from './dom';
import type { TimingHit } from '@/game/timingHeatmap';

/** Parse the chart file listed for `difficulty`, or null when the package has none. */
export async function readChart(pkg: SongPackage, difficulty: Difficulty): Promise<Chart | null> {
  const blob = getChartBlob(pkg, difficulty);
  if (!blob) return null;
  return chartFromMidi(parseMidi(await blob.arrayBuffer()), { fallbackBpm: pkg.meta.bpm });
}

/** Difficulties whose chart file exists AND contains notes, easy→expert. An empty MIDI counts as no chart. */
export async function realDifficulties(pkg: SongPackage): Promise<Difficulty[]> {
  const out: Difficulty[] = [];
  for (const d of DIFFICULTIES) {
    const c = await readChart(pkg, d).catch(() => null);
    if (c?.notes.length) out.push(d);
  }
  return out;
}

/** Load (or derive) the chart for a difficulty from a song package. A chart file with no notes is treated as missing. */
export async function loadChart(pkg: SongPackage, difficulty: Difficulty): Promise<{ chart: Chart; derived: boolean }> {
  const explicit = await readChart(pkg, difficulty);
  if (explicit?.notes.length) return { chart: explicit, derived: false };
  const real = await realDifficulties(pkg);
  const hardest = real[real.length - 1];
  if (!hardest) {
    return { chart: { ppq: DEFAULT_PPQ, tempoMap: constantTempoMap(pkg.meta.bpm), timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }], notes: [], duration: pkg.meta.length ?? 0 }, derived: true };
  }
  const src = (await readChart(pkg, hardest))!;
  return { chart: deriveDifficulty(src, difficulty), derived: true };
}

/** Load a song's custom samples into the kit (or restore the default kit). */
export async function applySongKit(app: App, pkg: SongPackage): Promise<void> {
  const samples = pkg.meta.samples ?? {};
  const hasCustom = Object.keys(samples).length > 0;
  if (app.kitCustomized || hasCustom) {
    await app.kit.loadDefault();
    app.kitCustomized = false;
  }
  for (const voice of DRUM_VOICES) {
    const path = samples[voice];
    if (!path) continue;
    const blob = pkg.files.get(path);
    if (!blob) continue;
    try {
      await app.kit.loadSample(voice, await blob.arrayBuffer());
      app.kitCustomized = true;
    } catch (e) {
      console.warn(`sample ${path} failed`, e);
    }
  }
  app.kit.setGain(pkg.meta.sampleGain ?? 1);
}

export async function gameScreen(app: App, params?: Record<string, unknown>): Promise<Screen> {
  const pkg = params?.pkg as SongPackage;
  const difficulty = (params?.difficulty as Difficulty) ?? 'medium';
  const mode = (params?.mode as GameMode) ?? 'play';
  const settings = app.settings;
  localStorage.setItem('dk.lastSong', pkg.meta.id);

  const canvas = h('canvas', { class: 'highway' });
  const scoreEl = h('div', { class: 'score' }, '0');
  const multEl = h('div', { class: 'mult' }, '1×');
  const comboEl = h('div', { class: 'combo' }, '0');
  const accEl = h('div', { class: 'acc' }, '100.0%');
  const starsEl = h('div', { class: 'stars-live' }, starString(0));
  const judgeEl = h('div', { class: 'judge' });
  const streakEl = h('div', { class: 'streak' });
  const progressEl = h('div');
  const countdownEl = h('div', { class: 'countdown' });
  const modeTag = h('div', { class: 'mode-tag' });
  const timingEl = h('div', { class: 'timing' }, '');
  const practiceBar = h('div', { class: 'practice-bar' });
  const loading = h('div', { class: 'pause-overlay' }, h('div', { class: 'display', style: { fontFamily: 'var(--font-display)', fontSize: '28px' } }, 'LOADING…'));

  const hud = h(
    'div',
    { class: 'hud' },
    h('div', { class: 'progress' }, progressEl),
    h('div', { class: 'score-box' }, scoreEl, multEl),
    h('div', { class: 'combo-box' }, comboEl, h('div', { class: 'combo-k' }, 'COMBO')),
    modeTag,
    judgeEl,
    streakEl,
    h('div', { class: 'song-info' }, h('div', { class: 't' }, pkg.meta.title), h('div', { class: 'a' }, `${pkg.meta.artist} · ${difficulty.toUpperCase()}`)),
    h('div', { class: 'acc-box' }, accEl, starsEl),
    practiceBar,
    timingEl,
    countdownEl,
  );
  const el = h('div', { class: 'screen game' }, canvas, hud, loading);

  let session: GameSession | null = null;
  let recorder: VideoRecorder | null = null;
  let lastJudge: HudSnapshot['judge'] = null;
  let lastStreak: HudSnapshot['streak'] = null;
  let countdown: number | null = null;
  let pauseOverlay: HTMLElement | null = null;
  let rate = mode === 'practice' ? Number(localStorage.getItem('dk.practiceRate') ?? 1) || 1 : 1;
  let guideDrums = mode === 'practice' ? localStorage.getItem('dk.guideDrums') === '1' : false;
  let loopA: number | null = null;
  let loopB: number | null = null;

  const JUDGE_COLORS: Record<string, string> = { perfect: '#ffe600', great: '#8dff5a', good: '#3ef2ff', miss: '#ff3b3b' };
  const showJudge = (text: string, cls: string) => {
    judgeEl.textContent = text;
    judgeEl.className = `judge ${cls}`;
    void judgeEl.offsetWidth;
    judgeEl.classList.add('show');
    lastJudge = { text, color: JUDGE_COLORS[cls] ?? '#fff', at: performance.now() };
  };

  /** What the video recorder repaints over the highway (the DOM HUD is not captured). */
  const hudSnapshot = (): HudSnapshot => ({
    score: scoreEl.textContent ?? '0',
    multiplier: multEl.textContent ?? '1×',
    multiplierMax: multEl.classList.contains('max'),
    combo: comboEl.textContent ?? '0',
    accuracy: accEl.textContent ?? '',
    stars: starsEl.textContent ?? '',
    progress: parseFloat(progressEl.style.width || '0') / 100,
    title: pkg.meta.title,
    artist: pkg.meta.artist,
    difficulty,
    mode: mode === 'practice' ? 'practice' : 'play',
    judge: lastJudge,
    streak: lastStreak,
    countdown,
  });

  /** Open the webcam and prepare the recorder (never fatal: the game still runs without it). */
  async function setupRecorder(): Promise<void> {
    if (!settings.recordVideo) return;
    if (!videoRecordingSupported()) {
      toast('Video recording is not supported in this browser', 'bad', 4000);
      return;
    }
    let camera: MediaStream | null = null;
    try {
      camera = await openCamera(settings.recordCameraId, settings.recordMic);
    } catch (e) {
      console.warn('camera unavailable', e);
      toast(`Camera unavailable (${(e as Error).name}) — recording the game only`, 'bad', 4000);
    }
    try {
      recorder = new VideoRecorder({
        highway: canvas,
        camera,
        gameAudio: app.engine.captureNode.stream,
        mic: settings.recordMic,
        rotateCamera: settings.recordRotate,
        audioContext: app.engine.ctx,
        captureNode: app.engine.captureNode,
        height: settings.recordResolution,
        accent: pkg.meta.accent,
        hud: hudSnapshot,
      });
      const cam = recorder.cameraElement;
      if (cam) {
        cam.className = `cam-preview${settings.recordRotate ? ' rotated' : ''}`;
        cam.style.setProperty('--cam-aspect', String(CAM_ASPECT));
        hud.appendChild(cam);
      }
      modeTag.appendChild(h('span', { class: 'pill bad' }, h('span', { class: 'rec-dot' }), 'REC'));
    } catch (e) {
      console.error(e);
      camera?.getTracks().forEach((t) => t.stop());
      recorder = null;
      toast(`Could not start video recording: ${(e as Error).message}`, 'bad', 4000);
    }
  }

  async function build(): Promise<void> {
    const audioBlob = pkg.files.get(pkg.meta.audio);
    if (!audioBlob) throw new Error(`Audio file "${pkg.meta.audio}" missing from song folder`);
    const [audio, { chart, derived }] = await Promise.all([app.engine.decode(await audioBlob.arrayBuffer()), loadChart(pkg, difficulty)]);
    await applySongKit(app, pkg);
    if (!chart.notes.length) toast('This chart has no notes.', 'bad');
    if (derived && mode === 'play') modeTag.appendChild(h('span', { class: 'pill' }, 'AUTO CHART'));
    if (mode === 'practice') modeTag.appendChild(h('span', { class: 'pill warn' }, 'PRACTICE · NO SCORE'));

    session = new GameSession(
      app.engine,
      app.kit,
      canvas,
      {
        mode,
        meta: pkg.meta,
        chart,
        difficulty,
        audio,
        rate,
        guideDrums,
        inputOffset: settings.inputOffset,
        hitWindowScale: settings.hitWindowScale,
        strictVoices: settings.strictVoices,
        scrollWindow: settings.scrollWindow,
        drumSoundsOnHit: settings.drumSoundsOnHit,
        reducedMotion: settings.reducedMotion,
        laneOrder: settings.laneOrder,
        loop: null,
      },
      {
        onJudge: (ev) => {
          scoreEl.textContent = fmtScore(ev.score);
          comboEl.textContent = String(ev.combo);
          comboEl.classList.remove('pop');
          void comboEl.offsetWidth;
          comboEl.classList.add('pop');
          multEl.textContent = `${ev.multiplier}×`;
          multEl.classList.toggle('max', ev.multiplier >= 4);
          if (ev.kind === 'hit') showJudge(ev.judgement.toUpperCase() + (Math.abs(ev.delta) > 0.02 ? (ev.delta < 0 ? ' ‹' : ' ›') : ''), ev.judgement);
          else if (ev.kind === 'miss') showJudge('MISS', 'miss');
          else if (Number.isNaN(ev.delta)) showJudge('OVERHIT', 'miss');
          else showJudge(`${ev.delta < 0 ? 'EARLY' : 'LATE'} ${Math.round(Math.abs(ev.delta) * 1000)}ms`, 'miss');
          const j = session!.judge;
          updateTiming();
          accEl.textContent = `${(j.accuracy * 100).toFixed(1)}%`;
          const ratio = j.maxScore ? j.score / Math.max(1, (j.judgedCount / Math.max(1, j.totalNotes)) * j.maxScore) : 0;
          starsEl.textContent = starString(Math.min(5, Math.round(Math.max(0, Math.min(1, ratio)) * 10) / 2));
        },
        onStreak: (combo) => {
          streakEl.textContent = combo >= 100 ? `${combo} KILLSTREAK` : `${combo} COMBO`;
          lastStreak = { text: streakEl.textContent, at: performance.now() };
          streakEl.classList.remove('show');
          void streakEl.offsetWidth;
          streakEl.classList.add('show');
        },
        onTick: (pos, dur) => {
          progressEl.style.width = `${Math.max(0, Math.min(100, (pos / dur) * 100))}%`;
        },
        onCountdown: (n) => {
          countdown = n;
          countdownEl.textContent = n === null ? '' : String(n);
        },
        onFrame: () => recorder?.frame(),
        onFinish: (summary) => finish(summary),
      },
      app.input,
    );
    (window as unknown as { dkSession: GameSession | null }).dkSession = session;
    updateTiming();
    await setupRecorder();
    loading.remove();
    if (mode === 'practice') buildPracticeBar();
    const countIn = 3;
    if (recorder) {
      // Prime the highway so the recording's first frame (the preview's poster) shows the road.
      session.drawFrame(countIn);
      await recorder.start();
    }
    await session.start(countIn);
  }

  let inputOffset = settings.inputOffset;
  function updateTiming(): void {
    if (!session) return;
    const st = session.judge.timingStats();
    const avg = st.count ? `${st.mean > 0 ? '+' : ''}${Math.round(st.mean * 1000)}ms ${st.mean > 0.015 ? 'LATE' : st.mean < -0.015 ? 'EARLY' : 'ON TIME'}` : '—';
    timingEl.textContent = `timing avg ${avg} (${st.count}) · offset ${Math.round(inputOffset * 1000)}ms · [ ] adjust`;
  }
  function nudgeOffset(deltaMs: number): void {
    inputOffset = Math.round((inputOffset * 1000 + deltaMs)) / 1000;
    app.settingsStore.update({ inputOffset });
    session?.setInputOffset(inputOffset);
    updateTiming();
    toast(`Input offset ${Math.round(inputOffset * 1000)} ms`);
  }
  function autoFixOffset(): void {
    if (!session) return;
    const st = session.judge.timingStats();
    if (st.count < 4) {
      toast('Play a few more notes first', 'bad');
      return;
    }
    inputOffset = Math.round((inputOffset - st.mean) * 1000) / 1000;
    app.settingsStore.update({ inputOffset });
    session.setInputOffset(inputOffset);
    session.judge.reseek(session.chartTime);
    updateTiming();
    toast(`Input offset set to ${Math.round(inputOffset * 1000)} ms`, 'ok');
  }

  function buildPracticeBar(): void {
    clear(practiceBar);
    const rateEl = h('span', { class: 'rate' }, `${Math.round(rate * 100)}%`);
    const setRate = (r: number) => {
      rate = Math.max(0.5, Math.min(1.25, Math.round(r * 20) / 20));
      localStorage.setItem('dk.practiceRate', String(rate));
      rateEl.textContent = `${Math.round(rate * 100)}%`;
      session?.setRate(rate);
    };
    const loopLabel = h('span', { class: 'pill' }, 'LOOP: OFF');
    const updateLoop = () => {
      if (loopA !== null && loopB !== null && session) {
        (session.cfg as { loop: { start: number; end: number } | null }).loop = { start: loopA, end: loopB };
        loopLabel.textContent = `LOOP ${loopA.toFixed(1)}s → ${loopB.toFixed(1)}s`;
        loopLabel.className = 'pill ok';
      } else {
        if (session) (session.cfg as { loop: { start: number; end: number } | null }).loop = null;
        loopLabel.textContent = loopA !== null ? `LOOP A=${loopA.toFixed(1)}s (set B)` : 'LOOP: OFF';
        loopLabel.className = 'pill';
      }
    };
    const guideBtn = button(`GUIDE DRUMS: ${guideDrums ? 'ON' : 'OFF'}`, () => {
      guideDrums = !guideDrums;
      localStorage.setItem('dk.guideDrums', guideDrums ? '1' : '0');
      toast('Guide drums will apply on restart', '');
      guideBtn.textContent = `GUIDE DRUMS: ${guideDrums ? 'ON' : 'OFF'}`;
    });
    practiceBar.append(
      button('−', () => setRate(rate - 0.05), 'icon'),
      rateEl,
      button('+', () => setRate(rate + 0.05), 'icon'),
      button('« 5s', () => session && session.seek(Math.max(-1, session.chartTime - 5)), 'icon'),
      button('5s »', () => session && session.seek(session.chartTime + 5), 'icon'),
      button('SET A', () => { loopA = session ? Math.max(0, session.chartTime) : 0; loopB = null; updateLoop(); }, 'icon'),
      button('SET B', () => { if (session && loopA !== null && session.chartTime > loopA + 1) { loopB = session.chartTime; updateLoop(); } }, 'icon'),
      button('CLEAR', () => { loopA = loopB = null; updateLoop(); }, 'icon ghost'),
      loopLabel,
      guideBtn,
    );
  }

  function togglePause(): void {
    if (!session) return;
    if (pauseOverlay) {
      pauseOverlay.remove();
      pauseOverlay = null;
      session.resume();
      return;
    }
    session.pause();
    const st = session.judge.timingStats();
    const timingPanel = h(
      'div',
      { class: 'panel tight', style: { textAlign: 'center' } },
      h('div', { class: 'small dim' }, 'TIMING'),
      h('div', { class: 'mono' }, st.count ? `You are hitting ${Math.round(Math.abs(st.mean) * 1000)} ms ${st.mean > 0 ? 'LATE' : 'EARLY'} on average (${st.count} hits)` : 'No hits yet'),
      h('div', { class: 'small mute' }, `Input offset: ${Math.round(inputOffset * 1000)} ms · window ×${settings.hitWindowScale.toFixed(2)}`),
      h('div', { class: 'btn-row', style: { justifyContent: 'center', marginTop: '8px' } },
        button('−10 ms', () => { nudgeOffset(-10); togglePause(); togglePause(); }, 'icon'),
        button('AUTO-FIX OFFSET', () => { autoFixOffset(); togglePause(); }, Math.abs(st.mean) > 0.02 && st.count >= 4 ? 'primary' : ''),
        button('+10 ms', () => { nudgeOffset(10); togglePause(); togglePause(); }, 'icon'),
      ),
    );
    pauseOverlay = h(
      'div',
      { class: 'pause-overlay' },
      h(
        'div',
        { class: 'menu' },
        h('h2', { class: 'display' }, 'PAUSED'),
        timingPanel,
        button('RESUME', togglePause, 'primary'),
        button('RESTART', () => restart()),
        button('QUIT', () => quit()),
      ),
    );
    el.appendChild(pauseOverlay);
  }

  function restart(): void {
    session?.stop();
    recorder?.discard();
    recorder = null;
    app.navigate('game', params);
  }

  function quit(): void {
    session?.stop();
    recorder?.discard();
    recorder = null;
    if (params?.back === 'studio') app.navigate('studio');
    else app.navigate(mode === 'practice' ? 'songs-practice' : 'songs');
  }

  async function finish(summary: ScoreSummary): Promise<void> {
    let video: unknown = undefined;
    if (recorder) {
      const rec = recorder;
      recorder = null;
      try {
        video = await rec.stop();
      } catch (e) {
        console.error(e);
        toast('Video recording failed', 'bad');
      }
    }
    // Every judged hit with its signed timing error, for the results screen's heatmap.
    const hits: TimingHit[] = [];
    for (const n of session?.judge.notes ?? []) if (n.state === 'hit' && n.delta !== undefined && n.judgement) hits.push({ voice: n.voice, delta: n.delta, judgement: n.judgement });
    app.navigate('results', { pkg, difficulty, mode, summary, rate, timing: session?.judge.timingStats(), hits, windows: session?.judge.windows, video, back: params?.back });
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape') {
      e.preventDefault();
      togglePause();
    } else if (e.code === 'BracketLeft') {
      e.preventDefault();
      nudgeOffset(-10);
    } else if (e.code === 'BracketRight') {
      e.preventDefault();
      nudgeOffset(10);
    }
  };
  window.addEventListener('keydown', onKey);
  // Pause when the tab loses focus (fairness).
  const onVis = () => {
    if (document.hidden && session && !session.isPaused && !pauseOverlay) togglePause();
  };
  document.addEventListener('visibilitychange', onVis);

  build().catch((err) => {
    console.error(err);
    toast(`Failed to start: ${(err as Error).message}`, 'bad');
    quit();
  });

  return {
    el,
    dispose: () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVis);
      session?.stop();
      recorder?.discard();
      recorder = null;
    },
  };
}
