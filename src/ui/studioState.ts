import type { Chart, PerformanceNote, SongPackage, Difficulty, DrumVoice } from '@/types';

/**
 * Studio (recorder) state survives navigation studio → game(record) → studio.
 */
class StudioState {
  pkg: SongPackage | null = null;
  audioBuffer: AudioBuffer | null = null;
  /** Notes captured in the last recording pass. */
  recorded: PerformanceNote[] = [];
  /** Quantized + reviewed notes ready to save. */
  chart: Chart | null = null;
  metronome = true;
  countInBars = 1;
  targetDifficulty: Difficulty = 'expert';
  customSamples: Partial<Record<DrumVoice, { blob: Blob; fileName: string }>> = {};
  /** Provided by the studio screen: builds the (empty-notes) chart used for beats/metronome during recording. */
  chartForRecording: (pkg: SongPackage, _?: unknown) => Chart = () => {
    throw new Error('Studio not initialised');
  };

  reset(): void {
    this.pkg = null;
    this.audioBuffer = null;
    this.recorded = [];
    this.chart = null;
    this.customSamples = {};
  }
}

export const studioState = new StudioState();
