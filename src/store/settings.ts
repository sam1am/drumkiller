/** User settings persisted through a KV, always merged over DEFAULT_SETTINGS. */
import type { DrumVoice, Settings } from '@/types';
import { DEFAULT_KEYBOARD, DEFAULT_SETTINGS, DRUM_VOICES, LANE_ORDER, RECORD_RESOLUTIONS, type Lane, type RecordResolution } from '@/types';
import { readJson, writeJson, type KV } from './kv';

export const SETTINGS_KEY = 'dk.settings.v1';

type Listener = (s: Settings) => void;

function mergeKeyboard(raw: unknown): Record<DrumVoice, string[]> {
  const out = {} as Record<DrumVoice, string[]>;
  for (const v of DRUM_VOICES) out[v] = [...DEFAULT_KEYBOARD[v]];
  if (raw && typeof raw === 'object') {
    for (const v of DRUM_VOICES) {
      const list = (raw as Record<string, unknown>)[v];
      if (Array.isArray(list)) out[v] = list.filter((k): k is string => typeof k === 'string');
    }
  }
  return out;
}

function clamp01(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** Merge an arbitrary (possibly partial or corrupt) object over the defaults. */
/** A lane order is valid only if it is a permutation of the five vertical lanes. */
export function mergeLaneOrder(raw: unknown): Lane[] {
  if (Array.isArray(raw) && raw.length === LANE_ORDER.length) {
    const set = new Set(raw as unknown[]);
    if (set.size === LANE_ORDER.length && LANE_ORDER.every((l) => set.has(l))) return [...(raw as Lane[])];
  }
  return [...LANE_ORDER];
}

export function mergeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS;
  const settings: Settings = {
    playerName: typeof r.playerName === 'string' && r.playerName.trim() ? r.playerName : d.playerName,
    inputOffset: typeof r.inputOffset === 'number' && Number.isFinite(r.inputOffset) ? r.inputOffset : d.inputOffset,
    scrollWindow:
      typeof r.scrollWindow === 'number' && Number.isFinite(r.scrollWindow) && r.scrollWindow > 0
        ? r.scrollWindow
        : d.scrollWindow,
    songVolume: clamp01(r.songVolume, d.songVolume),
    drumVolume: clamp01(r.drumVolume, d.drumVolume),
    drumSoundsOnHit: typeof r.drumSoundsOnHit === 'boolean' ? r.drumSoundsOnHit : d.drumSoundsOnHit,
    keyboard: mergeKeyboard(r.keyboard),
    theme: typeof r.theme === 'string' && r.theme ? r.theme : d.theme,
    reducedMotion: typeof r.reducedMotion === 'boolean' ? r.reducedMotion : d.reducedMotion,
    hitWindowScale:
      typeof r.hitWindowScale === 'number' && Number.isFinite(r.hitWindowScale) && r.hitWindowScale >= 0.25 && r.hitWindowScale <= 5
        ? r.hitWindowScale
        : d.hitWindowScale,
    strictVoices: typeof r.strictVoices === 'boolean' ? r.strictVoices : d.strictVoices,
    laneOrder: mergeLaneOrder(r.laneOrder),
    recordVideo: typeof r.recordVideo === 'boolean' ? r.recordVideo : d.recordVideo,
    recordMic: typeof r.recordMic === 'boolean' ? r.recordMic : d.recordMic,
    recordRotate: typeof r.recordRotate === 'boolean' ? r.recordRotate : d.recordRotate,
    recordResolution: RECORD_RESOLUTIONS.includes(r.recordResolution as RecordResolution) ? (r.recordResolution as RecordResolution) : d.recordResolution,
  };
  if (typeof r.lastDeviceKey === 'string' && r.lastDeviceKey) settings.lastDeviceKey = r.lastDeviceKey;
  if (typeof r.recordCameraId === 'string' && r.recordCameraId) settings.recordCameraId = r.recordCameraId;
  return settings;
}

export class SettingsStore {
  private listeners = new Set<Listener>();

  constructor(private readonly kv: KV) {}

  get(): Settings {
    return mergeSettings(readJson<unknown>(this.kv, SETTINGS_KEY, {}));
  }

  /** Shallow patch; `keyboard` in the patch is merged per-voice over the current map. */
  update(patch: Partial<Settings>): Settings {
    const current = this.get();
    const next: Settings = mergeSettings({
      ...current,
      ...patch,
      keyboard: patch.keyboard ? { ...current.keyboard, ...patch.keyboard } : current.keyboard,
    });
    // Allow explicitly clearing lastDeviceKey.
    if ('lastDeviceKey' in patch && patch.lastDeviceKey === undefined) delete next.lastDeviceKey;
    if ('recordCameraId' in patch && patch.recordCameraId === undefined) delete next.recordCameraId;
    writeJson(this.kv, SETTINGS_KEY, next);
    this.emit(next);
    return next;
  }

  reset(): Settings {
    this.kv.remove(SETTINGS_KEY);
    const s = this.get();
    this.emit(s);
    return s;
  }

  /** Called after every update/reset. Returns an unsubscribe function. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(s: Settings): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(s);
      } catch (e) {
        console.error('SettingsStore listener threw', e);
      }
    }
  }
}
