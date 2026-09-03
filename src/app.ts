import { AudioEngine, DrumKit } from '@/audio';
import { InputHub } from '@/input';
import { SongLibrary, IndexedDbBackend } from '@/song';
import { ScoreStore, DeviceStore, SettingsStore, localStorageKV } from '@/store';
import type { DeviceConfig, Settings } from '@/types';
import { findPreset } from '@/midi';
import { toast } from '@/ui/dom';

export interface Screen {
  el: HTMLElement;
  dispose?(): void;
}

export type ScreenFactory = (app: App, params?: Record<string, unknown>) => Screen | Promise<Screen>;

/** Application service container + screen router. */
export class App {
  readonly engine = new AudioEngine();
  readonly kit: DrumKit;
  readonly input: InputHub;
  readonly library = new SongLibrary(new IndexedDbBackend());
  readonly scores: ScoreStore;
  readonly devices: DeviceStore;
  readonly settingsStore: SettingsStore;
  private screens = new Map<string, ScreenFactory>();
  private current: Screen | null = null;
  private audioReady = false;
  private kitReady = false;
  /** True when a song loaded custom samples into the kit (restore defaults before the next song). */
  kitCustomized = false;

  constructor(readonly root: HTMLElement) {
    const kv = localStorageKV();
    this.scores = new ScoreStore(kv);
    this.devices = new DeviceStore(kv);
    this.settingsStore = new SettingsStore(kv);
    this.kit = new DrumKit(this.engine);
    this.input = new InputHub(this.settings.keyboard);
    this.settingsStore.subscribe((s) => this.applySettings(s));
    this.applySettings(this.settings);
  }

  get settings(): Settings {
    return this.settingsStore.get();
  }

  /** True once boot() has initialised audio (i.e. a user gesture has happened). */
  get booted(): boolean {
    return this.audioReady;
  }

  private applySettings(s: Settings): void {
    this.input.keyboard.setBindings(s.keyboard);
    document.body.classList.toggle('reduced-motion', s.reducedMotion);
    if (this.audioReady) {
      this.engine.setSongVolume(s.songVolume);
      this.engine.setDrumVolume(s.drumVolume);
    }
  }

  /** Must be called from a user gesture. Boots audio, the default kit, and MIDI. Idempotent. */
  async boot(): Promise<void> {
    if (!this.audioReady) {
      await this.engine.init();
      this.audioReady = true;
      this.engine.setSongVolume(this.settings.songVolume);
      this.engine.setDrumVolume(this.settings.drumVolume);
    }
    if (!this.kitReady) {
      this.kitReady = true;
      this.kit.loadDefault().catch((e) => {
        this.kitReady = false;
        console.error(e);
      });
    }
    if (!this.input.midi.ready) {
      const ok = await this.input.midi.init();
      if (ok) {
        this.input.midi.onPortsChanged(() => this.autoSelectDevice());
        this.autoSelectDevice();
      }
    }
  }

  /** Pick the last-used device if present, else the first port; load/create its config. */
  autoSelectDevice(): DeviceConfig | null {
    const ports = this.input.midi.ports();
    if (!ports.length) {
      this.input.setDevice(null);
      return null;
    }
    const last = this.settings.lastDeviceKey;
    const port = ports.find((p) => p.name === last) ?? ports[0];
    return this.selectDevice(port.name);
  }

  selectDevice(portName: string): DeviceConfig | null {
    const port = this.input.midi.ports().find((p) => p.name === portName);
    if (!port) return null;
    this.input.midi.setActivePort(port.id);
    let cfg = this.devices.get(portName);
    if (!cfg) {
      const preset = findPreset(portName);
      cfg = this.devices.createFromPreset(portName, portName, preset.bindings);
      this.devices.save(cfg);
      toast(`${portName}: using ${preset.name} preset. Run Pad Setup to customise.`);
    }
    this.input.setDevice(cfg);
    if (this.settings.lastDeviceKey !== portName) this.settingsStore.update({ lastDeviceKey: portName });
    return cfg;
  }

  register(name: string, factory: ScreenFactory): void {
    this.screens.set(name, factory);
  }

  async navigate(name: string, params?: Record<string, unknown>): Promise<void> {
    const factory = this.screens.get(name);
    if (!factory) throw new Error(`Unknown screen ${name}`);
    this.current?.dispose?.();
    this.current = null;
    // clear all but the backdrop
    Array.from(this.root.children).forEach((c) => {
      if (!c.classList.contains('backdrop')) c.remove();
    });
    const screen = await factory(this, params);
    this.current = screen;
    this.root.appendChild(screen.el);
    location.hash = name;
  }
}
