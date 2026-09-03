/**
 * Web MIDI input: enumerates ports, listens to note-on events, and emits raw pad hits.
 * Mapping raw notes → DrumVoice happens in InputHub (via a DeviceConfig).
 */

export interface RawMidiHit {
  note: number;
  channel: number; // 0..15
  velocity: number; // 1..127
  timeStamp: number; // performance.now()-based ms (sanitised — see MidiInput.handleMessage)
  /** event.timeStamp - performance.now() at arrival (ms). Small negative = healthy; huge = broken clock domain. */
  skew: number;
  /** True when the hardware timestamp was rejected and the arrival time used instead. */
  timeStampFallback: boolean;
  portId: string;
  portName: string;
}

export interface MidiPortInfo {
  id: string;
  name: string;
  manufacturer: string;
  state: string;
}

type RawListener = (hit: RawMidiHit) => void;
type PortsListener = (ports: MidiPortInfo[]) => void;

export class MidiInput {
  private access: MIDIAccess | null = null;
  private listeners = new Set<RawListener>();
  private portListeners = new Set<PortsListener>();
  private activePortId: string | null = null;
  private bound = new Map<string, MIDIInput>();
  /** Last error message if Web MIDI is unavailable or denied. */
  error: string | null = null;
  /** Skew of the most recent event's hardware timestamp vs performance.now() (ms). */
  lastSkew = 0;
  /** How many events so far had an unusable hardware timestamp. */
  fallbackCount = 0;
  /** Force arrival-time stamping (for devices whose timestamps are unreliable). */
  ignoreHardwareTimestamps = false;
  /** Hardware timestamps further than this from performance.now() are considered broken (ms). */
  static readonly MAX_SKEW_MS = 400;

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  get ready(): boolean {
    return this.access !== null;
  }

  /** Request MIDI access (sysex not needed). Safe to call multiple times. */
  async init(): Promise<boolean> {
    if (this.access) return true;
    if (!this.supported) {
      this.error = 'Web MIDI is not supported in this browser. Use Chrome, Edge, Opera, or Firefox 108+.';
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => {
        this.rebind();
        this.emitPorts();
      };
      this.rebind();
      this.emitPorts();
      return true;
    } catch (err) {
      this.error = `MIDI access denied: ${(err as Error).message}`;
      return false;
    }
  }

  ports(): MidiPortInfo[] {
    if (!this.access) return [];
    const out: MidiPortInfo[] = [];
    this.access.inputs.forEach((p) =>
      out.push({ id: p.id, name: p.name ?? 'MIDI Input', manufacturer: p.manufacturer ?? '', state: p.state }),
    );
    return out;
  }

  /** Listen to one port (by id) or all ports (null). */
  setActivePort(portId: string | null): void {
    this.activePortId = portId;
    this.rebind();
  }

  get activePort(): MidiPortInfo | null {
    if (!this.activePortId) return null;
    return this.ports().find((p) => p.id === this.activePortId) ?? null;
  }

  onHit(fn: RawListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onPortsChanged(fn: PortsListener): () => void {
    this.portListeners.add(fn);
    return () => this.portListeners.delete(fn);
  }

  private emitPorts(): void {
    const ports = this.ports();
    this.portListeners.forEach((fn) => fn(ports));
  }

  private rebind(): void {
    if (!this.access) return;
    // Unbind everything first
    this.bound.forEach((port) => {
      port.onmidimessage = null;
    });
    this.bound.clear();
    this.access.inputs.forEach((port) => {
      if (this.activePortId && port.id !== this.activePortId) return;
      port.onmidimessage = (ev: MIDIMessageEvent) => this.handleMessage(port, ev);
      this.bound.set(port.id, port);
    });
  }

  private handleMessage(port: MIDIInput, ev: MIDIMessageEvent): void {
    const data = ev.data;
    if (!data || data.length < 3) return;
    const status = data[0] & 0xf0;
    const channel = data[0] & 0x0f;
    const note = data[1];
    const velocity = data[2];
    if (status !== 0x90 || velocity === 0) return; // note-on only
    // Web MIDI timestamps should share performance.now()'s clock, but some browser/driver combinations report
    // a different clock domain (or 0). A hit can only plausibly be a little *older* than now, so anything
    // outside a sane window is replaced by the arrival time.
    const now = performance.now();
    const raw = typeof ev.timeStamp === 'number' ? ev.timeStamp : 0;
    const skew = raw - now;
    this.lastSkew = skew;
    const usable = !this.ignoreHardwareTimestamps && raw > 0 && skew <= 5 && skew >= -MidiInput.MAX_SKEW_MS;
    if (!usable) this.fallbackCount++;
    const hit: RawMidiHit = {
      note,
      channel,
      velocity,
      timeStamp: usable ? raw : now,
      skew,
      timeStampFallback: !usable,
      portId: port.id,
      portName: port.name ?? 'MIDI Input',
    };
    this.listeners.forEach((fn) => fn(hit));
  }
}
