/**
 * DRUMKILLER — shared data contracts.
 * Every module (midi, audio, song, game, ui, store) imports from here.
 * Keep this file dependency-free.
 */

// ─────────────────────────── Drum voices & lanes ───────────────────────────

/** The individual drum sounds the game understands. */
export type DrumVoice =
  | 'kick'
  | 'snare'
  | 'tomHigh'
  | 'tomMid'
  | 'tomLow'
  | 'hihatClosed'
  | 'hihatOpen'
  | 'ride'
  | 'crash';

export const DRUM_VOICES: readonly DrumVoice[] = [
  'kick',
  'snare',
  'tomHigh',
  'tomMid',
  'tomLow',
  'hihatClosed',
  'hihatOpen',
  'ride',
  'crash',
] as const;

export const VOICE_LABELS: Record<DrumVoice, string> = {
  kick: 'Kick',
  snare: 'Snare',
  tomHigh: 'High Tom',
  tomMid: 'Mid Tom',
  tomLow: 'Low Tom',
  hihatClosed: 'Hi-Hat (closed)',
  hihatOpen: 'Hi-Hat (open)',
  ride: 'Ride',
  crash: 'Crash',
};

/** Visual lanes on the note highway. Crash is a full-width horizontal bar. */
export type Lane = 'hihat' | 'snare' | 'kick' | 'toms' | 'ride' | 'crash';

/** Left-to-right order of the vertical lanes (crash spans all of them). */
export const LANE_ORDER: readonly Lane[] = ['hihat', 'snare', 'kick', 'toms', 'ride'] as const;

export const LANE_FOR_VOICE: Record<DrumVoice, Lane> = {
  kick: 'kick',
  snare: 'snare',
  tomHigh: 'toms',
  tomMid: 'toms',
  tomLow: 'toms',
  hihatClosed: 'hihat',
  hihatOpen: 'hihat',
  ride: 'ride',
  crash: 'crash',
};

export const LANE_LABELS: Record<Lane, string> = {
  hihat: 'HI-HAT',
  snare: 'SNARE',
  kick: 'KICK',
  toms: 'TOMS',
  ride: 'RIDE',
  crash: 'CRASH',
};

// ─────────────────────────── Charts (note data) ───────────────────────────

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard', 'expert'] as const;

/** A single drum hit in a chart. Times are in seconds relative to chart zero (= audio time minus song offset). */
export interface ChartNote {
  /** Seconds from chart zero. */
  time: number;
  /** MIDI ticks from chart zero (kept so MIDI round-trips losslessly). */
  tick: number;
  voice: DrumVoice;
  /** 0..1 */
  velocity: number;
}

export interface TempoEvent {
  tick: number;
  /** Seconds from chart zero at which this tempo takes effect. */
  time: number;
  bpm: number;
}

export interface TimeSignatureEvent {
  tick: number;
  numerator: number;
  denominator: number;
}

export interface Chart {
  /** Pulses per quarter note used for `tick` values. */
  ppq: number;
  tempoMap: TempoEvent[]; // sorted by tick, at least one entry at tick 0
  timeSignatures: TimeSignatureEvent[]; // at least one entry at tick 0
  notes: ChartNote[]; // sorted by time
  /** Total length in seconds (>= last note time). */
  duration: number;
}

// ─────────────────────────── Song package (folder / zip) ───────────────────────────

/**
 * song.json — lives at the root of a song folder. A song folder is fully self-contained
 * and can be zipped and shared. All paths are relative to the folder root.
 */
export interface SongMeta {
  format: 1;
  /** Stable unique id (slug). Used for high scores + library keys. */
  id: string;
  title: string;
  artist: string;
  album?: string;
  year?: number;
  charter?: string;
  genre?: string;
  /** Nominal BPM (used as fallback tempo, tap-tempo seed, and for the recorder grid when the chart has no tempo map). */
  bpm: number;
  /** Seconds of audio that play before chart tick 0. audioTime = chartTime + offset. May be negative. */
  offset: number;
  /** Audio file relative path (mp3/wav/flac/aac/ogg/m4a). Drum-less mix. */
  audio: string;
  /** Per-difficulty chart MIDI files. Missing difficulties are derived from the hardest available one. */
  charts: Partial<Record<Difficulty, string>>;
  /** Optional custom drum samples (relative paths). Missing voices fall back to the built-in kit. */
  samples?: Partial<Record<DrumVoice, string>>;
  /** Linear gain applied to drum samples for this song (default 1). */
  sampleGain?: number;
  /** Optional cover art relative path. */
  artwork?: string;
  /** Preview window for the song-select screen (seconds into the audio). */
  preview?: { start: number; length: number };
  /** Optional theme accent for this song (CSS color). */
  accent?: string;
  /** Optional length in seconds (for display before audio decode). */
  length?: number;
}

