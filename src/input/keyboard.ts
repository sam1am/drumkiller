import type { DrumVoice } from '@/types';

export interface KeyHit {
  voice: DrumVoice;
  timeStamp: number;
  code: string;
}

/** Keyboard fallback so the game is playable (and testable) without a MIDI controller. */
export class KeyboardInput {
  private map = new Map<string, DrumVoice>();
  private listeners = new Set<(hit: KeyHit) => void>();
  private down = new Set<string>();
  private enabled = true;
  private handler = (ev: KeyboardEvent) => this.onKeyDown(ev);
  private upHandler = (ev: KeyboardEvent) => this.down.delete(ev.code);

  constructor(bindings: Record<DrumVoice, string[]>) {
    this.setBindings(bindings);
    window.addEventListener('keydown', this.handler);
    window.addEventListener('keyup', this.upHandler);
  }

  setBindings(bindings: Record<DrumVoice, string[]>): void {
    this.map.clear();
    (Object.keys(bindings) as DrumVoice[]).forEach((voice) => {
      for (const code of bindings[voice] ?? []) this.map.set(code, voice);
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  onHit(fn: (hit: KeyHit) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (!this.enabled) return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const voice = this.map.get(ev.code);
    if (!voice) return;
    ev.preventDefault();
    if (this.down.has(ev.code)) return; // ignore auto-repeat
    this.down.add(ev.code);
    const hit: KeyHit = { voice, timeStamp: ev.timeStamp || performance.now(), code: ev.code };
    this.listeners.forEach((fn) => fn(hit));
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handler);
    window.removeEventListener('keyup', this.upHandler);
  }
}
