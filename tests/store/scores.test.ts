import { describe, expect, it } from 'vitest';
import { MAX_SCORES_PER_TABLE, SCORES_KEY, ScoreStore, memoryKV } from '@/store';
import type { Difficulty, HighScore } from '@/types';

function hs(score: number, accuracy = 0.9, extra: Partial<HighScore> = {}): HighScore {
  return {
    songId: 'song-a',
    difficulty: 'expert',
    player: 'SAM',
    date: 1000 + score,
    score,
    maxCombo: 10,
    totalNotes: 100,
    hits: { perfect: 50, great: 30, good: 10, miss: 10 },
    accuracy,
    stars: 3,
    fullCombo: false,
    ...extra,
  };
}

describe('ScoreStore', () => {
  it('ranks by score then accuracy and reports new bests', () => {
    const store = new ScoreStore(memoryKV());
    expect(store.getBest('song-a', 'expert')).toBeUndefined();

    expect(store.submit(hs(1000))).toEqual({ rank: 1, isNewBest: true });
    expect(store.submit(hs(500))).toEqual({ rank: 2, isNewBest: false });
    expect(store.submit(hs(2000))).toEqual({ rank: 1, isNewBest: true });
    // Same score, better accuracy → ranks above, is new best.
    expect(store.submit(hs(2000, 0.95))).toEqual({ rank: 1, isNewBest: true });
    // Exact tie with best → not a new best, ranks below the earlier one.
    expect(store.submit(hs(2000, 0.95))).toEqual({ rank: 2, isNewBest: false });

    const top = store.getTop('song-a', 'expert');
    expect(top.map((s) => [s.score, s.accuracy])).toEqual([
      [2000, 0.95],
      [2000, 0.95],
      [2000, 0.9],
      [1000, 0.9],
      [500, 0.9],
    ]);
    expect(store.getTop('song-a', 'expert', 2)).toHaveLength(2);
    expect(store.getBest('song-a', 'expert')?.score).toBe(2000);
  });

  it('keeps tables per song and difficulty and caps at 25', () => {
    const store = new ScoreStore(memoryKV());
    for (let i = 1; i <= 30; i++) store.submit(hs(i * 10));
    expect(store.getTop('song-a', 'expert', 100)).toHaveLength(MAX_SCORES_PER_TABLE);
    expect(store.getTop('song-a', 'expert', 100).at(-1)?.score).toBe(60);
    // A score below the cutoff gets a rank but is not stored.
    expect(store.submit(hs(1))).toEqual({ rank: 26, isNewBest: false });
    expect(store.getTop('song-a', 'expert', 100)).toHaveLength(MAX_SCORES_PER_TABLE);

    store.submit(hs(5, 0.5, { difficulty: 'easy' }));
    store.submit(hs(7, 0.5, { songId: 'song-b' }));
    expect(store.getBestAllDifficulties('song-a')).toMatchObject({ easy: { score: 5 }, expert: { score: 300 } });
    expect(store.getBestAllDifficulties('song-a').hard).toBeUndefined();
    expect(store.songIds().sort()).toEqual(['song-a', 'song-b']);
  });

  it('clears selectively', () => {
    const store = new ScoreStore(memoryKV());
    store.submit(hs(1));
    store.submit(hs(2, 0.5, { difficulty: 'easy' }));
    store.submit(hs(3, 0.5, { songId: 'song-b' }));
    store.clear('song-a', 'easy');
    expect(store.getBest('song-a', 'easy')).toBeUndefined();
    expect(store.getBest('song-a', 'expert')?.score).toBe(1);
    store.clear('song-a');
    expect(store.getBestAllDifficulties('song-a')).toEqual({});
    expect(store.getBest('song-b', 'expert')?.score).toBe(3);
    store.clear();
    expect(store.songIds()).toEqual([]);
  });

  it('exports and imports JSON, merging without duplicates', () => {
    const kv = memoryKV();
    const a = new ScoreStore(kv);
    a.submit(hs(100));
    a.submit(hs(50, 0.5, { difficulty: 'hard' as Difficulty }));
    const json = a.exportJson();
    expect(JSON.parse(json).version).toBe(1);

    const b = new ScoreStore(memoryKV());
    b.submit(hs(200));
    expect(b.importJson(json)).toEqual({ imported: 2 });
    expect(b.importJson(json)).toEqual({ imported: 0 });
    expect(b.getTop('song-a', 'expert').map((s) => s.score)).toEqual([200, 100]);
    expect(b.getBest('song-a', 'hard')?.score).toBe(50);
    expect(() => b.importJson('nope')).toThrow(/not valid JSON/);
    expect(() => b.importJson('[1,2]')).toThrow(/expected an object/);
  });

  it('survives corrupt storage', () => {
    const store = new ScoreStore(memoryKV({ [SCORES_KEY]: '{"song-a":{"expert":[{"garbage":true}, 5]}}' }));
    expect(store.getTop('song-a', 'expert')).toEqual([]);
    expect(store.submit(hs(10)).rank).toBe(1);
    expect(() => store.submit({} as HighScore)).toThrow(/invalid HighScore/);
  });
});
