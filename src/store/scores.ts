/** High-score table persisted through a KV. Keeps the top N per (song, difficulty). */
import type { Difficulty, HighScore, Judgement } from '@/types';
import { DIFFICULTIES } from '@/types';
import { readJson, writeJson, type KV } from './kv';

export const SCORES_KEY = 'dk.scores.v1';
export const MAX_SCORES_PER_TABLE = 25;

type ScoreTable = Partial<Record<Difficulty, HighScore[]>>;
type ScoreData = Record<string, ScoreTable>;

/** Descending score, then descending accuracy. Stable: earlier entries win exact ties. */
export function compareScores(a: HighScore, b: HighScore): number {
  return b.score - a.score || b.accuracy - a.accuracy;
}

const JUDGEMENTS: Judgement[] = ['perfect', 'great', 'good', 'miss'];

function isHighScore(v: unknown): v is HighScore {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (typeof s.songId !== 'string' || !DIFFICULTIES.includes(s.difficulty as Difficulty)) return false;
  if (typeof s.score !== 'number' || typeof s.accuracy !== 'number') return false;
  if (!s.hits || typeof s.hits !== 'object') return false;
  return JUDGEMENTS.every((j) => typeof (s.hits as Record<string, unknown>)[j] === 'number');
}

function normalizeScore(s: HighScore): HighScore {
  return {
    songId: s.songId,
    difficulty: s.difficulty,
    player: typeof s.player === 'string' ? s.player : 'PLAYER',
    date: typeof s.date === 'number' ? s.date : Date.now(),
    score: s.score,
    maxCombo: typeof s.maxCombo === 'number' ? s.maxCombo : 0,
    totalNotes: typeof s.totalNotes === 'number' ? s.totalNotes : 0,
    hits: { perfect: s.hits.perfect, great: s.hits.great, good: s.hits.good, miss: s.hits.miss },
    accuracy: s.accuracy,
    stars: typeof s.stars === 'number' ? s.stars : 0,
    fullCombo: Boolean(s.fullCombo),
  };
}

export class ScoreStore {
  constructor(private readonly kv: KV) {}

  private read(): ScoreData {
    const data = readJson<unknown>(this.kv, SCORES_KEY, {});
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as ScoreData) : {};
  }

  private write(data: ScoreData): void {
    writeJson(this.kv, SCORES_KEY, data);
  }

  private table(data: ScoreData, songId: string, difficulty: Difficulty): HighScore[] {
    const list = data[songId]?.[difficulty];
    return Array.isArray(list) ? list.filter(isHighScore) : [];
  }

  getTop(songId: string, difficulty: Difficulty, limit = 10): HighScore[] {
    return this.table(this.read(), songId, difficulty).slice(0, Math.max(0, limit));
  }

  getBest(songId: string, difficulty: Difficulty): HighScore | undefined {
    return this.table(this.read(), songId, difficulty)[0];
  }

  getBestAllDifficulties(songId: string): Partial<Record<Difficulty, HighScore>> {
    const data = this.read();
    const out: Partial<Record<Difficulty, HighScore>> = {};
    for (const d of DIFFICULTIES) {
      const best = this.table(data, songId, d)[0];
      if (best) out[d] = best;
    }
    return out;
  }

  /** Song ids that have at least one score. */
  songIds(): string[] {
    return Object.keys(this.read());
  }

  /**
   * Record a score. `rank` is 1-based within the (song, difficulty) table; scores beyond the
   * table size still get a rank but are not persisted. `isNewBest` means it strictly beat the
   * previous best (a tie with the previous best is not a new best).
   */
  submit(score: HighScore): { rank: number; isNewBest: boolean } {
    if (!isHighScore(score)) throw new Error('ScoreStore.submit: invalid HighScore');
    const entry = normalizeScore(score);
    const data = this.read();
    const list = this.table(data, entry.songId, entry.difficulty);
    const prevBest = list[0];
    const isNewBest = prevBest === undefined || compareScores(entry, prevBest) < 0;

    // Insert after any existing entries that are >= this one (stable ordering).
    let rank = list.length + 1;
    for (let i = 0; i < list.length; i++) {
      if (compareScores(entry, list[i]) < 0) {
        rank = i + 1;
        break;
      }
    }
    list.splice(rank - 1, 0, entry);
    list.sort(compareScores);
    const trimmed = list.slice(0, MAX_SCORES_PER_TABLE);

    (data[entry.songId] ??= {})[entry.difficulty] = trimmed;
    this.write(data);
    return { rank, isNewBest };
  }

  /** Clear everything, one song, or one song+difficulty. */
  clear(songId?: string, difficulty?: Difficulty): void {
    if (songId === undefined) {
      this.kv.remove(SCORES_KEY);
      return;
    }
    const data = this.read();
    if (!data[songId]) return;
    if (difficulty === undefined) {
      delete data[songId];
    } else {
      delete data[songId][difficulty];
      if (Object.keys(data[songId]).length === 0) delete data[songId];
    }
    this.write(data);
  }

  exportJson(): string {
    return JSON.stringify({ version: 1, scores: this.read() }, null, 2);
  }

  /** Merge scores from a previous export (or a raw table). Duplicate entries are collapsed. */
  importJson(json: string): { imported: number } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      throw new Error(`ScoreStore.importJson: not valid JSON (${(e as Error).message})`);
    }
    const source =
      parsed && typeof parsed === 'object' && 'scores' in (parsed as object)
        ? (parsed as { scores: unknown }).scores
        : parsed;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('ScoreStore.importJson: expected an object of scores');
    }

    const data = this.read();
    let imported = 0;
    for (const [songId, table] of Object.entries(source as Record<string, unknown>)) {
      if (!table || typeof table !== 'object') continue;
      for (const d of DIFFICULTIES) {
        const list = (table as Record<string, unknown>)[d];
        if (!Array.isArray(list)) continue;
        const existing = this.table(data, songId, d);
        const seen = new Set(existing.map(fingerprint));
        for (const raw of list) {
          if (!isHighScore(raw)) continue;
          const s = normalizeScore({ ...raw, songId, difficulty: d });
          const fp = fingerprint(s);
          if (seen.has(fp)) continue;
          seen.add(fp);
          existing.push(s);
          imported++;
        }
        existing.sort(compareScores);
        (data[songId] ??= {})[d] = existing.slice(0, MAX_SCORES_PER_TABLE);
      }
    }
    this.write(data);
    return { imported };
  }
}

function fingerprint(s: HighScore): string {
  return `${s.player}|${s.date}|${s.score}|${s.accuracy}`;
}
