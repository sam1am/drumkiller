import { LANE_FOR_VOICE, type ChartNote, type Difficulty, type DrumVoice, type HitWindows, type Judgement, type ScoreSummary } from '@/types';

/** Hit windows in seconds (±). Slightly wider on easier difficulties. */
export function hitWindowsFor(difficulty: Difficulty): HitWindows {
  switch (difficulty) {
    case 'easy':
      return { perfect: 0.05, great: 0.09, good: 0.14 };
    case 'medium':
      return { perfect: 0.045, great: 0.085, good: 0.13 };
    case 'hard':
      return { perfect: 0.04, great: 0.075, good: 0.115 };
    default:
      return { perfect: 0.035, great: 0.07, good: 0.11 };
  }
}

export const BASE_NOTE_SCORE = 100;
export const MAX_MULTIPLIER = 4;
export const COMBO_PER_MULTIPLIER = 10;
export const JUDGEMENT_FACTOR: Record<Judgement, number> = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };

export interface JudgeEvent {
  kind: 'hit' | 'miss' | 'overhit';
  judgement: Judgement;
  /** Signed timing error (hit time - note time), seconds. 0 for misses/overhits. */
  delta: number;
  voice: DrumVoice;
  noteIndex: number; // -1 for overhits
  combo: number;
  score: number;
  multiplier: number;
}

export interface TrackedNote extends ChartNote {
  index: number;
  state: 'pending' | 'hit' | 'missed';
  judgement?: Judgement;
  delta?: number;
}

export interface JudgeOptions {
  difficulty: Difficulty;
  /** When true (hard/expert), the exact voice must match; when false, any voice on the same lane counts (max 'great'). */
  strictVoices: boolean;
  /** Overhits (hits with nothing to hit) break the combo. */
  overhitBreaksCombo: boolean;
  windows?: HitWindows;
}

/**
 * The Judge owns the note list for a play session, scores incoming hits, detects misses,
 * and keeps score/combo/multiplier state. Pure logic — no timers, no DOM.
 */
export class Judge {
  readonly notes: TrackedNote[];
  readonly windows: HitWindows;
  readonly opts: JudgeOptions;
  score = 0;
  combo = 0;
  maxCombo = 0;
  hits: Record<Judgement, number> = { perfect: 0, great: 0, good: 0, miss: 0 };
  overhits = 0;
  private nextPendingIndex = 0;
  private listeners = new Set<(ev: JudgeEvent) => void>();
  /** Running sum of absolute timing errors for hits (for the results screen). */
  private deltaSum = 0;
  private deltaSigned = 0;
  private deltaCount = 0;

  constructor(notes: ChartNote[], opts: JudgeOptions) {
    this.opts = opts;
    this.windows = opts.windows ?? hitWindowsFor(opts.difficulty);
    this.notes = notes.map((n, index) => ({ ...n, index, state: 'pending' as const }));
  }

