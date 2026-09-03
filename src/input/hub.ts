import type { DeviceConfig, DrumVoice, InputHit } from '@/types';
import { MidiInput, type RawMidiHit } from './midi';
import { KeyboardInput } from './keyboard';
import { voiceForMidi } from '@/store/devices';

/**
 * InputHub fuses MIDI + keyboard into a single stream of DrumVoice hits,
 * applying the active DeviceConfig for MIDI note → voice mapping.
 */
export class InputHub {
  readonly midi = new MidiInput();
  readonly keyboard: KeyboardInput;
  private device: DeviceConfig | null = null;
  private listeners = new Set<(hit: InputHit) => void>();
  private rawListeners = new Set<(hit: RawMidiHit) => void>();
  /** Raw hits that could not be mapped (used to nudge users to run the wizard). */
  unmappedCount = 0;
  lastUnmapped: RawMidiHit | null = null;

  constructor(keyboardBindings: Record<DrumVoice, string[]>) {
    this.keyboard = new KeyboardInput(keyboardBindings);
    this.keyboard.onHit((k) => this.emit({ voice: k.voice, velocity: 0.9, timeStamp: k.timeStamp }));
    this.midi.onHit((raw) => this.onRaw(raw));
  }

  setDevice(cfg: DeviceConfig | null): void {
    this.device = cfg;
  }

  get deviceConfig(): DeviceConfig | null {
    return this.device;
  }

  onHit(fn: (hit: InputHit) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Raw MIDI stream (the device wizard uses this). */
  onRaw(fn: (hit: RawMidiHit) => void): () => void;
  onRaw(raw: RawMidiHit): void;
  onRaw(arg: RawMidiHit | ((hit: RawMidiHit) => void)): (() => void) | void {
    if (typeof arg === 'function') {
      this.rawListeners.add(arg);
      return () => this.rawListeners.delete(arg);
    }
    const raw = arg;
    this.rawListeners.forEach((fn) => fn(raw));
    const cfg = this.device;
    if (!cfg) return;
    if (raw.velocity < cfg.velocityThreshold) return;
    const voice = voiceForMidi(cfg, raw.note, raw.channel);
    if (!voice) {
      this.unmappedCount++;
      this.lastUnmapped = raw;
      return;
    }
    this.emit({
      voice,
      velocity: raw.velocity / 127,
      timeStamp: raw.timeStamp,
      raw: { note: raw.note, channel: raw.channel, velocity: raw.velocity, device: raw.portName },
    });
  }

  private emit(hit: InputHit): void {
    this.listeners.forEach((fn) => fn(hit));
  }
}
