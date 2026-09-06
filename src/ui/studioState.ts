import type { SongPackage, Difficulty } from '@/types';

export type StudioTab = 'song' | 'chart';

/**
 * Studio state — the song being edited (a working copy of a package) plus editor preferences.
 * Survives navigation studio → game (test play) → studio.
 */
class StudioState {
  /** Working copy of the song being edited. Every tab mutates this; SAVE writes it to the library. */
  pkg: SongPackage | null = null;
  /** Decoded drum-less mix (`meta.audio`). */
  audioBuffer: AudioBuffer | null = null;
  /** Decoded mix with drums (`meta.audioWithDrums`), when the song has one. */
  drumsBuffer: AudioBuffer | null = null;
  /** Library id the working copy was last saved under; null for a song that has never been saved. */
  savedId: string | null = null;
  /** True when the working copy differs from what is in the library. */
  dirty = false;
  tab: StudioTab = 'song';
  /** Chart editor recording: click while recording. */
  metronome = true;
  /** Chart editor recording: bars of count-in before the take starts. */
  countInBars = 1;
  /** The difficulty being edited. */
  targetDifficulty: Difficulty = 'expert';

  get open(): boolean {
    return this.pkg !== null;
  }

  reset(): void {
    this.pkg = null;
    this.audioBuffer = null;
    this.drumsBuffer = null;
    this.savedId = null;
    this.dirty = false;
    this.tab = 'song';
  }
}

export const studioState = new StudioState();