  onEvent(fn: (ev: JudgeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get multiplier(): number {
    return Math.min(MAX_MULTIPLIER, 1 + Math.floor(this.combo / COMBO_PER_MULTIPLIER));
  }

  get totalNotes(): number {
    return this.notes.length;
  }

  get judgedCount(): number {
    return this.hits.perfect + this.hits.great + this.hits.good + this.hits.miss;
  }

  /** Maximum achievable score for this chart (all perfects, multiplier ramps as usual). */
  get maxScore(): number {
    let s = 0;
    for (let i = 0; i < this.notes.length; i++) {
      const mult = Math.min(MAX_MULTIPLIER, 1 + Math.floor((i + 1) / COMBO_PER_MULTIPLIER));
      s += BASE_NOTE_SCORE * mult;
    }
    return s;
  }

  /** Mean absolute timing error in seconds for judged hits. */
  get meanAbsError(): number {
    return this.deltaCount ? this.deltaSum / this.deltaCount : 0;
  }

  /** Mean signed timing error (negative = early). */
  get meanSignedError(): number {
    return this.deltaCount ? this.deltaSigned / this.deltaCount : 0;
  }

  /** Accuracy 0..1 weighted by judgement factor over all judged notes. */
  get accuracy(): number {
    const judged = this.judgedCount;
    if (!judged) return 1;
    const weighted = this.hits.perfect + this.hits.great * JUDGEMENT_FACTOR.great + this.hits.good * JUDGEMENT_FACTOR.good;
    return weighted / judged;
  }

  /**
   * Process a hit at chart time `t` for `voice`.
   */
  hit(voice: DrumVoice, t: number): JudgeEvent {
    const lane = LANE_FOR_VOICE[voice];
    const win = this.windows.good;
    let best: TrackedNote | null = null;
    let bestScore = Infinity;
    let bestExact = false;
    // Scan pending notes within the window.
    for (let i = this.nextPendingIndex; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > win) break;
      if (n.state !== 'pending') continue;
      if (t - n.time > win) continue;
      const exact = n.voice === voice;
      const sameLane = LANE_FOR_VOICE[n.voice] === lane;
      if (!exact && !sameLane) continue;
      if (!exact && this.opts.strictVoices) continue;
      // Prefer exact voice matches, then closest in time.
      const dist = Math.abs(n.time - t) + (exact ? 0 : 1);
      if (dist < bestScore) {
        bestScore = dist;
        best = n;
        bestExact = exact;
      }
    }
    if (!best) {
      this.overhits++;
      if (this.opts.overhitBreaksCombo) this.combo = 0;
      const ev: JudgeEvent = { kind: 'overhit', judgement: 'miss', delta: 0, voice, noteIndex: -1, combo: this.combo, score: this.score, multiplier: this.multiplier };
      this.emit(ev);
      return ev;
    }
    const delta = t - best.time;
    const ad = Math.abs(delta);
    let judgement: Judgement = ad <= this.windows.perfect ? 'perfect' : ad <= this.windows.great ? 'great' : 'good';
    if (!bestExact && judgement === 'perfect') judgement = 'great';
    best.state = 'hit';
    best.judgement = judgement;
    best.delta = delta;
    this.hits[judgement]++;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.score += Math.round(BASE_NOTE_SCORE * JUDGEMENT_FACTOR[judgement] * this.multiplier);
    this.deltaSum += ad;
    this.deltaSigned += delta;
    this.deltaCount++;
    this.advancePointer();
    const ev: JudgeEvent = { kind: 'hit', judgement, delta, voice: best.voice, noteIndex: best.index, combo: this.combo, score: this.score, multiplier: this.multiplier };
    this.emit(ev);
    return ev;
  }

  /** Mark every pending note older than (t - goodWindow) as missed. Call every frame. */
  update(t: number): JudgeEvent[] {
    const out: JudgeEvent[] = [];
    const cutoff = t - this.windows.good;
    for (let i = this.nextPendingIndex; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time > cutoff) break;
      if (n.state !== 'pending') continue;
      n.state = 'missed';
      n.judgement = 'miss';
      this.hits.miss++;
      this.combo = 0;
      const ev: JudgeEvent = { kind: 'miss', judgement: 'miss', delta: 0, voice: n.voice, noteIndex: n.index, combo: 0, score: this.score, multiplier: this.multiplier };
      this.emit(ev);
      out.push(ev);
    }
    this.advancePointer();
    return out;
  }

  /** Reset judging state for a seek (practice mode). Notes before `t` are treated as done, after as pending. */
  reseek(t: number): void {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.overhits = 0;
    this.hits = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.deltaSum = 0;
    this.deltaSigned = 0;
    this.deltaCount = 0;
    for (const n of this.notes) {
      n.state = n.time < t - this.windows.good ? 'hit' : 'pending';
      n.judgement = undefined;
      n.delta = undefined;
    }
    this.nextPendingIndex = 0;
    this.advancePointer();
  }

  get finished(): boolean {
    return this.nextPendingIndex >= this.notes.length;
  }

  summary(): ScoreSummary {
    const ratio = this.maxScore ? this.score / this.maxScore : 0;
    const total = this.notes.length;
    const fullCombo = total > 0 && this.hits.miss === 0 && this.maxCombo === total;
    return {
      score: this.score,
      maxCombo: this.maxCombo,
      totalNotes: total,
      hits: { ...this.hits },
      accuracy: this.accuracy,
      stars: starsForRatio(ratio, this.accuracy),
      fullCombo,
    };
  }

  private advancePointer(): void {
    while (this.nextPendingIndex < this.notes.length && this.notes[this.nextPendingIndex].state !== 'pending') this.nextPendingIndex++;
  }

  private emit(ev: JudgeEvent): void {
    this.listeners.forEach((fn) => fn(ev));
  }
}

/** Star rating 0..5 (with 0.5 steps) from score ratio and accuracy. */
export function starsForRatio(ratio: number, accuracy: number): number {
  const r = Math.max(ratio, accuracy * 0.9);
  if (r >= 0.97) return 5;
  if (r >= 0.92) return 4.5;
  if (r >= 0.85) return 4;
  if (r >= 0.75) return 3.5;
  if (r >= 0.65) return 3;
  if (r >= 0.55) return 2.5;
  if (r >= 0.45) return 2;
  if (r >= 0.35) return 1.5;
  if (r >= 0.25) return 1;
  if (r >= 0.15) return 0.5;
  return 0;
}

export function starString(stars: number): string {
  const full = Math.floor(stars);
  const half = stars - full >= 0.5;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(5 - full - (half ? 1 : 0));
}