/** An in-memory song folder: metadata + every file as a Blob keyed by relative path. */
export interface SongPackage {
  meta: SongMeta;
  files: Map<string, Blob>;
  /** Where the package came from. */
  source: 'bundled' | 'library' | 'zip' | 'folder';
  /** For bundled songs: the base URL of the folder. */
  baseUrl?: string;
}

/** Entry shown in the song-select list (no file payloads). */
export interface SongListEntry {
  meta: SongMeta;
  source: SongPackage['source'];
  baseUrl?: string;
  /** Object URL / data URL for artwork if available. */
  artworkUrl?: string;
}

// ─────────────────────────── Devices / input ───────────────────────────

/** A MIDI pad binding. channel -1 means "any channel". */
export interface PadBinding {
  note: number;
  channel: number;
}

export interface DeviceConfig {
  /** Stable key. For MIDI: the port name (ids change between sessions in some browsers). */
  deviceKey: string;
  deviceName: string;
  /** One or more pads per voice. */
  bindings: Record<DrumVoice, PadBinding[]>;
  /** Minimum velocity (0..127) treated as a hit. */
  velocityThreshold: number;
  createdAt: number;
  updatedAt: number;
}

/** A normalised hit coming from any input (MIDI or keyboard). */
export interface InputHit {
  voice: DrumVoice;
  /** 0..1 */
  velocity: number;
  /** performance.now()-based timestamp (ms) when the pad was struck. */
  timeStamp: number;
  /** Raw source (for the wizard / debugging). */
  raw?: { note: number; channel: number; velocity: number; device: string };
}

// ─────────────────────────── Performance & recording ───────────────────────────

/** A hit captured during a performance, in chart seconds. */
export interface PerformanceNote {
  time: number;
  voice: DrumVoice;
  velocity: number;
}

export type QuantizeGrid = 'off' | '1/4' | '1/8' | '1/16' | '1/32' | '1/8T' | '1/16T' | '1/12' | '1/24';

export interface QuantizeOptions {
  grid: QuantizeGrid;
  /** 0..1 — how far each note is pulled toward the grid (1 = snap fully). */
  strength: number;
  /** 0..1 swing amount applied to off-beat grid points (0 = straight). */
  swing: number;
  /** Merge notes on the same voice closer than this (seconds). 0 disables. */
  dedupeWindow: number;
}

// ─────────────────────────── Scoring ───────────────────────────

export type Judgement = 'perfect' | 'great' | 'good' | 'miss';

export interface HitWindows {
  perfect: number; // seconds (±)
  great: number;
  good: number;
}

export interface ScoreSummary {
  score: number;
  maxCombo: number;
  totalNotes: number;
  hits: Record<Judgement, number>;
  /** 0..1 */
  accuracy: number;
  /** 0..5 (may be fractional for display) */
  stars: number;
  fullCombo: boolean;
}

export interface HighScore extends ScoreSummary {
  songId: string;
  difficulty: Difficulty;
  player: string;
  date: number; // epoch ms
}

// ─────────────────────────── Settings ───────────────────────────

export interface Settings {
  playerName: string;
  /** Global audio/visual offset in seconds added to input timing (positive = inputs are treated as earlier). */
  inputOffset: number;
  /** Seconds of highway visible ahead of the strike line. */
  scrollWindow: number;
  songVolume: number; // 0..1
  drumVolume: number; // 0..1
  /** Play the built-in kit when a pad is hit (for the FGDP you may prefer its internal sounds). */
  drumSoundsOnHit: boolean;
  /** Keyboard fallback keys per voice (KeyboardEvent.code). */
  keyboard: Record<DrumVoice, string[]>;
  /** Last used MIDI input device key. */
  lastDeviceKey?: string;
  /** Visual theme id. */
  theme: string;
  reducedMotion: boolean;
}

export const DEFAULT_KEYBOARD: Record<DrumVoice, string[]> = {
  kick: ['Space', 'KeyB'],
  snare: ['KeyF', 'KeyJ'],
  tomHigh: ['KeyG'],
  tomMid: ['KeyH'],
  tomLow: ['KeyK'],
  hihatClosed: ['KeyD'],
  hihatOpen: ['KeyS'],
  ride: ['KeyL'],
  crash: ['KeyA', 'Semicolon'],
};

export const DEFAULT_SETTINGS: Settings = {
  playerName: 'PLAYER',
  inputOffset: 0,
  scrollWindow: 1.6,
  songVolume: 0.9,
  drumVolume: 0.9,
  drumSoundsOnHit: true,
  keyboard: DEFAULT_KEYBOARD,
  theme: 'inferno',
  reducedMotion: false,
};
