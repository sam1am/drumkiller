import type { Chart, PerformanceNote, SongPackage, Difficulty } from '@/types';

export type StudioTab = 'song' | 'record' | 'chart';

/**
 * Studio state — the song being edited (a working copy of a package) plus the last recorded take.
 * Survives navigation studio → game(record / test play) → studio.
 */
class StudioState {
  /** Working copy of the song being edited. Every tab mutates this; SAVE writes it to the library. */
  pkg: SongPackage | null = null;
  audioBuffer: AudioBuffer | null = null;
  /** Library id the working copy was last saved under; null for a song that has never been saved. */
  savedId: string | null = null;
  /** True when the working copy differs from what is in the library. */
  dirty = false;
  tab: StudioTab = 'song';
  /** Notes captured in the last recording pass (not yet applied to a chart). */
  recorded: PerformanceNote[] = [];
  /** Quantized take awaiting "use take". */
  chart: Chart | null = null;
  metronome = true;
  countInBars = 1;
  /** The difficulty being recorded / edited. */
  targetDifficulty: Difficulty = 'expert';
  /** Provided by the studio screen: builds the (empty-notes) chart used for beats/metronome during recording. */
  chartForRecording: (pkg: SongPackage, _?: unknown) => Chart = () => {
    throw new Error('Studio not initialised');
  };

  get open(): boolean {
    return this.pkg !== null;
  }

  reset(): void {
    this.pkg = null;
    this.audioBuffer = null;
    this.savedId = null;
    this.dirty = false;
    this.tab = 'song';
    this.recorded = [];
    this.chart = null;
  }
}

export const studioState = new StudioState();
