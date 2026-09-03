import { describe, expect, it } from 'vitest';
import { Judge, hitWindowsFor, starsForRatio, starString } from '@/game/scoring';
import type { ChartNote } from '@/types';

function n(time: number, voice: ChartNote['voice']): ChartNote {
  return { time, tick: Math.round(time * 480), voice, velocity: 0.8 };
}

const opts = { difficulty: 'expert' as const, strictVoices: true, overhitBreaksCombo: true };

describe('Judge', () => {
  it('judges perfect/great/good by timing window', () => {
    const j = new Judge([n(1, 'snare'), n(2, 'snare'), n(3, 'snare')], opts);
    expect(j.hit('snare', 1.01).judgement).toBe('perfect');
    expect(j.hit('snare', 2.05).judgement).toBe('great');
    expect(j.hit('snare', 3.1).judgement).toBe('good');
    expect(j.combo).toBe(3);
    expect(j.hits).toEqual({ perfect: 1, great: 1, good: 1, miss: 0 });
  });

  it('counts overhits and breaks combo', () => {
    const j = new Judge([n(1, 'kick'), n(2, 'kick')], opts);
    j.hit('kick', 1);
    expect(j.combo).toBe(1);
    const ev = j.hit('kick', 1.5);
    expect(ev.kind).toBe('overhit');
    expect(j.combo).toBe(0);
    expect(j.overhits).toBe(1);
  });

  it('detects misses on update()', () => {
    const j = new Judge([n(1, 'kick'), n(2, 'snare')], opts);
    const evs = j.update(1.5);
    expect(evs.length).toBe(1);
    expect(evs[0].kind).toBe('miss');
    expect(j.hits.miss).toBe(1);
    expect(j.update(1.6).length).toBe(0);
    expect(j.update(3).length).toBe(1);
    expect(j.finished).toBe(true);
  });

  it('strict voices reject same-lane wrong voice; lenient accepts as great at best', () => {
    const strict = new Judge([n(1, 'tomHigh')], opts);
    expect(strict.hit('tomLow', 1).kind).toBe('overhit');
    const lenient = new Judge([n(1, 'tomHigh')], { ...opts, strictVoices: false });
    const ev = lenient.hit('tomLow', 1);
    expect(ev.kind).toBe('hit');
    expect(ev.judgement).toBe('great');
  });

  it('prefers exact voice match among simultaneous notes', () => {
    const j = new Judge([n(1, 'hihatClosed'), n(1, 'hihatOpen')], { ...opts, strictVoices: false });
    const ev = j.hit('hihatOpen', 1.0);
    expect(ev.voice).toBe('hihatOpen');
    expect(ev.judgement).toBe('perfect');
  });

  it('multiplier ramps every 10 combo up to 4x and score accumulates', () => {
    const notes = Array.from({ length: 40 }, (_, i) => n(i + 1, 'kick'));
    const j = new Judge(notes, opts);
    notes.forEach((x) => j.hit('kick', x.time));
    expect(j.multiplier).toBe(4);
    expect(j.score).toBe(j.maxScore);
    const s = j.summary();
    expect(s.fullCombo).toBe(true);
    expect(s.stars).toBe(5);
    expect(s.accuracy).toBe(1);
  });

  it('reseek restores pending state for notes after t', () => {
    const j = new Judge([n(1, 'kick'), n(2, 'kick'), n(3, 'kick')], opts);
    j.hit('kick', 1);
    j.update(2.5);
    j.reseek(1.5);
    expect(j.notes[0].state).toBe('hit');
    expect(j.notes[1].state).toBe('pending');
    expect(j.score).toBe(0);
    expect(j.hit('kick', 2).judgement).toBe('perfect');
  });

  it('windows widen on easier difficulties', () => {
    expect(hitWindowsFor('easy').good).toBeGreaterThan(hitWindowsFor('expert').good);
  });

  it('star helpers', () => {
    expect(starsForRatio(1, 1)).toBe(5);
    expect(starsForRatio(0, 0)).toBe(0);
    expect(starString(3.5)).toBe('★★★½☆');
  });
});
