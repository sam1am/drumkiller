/**
 * Web MIDI input: enumerates ports, listens to note-on events, and emits raw pad hits.
 * Mapping raw notes → DrumVoice happens in InputHub (via a DeviceConfig).
 */

export interface RawMidiHit {
  note: number;
  channel: number; // 0..15
  velocity: number; // 1..127
  timeStamp: number; // performance.now()-based ms
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
    const hit: RawMidiHit = {
      note,
      channel,
      velocity,
      timeStamp: ev.timeStamp || performance.now(),
      portId: port.id,
      portName: port.name ?? 'MIDI Input',
    };
    this.listeners.forEach((fn) => fn(hit));
  }
}
