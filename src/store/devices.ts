/** Per-device MIDI pad mappings persisted through a KV. */
import type { DeviceConfig, DrumVoice, PadBinding } from '@/types';
import { DRUM_VOICES } from '@/types';
import { readJson, writeJson, type KV } from './kv';

export const DEVICES_KEY = 'dk.devices.v1';
/** Pseudo-device key used for the computer-keyboard fallback. */
export const KEYBOARD_DEVICE_KEY = 'keyboard';
/** MIDI channel value meaning "any channel". */
export const ANY_CHANNEL = -1;
export const DEFAULT_VELOCITY_THRESHOLD = 1;

type DeviceData = Record<string, DeviceConfig>;

export function emptyBindings(): Record<DrumVoice, PadBinding[]> {
  const out = {} as Record<DrumVoice, PadBinding[]>;
  for (const v of DRUM_VOICES) out[v] = [];
  return out;
}

function isBinding(v: unknown): v is PadBinding {
  return (
    !!v &&
    typeof v === 'object' &&
    Number.isInteger((v as PadBinding).note) &&
    Number.isInteger((v as PadBinding).channel)
  );
}

/** Coerce arbitrary stored data into a well-formed bindings map (unknown voices dropped, missing ones empty). */
export function sanitizeBindings(raw: unknown): Record<DrumVoice, PadBinding[]> {
  const out = emptyBindings();
  if (!raw || typeof raw !== 'object') return out;
  for (const v of DRUM_VOICES) {
    const list = (raw as Record<string, unknown>)[v];
    if (Array.isArray(list)) {
      out[v] = list.filter(isBinding).map((b) => ({ note: b.note, channel: b.channel }));
    }
  }
  return out;
}

function sanitizeConfig(key: string, raw: unknown): DeviceConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<DeviceConfig>;
  const now = Date.now();
  return {
    deviceKey: typeof r.deviceKey === 'string' && r.deviceKey ? r.deviceKey : key,
    deviceName: typeof r.deviceName === 'string' ? r.deviceName : key,
    bindings: sanitizeBindings(r.bindings),
    velocityThreshold:
      typeof r.velocityThreshold === 'number' && Number.isFinite(r.velocityThreshold)
        ? r.velocityThreshold
        : DEFAULT_VELOCITY_THRESHOLD,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
  };
}

/**
 * Which voice a MIDI note-on maps to on this device. A binding with channel -1 matches any
 * channel. When several voices claim the same note, the first in DRUM_VOICES order wins.
 */
export function voiceForMidi(cfg: DeviceConfig, note: number, channel: number): DrumVoice | null {
  for (const v of DRUM_VOICES) {
    const list = cfg.bindings[v];
    if (!list) continue;
    for (const b of list) {
      if (b.note === note && (b.channel === ANY_CHANNEL || b.channel === channel)) return v;
    }
  }
  return null;
}

export class DeviceStore {
  constructor(private readonly kv: KV) {}

  private read(): DeviceData {
    const data = readJson<unknown>(this.kv, DEVICES_KEY, {});
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out: DeviceData = {};
    for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
      const cfg = sanitizeConfig(key, raw);
      if (cfg) out[key] = cfg;
    }
    return out;
  }

  private write(data: DeviceData): void {
    writeJson(this.kv, DEVICES_KEY, data);
  }

  get(deviceKey: string): DeviceConfig | undefined {
    return this.read()[deviceKey];
  }

  list(): DeviceConfig[] {
    return Object.values(this.read()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Persist a config (bumping updatedAt). Returns the stored copy. */
  save(cfg: DeviceConfig): DeviceConfig {
    const data = this.read();
    const now = Date.now();
    const stored: DeviceConfig = {
      ...cfg,
      bindings: sanitizeBindings(cfg.bindings),
      createdAt: data[cfg.deviceKey]?.createdAt ?? cfg.createdAt ?? now,
      updatedAt: Math.max(now, (data[cfg.deviceKey]?.updatedAt ?? 0) + 1),
    };
    data[cfg.deviceKey] = stored;
    this.write(data);
    return stored;
  }

  remove(deviceKey: string): void {
    const data = this.read();
    if (!(deviceKey in data)) return;
    delete data[deviceKey];
    this.write(data);
  }

  /** Create (and save) a config from a preset's bindings. */
  createFromPreset(
    deviceKey: string,
    deviceName: string,
    bindings: Record<DrumVoice, PadBinding[]>,
    velocityThreshold = DEFAULT_VELOCITY_THRESHOLD,
  ): DeviceConfig {
    const now = Date.now();
    return this.save({
      deviceKey,
      deviceName,
      bindings: sanitizeBindings(bindings),
      velocityThreshold,
      createdAt: now,
      updatedAt: now,
    });
  }
}
