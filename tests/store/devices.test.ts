import { describe, expect, it } from 'vitest';
import { DEVICES_KEY, DeviceStore, KEYBOARD_DEVICE_KEY, emptyBindings, memoryKV, voiceForMidi } from '@/store';
import { DRUM_VOICES } from '@/types';

describe('DeviceStore', () => {
  it('exposes the keyboard key and empty bindings', () => {
    expect(KEYBOARD_DEVICE_KEY).toBe('keyboard');
    const b = emptyBindings();
    expect(Object.keys(b)).toEqual([...DRUM_VOICES]);
    expect(Object.values(b).every((l) => l.length === 0)).toBe(true);
  });

  it('creates, lists, updates and removes configs', () => {
    const store = new DeviceStore(memoryKV());
    const bindings = emptyBindings();
    bindings.kick = [{ note: 36, channel: -1 }];
    const cfg = store.createFromPreset('FGDP-50', 'Yamaha FGDP-50', bindings);
    expect(cfg.deviceKey).toBe('FGDP-50');
    expect(cfg.velocityThreshold).toBeGreaterThan(0);
    expect(store.get('FGDP-50')?.bindings.kick).toEqual([{ note: 36, channel: -1 }]);
    expect(store.list().map((c) => c.deviceKey)).toEqual(['FGDP-50']);

    const before = store.get('FGDP-50')!;
    const updated = store.save({ ...before, deviceName: 'My pads', bindings: { ...before.bindings, snare: [{ note: 38, channel: 10 }] } });
    expect(updated.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(updated.createdAt).toBe(before.createdAt);
    expect(store.get('FGDP-50')?.deviceName).toBe('My pads');
    expect(store.get('FGDP-50')?.bindings.snare).toEqual([{ note: 38, channel: 10 }]);

    store.remove('FGDP-50');
    expect(store.get('FGDP-50')).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('voiceForMidi matches wildcard channels and resolves conflicts by DRUM_VOICES order', () => {
    const store = new DeviceStore(memoryKV());
    const bindings = emptyBindings();
    bindings.kick = [{ note: 36, channel: 10 }, { note: 35, channel: -1 }];
    bindings.snare = [{ note: 38, channel: -1 }];
    bindings.crash = [{ note: 38, channel: 1 }, { note: 49, channel: -1 }]; // conflicts with snare on note 38
    bindings.hihatClosed = [{ note: 42, channel: 2 }];
    const cfg = store.createFromPreset('pads', 'Pads', bindings);

    expect(voiceForMidi(cfg, 36, 10)).toBe('kick');
    expect(voiceForMidi(cfg, 36, 1)).toBeNull(); // explicit channel mismatch
    expect(voiceForMidi(cfg, 35, 7)).toBe('kick'); // wildcard
    expect(voiceForMidi(cfg, 38, 1)).toBe('snare'); // snare precedes crash in DRUM_VOICES
    expect(voiceForMidi(cfg, 49, 3)).toBe('crash');
    expect(voiceForMidi(cfg, 42, 2)).toBe('hihatClosed');
    expect(voiceForMidi(cfg, 42, 3)).toBeNull();
    expect(voiceForMidi(cfg, 99, 0)).toBeNull();
  });

  it('sanitizes corrupt storage', () => {
    const kv = memoryKV({ [DEVICES_KEY]: JSON.stringify({ x: { deviceName: 'X', bindings: { kick: [{ note: 36, channel: -1 }, 'bad'], bogus: [] } } }) });
    const cfg = new DeviceStore(kv).get('x')!;
    expect(cfg.deviceKey).toBe('x');
    expect(cfg.bindings.kick).toEqual([{ note: 36, channel: -1 }]);
    expect(cfg.bindings.snare).toEqual([]);
    expect('bogus' in cfg.bindings).toBe(false);
    expect(new DeviceStore(memoryKV({ [DEVICES_KEY]: '[[' })).list()).toEqual([]);
  });
});
