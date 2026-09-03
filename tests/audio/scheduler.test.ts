import { describe, expect, it } from 'vitest';
import { createWindowState, nextWindow } from '@/audio/scheduler';

describe('nextWindow', () => {
  it('returns nothing while stopped', () => {
    const s = createWindowState();
    expect(nextWindow(s, false, 0, 0, 0)).toBeNull();
    expect(nextWindow(s, false, 0, 0, 0)).toBeNull();
  });

  it('starts at the segment start on the first playing tick, then advances contiguously', () => {
    const s = createWindowState();
    const w1 = nextWindow(s, true, 1, 0, 0.12)!;
    expect(w1).toEqual({ from: 0, to: 0.12, reset: true });
    const w2 = nextWindow(s, true, 1, 0, 0.145)!;
    expect(w2).toEqual({ from: 0.12, to: 0.145, reset: false });
    // Horizon not advanced (timer jitter) → nothing.
    expect(nextWindow(s, true, 1, 0, 0.145)).toBeNull();
  });

  it('resets on generation change (seek / rate change) and after pause', () => {
    const s = createWindowState();
    nextWindow(s, true, 1, 0, 0.1);
    nextWindow(s, true, 1, 0, 0.2);
    // Seek backwards to 0.05 (generation bump).
    const w = nextWindow(s, true, 2, 0.05, 0.16)!;
    expect(w.reset).toBe(true);
    expect(w.from).toBe(0.05);
    expect(w.to).toBe(0.16);
    // Pause: one reset notification, then silence.
    expect(nextWindow(s, false, 3, 0, 0)).toEqual({ from: 0, to: 0, reset: true });
    expect(nextWindow(s, false, 3, 0, 0)).toBeNull();
    // Resume from the paused position — window restarts there.
    const r = nextWindow(s, true, 4, 0.1, 0.21)!;
    expect(r).toEqual({ from: 0.1, to: 0.21, reset: true });
  });

  it('supports negative (pre-roll) positions', () => {
    const s = createWindowState();
    const w = nextWindow(s, true, 1, -2, -1.9)!;
    expect(w.from).toBe(-2);
    expect(w.to).toBe(-1.9);
  });
});
