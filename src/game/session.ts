import type { Chart, Difficulty, DrumVoice, InputHit, PerformanceNote, ScoreSummary, SongMeta } from '@/types';
import { Transport, ChartPlayer, Metronome } from '@/audio';
import type { AudioEngine, DrumKit } from '@/audio';
import { ticksToSeconds } from '@/midi';
import { Judge, type JudgeEvent } from './scoring';
import { HighwayRenderer, type BeatMark, type RenderState } from './renderer';

export type GameMode = 'play' | 'practice' | 'record';

export interface SessionConfig {
  mode: GameMode;
  meta: SongMeta;
  chart: Chart; // for record mode: may be empty (notes: []), used for beats/tempo
  difficulty: Difficulty;
  audio: AudioBuffer;
  rate?: number;
  /** Practice: play the chart's drums as a guide. */
  guideDrums?: boolean;
  /** Record: metronome on. */
  metronome?: boolean;
  /** Record: count-in bars. */
  countInBars?: number;
  inputOffset: number;
  hitWindowScale: number;
  strictVoices: boolean;
  scrollWindow: number;
  drumSoundsOnHit: boolean;
  reducedMotion: boolean;
  /** Loop region for practice (chart seconds). */
  loop?: { start: number; end: number } | null;
}

export interface SessionCallbacks {
  onJudge?: (ev: JudgeEvent) => void;
  onStreak?: (combo: number) => void;
  onFinish?: (summary: ScoreSummary, recorded: PerformanceNote[]) => void;
  onTick?: (position: number, duration: number) => void;
  onCountdown?: (n: number | null) => void;
}

/**
 * A single play/practice/record session: ties Transport, Judge, Renderer, DrumKit, and input together.
 */
export class GameSession {
  readonly transport: Transport;
  readonly judge: Judge;
  readonly renderer: HighwayRenderer;
  readonly beats: BeatMark[];
  readonly recorded: PerformanceNote[] = [];
  private guide: ChartPlayer | null = null;
  private metro: Metronome | null = null;
  private raf = 0;
  private running = false;
  private finished = false;
  private unsubInput: (() => void) | null = null;
  private countdownTimer = 0;
  private lastStreak = 0;
  private paused = false;
  private resizeHandler = () => this.renderer.resize();
  private latencyComp = 0;

  constructor(
    private engine: AudioEngine,
    private kit: DrumKit,
    canvas: HTMLCanvasElement,
    readonly cfg: SessionConfig,
    private cb: SessionCallbacks,
    private inputSource: { onHit(fn: (hit: InputHit) => void): () => void },
  ) {
    this.transport = new Transport(engine);
    this.transport.load(cfg.audio);
    this.transport.setRate(cfg.rate ?? 1);
    this.judge = new Judge(cfg.mode === 'record' ? [] : cfg.chart.notes, {
      difficulty: cfg.difficulty,
      strictVoices: cfg.strictVoices && (cfg.difficulty === 'hard' || cfg.difficulty === 'expert'),
      overhitBreaksCombo: cfg.mode !== 'record',
      windowScale: cfg.hitWindowScale,
    });
    this.renderer = new HighwayRenderer(canvas);
    this.renderer.setReducedMotion(cfg.reducedMotion);
    this.beats = computeBeats(cfg.chart, this.audioDuration - cfg.meta.offset);
    this.judge.onEvent((ev) => this.handleJudge(ev));
    if (cfg.mode === 'practice' && cfg.guideDrums) {
      this.guide = new ChartPlayer(engine, kit, this.transport);
      this.guide.setNotes(cfg.chart.notes);
      this.guide.setOffset(cfg.meta.offset);
    }
    if (cfg.mode === 'record' && cfg.metronome) {
      this.metro = new Metronome(engine, this.transport);
      this.metro.setTempoMap(cfg.chart.tempoMap, cfg.chart.ppq, cfg.chart.timeSignatures);
      this.metro.setOffset(cfg.meta.offset);
    }
    // Compensate for audio output latency: what the player hears is later than the audio clock.
    this.latencyComp = engine.inputLatencyCompensation;
    window.addEventListener('resize', this.resizeHandler);
  }

  get audioDuration(): number {
    return this.cfg.audio.duration;
  }

  /** Chart time now. */
  get chartTime(): number {
    return this.transport.position - this.cfg.meta.offset;
  }

  /** Chart time as the judge sees it for a hit arriving now (input offset + latency compensation applied). */
  private judgeTime(chartTime: number): number {
    return chartTime + this.cfg.inputOffset - this.latencyComp * this.transport.rate;
  }

