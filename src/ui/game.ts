import type { App, Screen } from '@/app';
import type { Chart, Difficulty, PerformanceNote, ScoreSummary, SongPackage } from '@/types';
import { DRUM_VOICES } from '@/types';
import { chartFromMidi, deriveDifficulty, parseMidi, constantTempoMap, DEFAULT_PPQ } from '@/midi';
import { getChartBlob, hardestAvailable } from '@/song';
import { GameSession, type GameMode } from '@/game/session';
import { starString } from '@/game/scoring';
import { h, button, toast, fmtScore, clear } from './dom';
import { studioState } from './studioState';

/** Load (or derive) the chart for a difficulty from a song package. */
export async function loadChart(pkg: SongPackage, difficulty: Difficulty): Promise<{ chart: Chart; derived: boolean }> {
  const explicit = getChartBlob(pkg, difficulty);
  if (explicit) {
    const midi = parseMidi(await explicit.arrayBuffer());
    return { chart: chartFromMidi(midi, { fallbackBpm: pkg.meta.bpm }), derived: false };
  }
  const hardest = hardestAvailable(pkg);
  if (!hardest) {
    return { chart: { ppq: DEFAULT_PPQ, tempoMap: constantTempoMap(pkg.meta.bpm), timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }], notes: [], duration: pkg.meta.length ?? 0 }, derived: true };
  }
  const blob = getChartBlob(pkg, hardest)!;
  const src = chartFromMidi(parseMidi(await blob.arrayBuffer()), { fallbackBpm: pkg.meta.bpm });
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
    countdownEl,
  );
  const el = h('div', { class: 'screen game' }, canvas, hud, loading);

  let session: GameSession | null = null;
  let pauseOverlay: HTMLElement | null = null;
  let rate = mode === 'practice' ? Number(localStorage.getItem('dk.practiceRate') ?? 1) || 1 : 1;
  let guideDrums = mode === 'practice' ? localStorage.getItem('dk.guideDrums') === '1' : false;
  let loopA: number | null = null;
  let loopB: number | null = null;

  const showJudge = (text: string, cls: string) => {
    judgeEl.textContent = text;
    judgeEl.className = `judge ${cls}`;
    void judgeEl.offsetWidth;
    judgeEl.classList.add('show');
  };

  async function build(): Promise<void> {
    const audioBlob = pkg.files.get(pkg.meta.audio);
    if (!audioBlob) throw new Error(`Audio file "${pkg.meta.audio}" missing from song folder`);
    const [audio, { chart, derived }] = await Promise.all([
      app.engine.decode(await audioBlob.arrayBuffer()),
      mode === 'record' ? Promise.resolve({ chart: studioState.chartForRecording(pkg), derived: false }) : loadChart(pkg, difficulty),
    ]);
    await applySongKit(app, pkg);
    if (mode !== 'record' && !chart.notes.length) toast('This chart has no notes.', 'bad');
    if (derived && mode === 'play') modeTag.appendChild(h('span', { class: 'pill' }, 'AUTO CHART'));
    if (mode === 'practice') modeTag.appendChild(h('span', { class: 'pill warn' }, 'PRACTICE · NO SCORE'));
    if (mode === 'record') {
      modeTag.appendChild(h('span', { class: 'pill bad' }, h('span', { class: 'rec-dot' }), 'RECORDING'));
      modeTag.appendChild(h('div', { class: 'small dim', style: { marginTop: '6px' } }, 'ESC → Finish take / Quit'));
      comboEl.parentElement?.remove();
      accEl.parentElement?.remove();
      multEl.textContent = 'HITS';
      multEl.classList.remove('max');
    }

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
        metronome: mode === 'record' ? studioState.metronome : false,
        inputOffset: settings.inputOffset,
        scrollWindow: settings.scrollWindow,
        drumSoundsOnHit: settings.drumSoundsOnHit,
        reducedMotion: settings.reducedMotion,
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
          else showJudge('OVERHIT', 'miss');
          const j = session!.judge;
          accEl.textContent = `${(j.accuracy * 100).toFixed(1)}%`;
          const ratio = j.maxScore ? j.score / Math.max(1, (j.judgedCount / Math.max(1, j.totalNotes)) * j.maxScore) : 0;
          starsEl.textContent = starString(Math.min(5, Math.round(Math.max(0, Math.min(1, ratio)) * 10) / 2));
        },
        onStreak: (combo) => {
          streakEl.textContent = combo >= 100 ? `${combo} KILLSTREAK` : `${combo} COMBO`;
          streakEl.classList.remove('show');
          void streakEl.offsetWidth;
          streakEl.classList.add('show');
        },
        onTick: (pos, dur) => {
          progressEl.style.width = `${Math.max(0, Math.min(100, (pos / dur) * 100))}%`;
          if (mode === 'record' && session) scoreEl.textContent = String(session.recorded.length);
        },
        onCountdown: (n) => {
          countdownEl.textContent = n === null ? '' : String(n);
        },
        onFinish: (summary, recorded) => finish(summary, recorded),
      },
      app.input,
    );
    (window as unknown as { dkSession: GameSession | null }).dkSession = session;
    loading.remove();
    if (mode === 'practice') buildPracticeBar();
    await session.start(mode === 'record' ? studioState.countInBars * (60 / pkg.meta.bpm) * 4 : 3);
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
    pauseOverlay = h(
      'div',
      { class: 'pause-overlay' },
      h(
        'div',
        { class: 'menu' },
        h('h2', { class: 'display' }, 'PAUSED'),
        button('RESUME', togglePause, 'primary'),
        mode === 'record' ? button('FINISH TAKE', () => { pauseOverlay?.remove(); pauseOverlay = null; session?.finishNow(); }) : null,
        button('RESTART', () => restart()),
        button('QUIT', () => quit()),
      ),
    );
    el.appendChild(pauseOverlay);
  }

  function restart(): void {
    session?.stop();
    app.navigate('game', params);
  }

  function quit(): void {
    session?.stop();
    if (mode === 'record') app.navigate('studio');
    else app.navigate(mode === 'practice' ? 'songs-practice' : 'songs');
  }

  function finish(summary: ScoreSummary, recorded: PerformanceNote[]): void {
    if (mode === 'record') {
      studioState.recorded = recorded;
      toast(`Captured ${recorded.length} hits`, 'ok');
      app.navigate('studio', { step: 'quantize' });
      return;
    }
    app.navigate('results', { pkg, difficulty, mode, summary, rate });
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape') {
      e.preventDefault();
      togglePause();
    }
  };
  window.addEventListener('keydown', onKey);
  // Pause when the tab loses focus in play mode (fairness) — never in record mode.
  const onVis = () => {
    if (document.hidden && session && !session.isPaused && mode !== 'record' && !pauseOverlay) togglePause();
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
    },
  };
}
