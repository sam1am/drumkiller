import { describe, expect, it } from 'vitest';
import { DRUM_VOICES } from '@/types';
import { DEVICE_PRESETS, GM_DRUM_NAMES, findPreset, noteForVoice, voiceForNote } from '@/midi/gm';

describe('gm mapping', () => {
  it('maps GM notes to voices', () => {
    expect(voiceForNote(35)).toBe('kick');
    expect(voiceForNote(36)).toBe('kick');
    expect(voiceForNote(37)).toBe('snare');
    expect(voiceForNote(39)).toBe('snare');
    expect(voiceForNote(41)).toBe('tomLow');
    expect(voiceForNote(45)).toBe('tomMid');
    expect(voiceForNote(50)).toBe('tomHigh');
    expect(voiceForNote(44)).toBe('hihatClosed');
    expect(voiceForNote(46)).toBe('hihatOpen');
    expect(voiceForNote(53)).toBe('ride');
    expect(voiceForNote(55)).toBe('crash');
    expect(voiceForNote(54)).toBeNull();
    expect(voiceForNote(60)).toBeNull();
    expect(voiceForNote(0)).toBeNull();
  });

  it('canonical notes round-trip through voiceForNote', () => {
    for (const v of DRUM_VOICES) expect(voiceForNote(noteForVoice(v))).toBe(v);
    expect(noteForVoice('kick')).toBe(36);
    expect(noteForVoice('crash')).toBe(49);
  });

  it('has GM names for 35–81', () => {
    for (let n = 35; n <= 81; n++) expect(typeof GM_DRUM_NAMES[n]).toBe('string');
    expect(GM_DRUM_NAMES[38]).toBe('Acoustic Snare');
  });

  it('presets bind every voice and findPreset matches port names', () => {
    for (const p of DEVICE_PRESETS) {
      for (const v of DRUM_VOICES) {
        expect(p.bindings[v].length).toBeGreaterThan(0);
        for (const b of p.bindings[v]) expect(voiceForNote(b.note)).toBe(v);
      }
    }
    expect(findPreset('FGDP-50').id).toBe('fgdp');
    expect(findPreset('Akai MPD218').id).toBe('mpc');
    expect(findPreset('Launchpad X LPX MIDI').id).toBe('mpc');
    expect(findPreset('Some Keyboard').id).toBe('gm');
    expect(findPreset('fgdp-30 Port 1').bindings.hihatClosed.map((b) => b.note)).toEqual([42, 44]);
  });
});