  get duration(): number {
    return Math.max(this.cfg.chart.duration, this.audioDuration - this.cfg.meta.offset);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Start with a count-in (seconds of pre-roll before audio time 0). */
  async start(countInSeconds = 3): Promise<void> {
    await this.metro?.prepare();
    this.running = true;
    this.paused = false;
    this.unsubInput = this.inputSource.onHit((hit) => this.handleHit(hit));
    const from = this.cfg.loop ? this.cfg.loop.start + this.cfg.meta.offset - 1.5 : -countInSeconds;
    this.transport.play(from);
    this.guide?.start();
    this.metro?.start();
    this.transport.onEnded = () => this.onAudioEnded();
    this.runCountdown(countInSeconds);
    this.loop();
  }

  private runCountdown(seconds: number): void {
    if (seconds <= 0) return;
    let n = Math.ceil(seconds);
    this.cb.onCountdown?.(n);
    clearInterval(this.countdownTimer);
    this.countdownTimer = window.setInterval(() => {
      n--;
      if (n <= 0) {
        clearInterval(this.countdownTimer);
        this.cb.onCountdown?.(null);
      } else this.cb.onCountdown?.(n);
    }, 1000 / this.transport.rate);
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.transport.pause();
    this.guide?.stop();
    this.metro?.stop();
    clearInterval(this.countdownTimer);
    this.cb.onCountdown?.(null);
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    // Rewind a touch so the player can get back into the groove
    const pos = Math.max(-1.5, this.transport.position - 1.5);
    this.judge.reseek(pos - this.cfg.meta.offset);
    this.transport.play(pos);
    this.guide?.start();
    this.metro?.start();
    this.runCountdown(1.5);
  }

  setRate(rate: number): void {
    this.transport.setRate(rate);
  }

  /** Live-adjust the input offset (seconds) — affects hits from now on. */
  setInputOffset(seconds: number): void {
    (this.cfg as { inputOffset: number }).inputOffset = seconds;
  }

  /** Practice: jump to a chart time. */
  seek(chartTime: number): void {
    const pos = chartTime + this.cfg.meta.offset;
    this.judge.reseek(chartTime);
    this.transport.seek(pos);
    this.guide?.resync();
    this.metro?.resync();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    clearInterval(this.countdownTimer);
    this.transport.stop();
    this.guide?.stop();
    this.metro?.stop();
    this.unsubInput?.();
    window.removeEventListener('resize', this.resizeHandler);
  }

  private handleHit(hit: InputHit): void {
    if (!this.running || this.paused) return;
    if (this.cfg.drumSoundsOnHit) this.kit.trigger(hit.voice, hit.velocity);
    const pos = this.transport.positionAtPerfTime(hit.timeStamp);
    const t = this.judgeTime(pos - this.cfg.meta.offset);
    if (this.cfg.mode === 'record') {
      if (t >= -0.5) this.recorded.push({ time: t, voice: hit.voice, velocity: hit.velocity });
      this.renderer.hitFlash(hit.voice, 'perfect');
      return;
    }
    if (t < -0.5) return;
    this.judge.hit(hit.voice, t);
  }

  private handleJudge(ev: JudgeEvent): void {
    if (ev.kind === 'hit') this.renderer.hitFlash(ev.voice, ev.judgement);
    else if (ev.kind === 'overhit') this.renderer.hitFlash(ev.voice, 'over');
    else this.renderer.hitFlash(ev.voice, 'miss');
    this.cb.onJudge?.(ev);
    const milestones = [25, 50, 100, 150, 200, 300, 400, 500, 750, 1000];
    if (ev.kind === 'hit' && milestones.includes(ev.combo) && ev.combo !== this.lastStreak) {
      this.lastStreak = ev.combo;
      this.renderer.streakBurst();
      this.cb.onStreak?.(ev.combo);
    }
  }

  private loop = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const t = this.chartTime;
    if (!this.paused) {
      this.judge.update(this.judgeTime(t));
      if (this.cfg.loop && t >= this.cfg.loop.end) {
        this.seek(this.cfg.loop.start);
      }
    }
    const state: RenderState = {
      time: t,
      window: this.cfg.scrollWindow * (this.cfg.mode === 'practice' ? 1 : 1),
      notes: this.judge.notes,
      beats: this.beats,
      combo: this.judge.combo,
      multiplier: this.judge.multiplier,
      mode: this.cfg.mode,
      recorded: this.recorded,
      paused: this.paused,
      accent: this.cfg.meta.accent,
    };
    this.renderer.draw(state);
    this.cb.onTick?.(this.transport.position, this.audioDuration);
    if (!this.finished && !this.paused && this.cfg.mode !== 'record' && this.judge.finished && t > this.cfg.chart.duration && this.cfg.mode === 'play') {
      // Chart done: end a little early rather than waiting for a long outro.
      if (t > this.duration - 0.5 || t > this.cfg.chart.duration + 4) this.finish();
    }
  };

  /** End the session now with whatever has been played/recorded (used by 'finish take'). */
  finishNow(): void {
    this.finish();
  }

  private onAudioEnded(): void {
    if (this.paused || !this.running) return;
    this.finish();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    const summary = this.judge.summary();
    const rec = this.recorded.slice().sort((a, b) => a.time - b.time);
    this.stop();
    this.cb.onFinish?.(summary, rec);
  }
}

/** Beat/bar markers across the chart from its tempo map + time signatures. */
export function computeBeats(chart: Chart, untilSeconds: number): BeatMark[] {
  const out: BeatMark[] = [];
  const ppq = chart.ppq;
  const sigs = chart.timeSignatures.length ? chart.timeSignatures : [{ tick: 0, numerator: 4, denominator: 4 }];
  const end = Math.max(untilSeconds, chart.duration) + 4;
  let tick = 0;
  let beatInBar = 0;
  let guard = 0;
  while (guard++ < 200000) {
    let sig = sigs[0];
    for (const s of sigs) if (s.tick <= tick) sig = s;
    const beatTicks = (ppq * 4) / sig.denominator;
    const time = ticksToSeconds(tick, chart.tempoMap, ppq);
    if (time > end) break;
    out.push({ time, bar: beatInBar === 0 });
    beatInBar = (beatInBar + 1) % sig.numerator;
    tick += beatTicks;
  }
  return out;
}

export const VOICE_ORDER_FOR_UI: DrumVoice[] = ['kick', 'snare', 'hihatClosed', 'hihatOpen', 'tomHigh', 'tomMid', 'tomLow', 'ride', 'crash'];
