import { describe, expect, it } from 'vitest';
import { SETTINGS_KEY, SettingsStore, memoryKV } from '@/store';
import { DEFAULT_KEYBOARD, DEFAULT_SETTINGS } from '@/types';

describe('SettingsStore', () => {
  it('returns defaults when nothing is stored', () => {
    const store = new SettingsStore(memoryKV());
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(store.get().keyboard).not.toBe(DEFAULT_KEYBOARD); // a copy, not the shared object
  });

  it('merges partial/corrupt stored data over defaults, deep-merging keyboard', () => {
    const kv = memoryKV({
      [SETTINGS_KEY]: JSON.stringify({ playerName: 'ZED', songVolume: 7, keyboard: { kick: ['KeyX'], nonsense: ['KeyY'] }, theme: '' }),
    });
    const s = new SettingsStore(kv).get();
    expect(s.playerName).toBe('ZED');
    expect(s.songVolume).toBe(1); // clamped
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.keyboard.kick).toEqual(['KeyX']);
    expect(s.keyboard.snare).toEqual(DEFAULT_KEYBOARD.snare);
    expect('nonsense' in s.keyboard).toBe(false);
    expect(new SettingsStore(memoryKV({ [SETTINGS_KEY]: 'garbage' })).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('validates video recording settings', () => {
    const s = new SettingsStore(memoryKV({ [SETTINGS_KEY]: JSON.stringify({ recordVideo: true, recordResolution: 480, recordCameraId: 'cam-1' }) })).get();
    expect(s.recordVideo).toBe(true);
    expect(s.recordResolution).toBe(DEFAULT_SETTINGS.recordResolution);
    expect(s.recordCameraId).toBe('cam-1');
    const store = new SettingsStore(memoryKV());
    store.update({ recordCameraId: 'cam-2', recordResolution: 1080 });
    expect(store.get()).toMatchObject({ recordCameraId: 'cam-2', recordResolution: 1080 });
    store.update({ recordCameraId: undefined });
    expect('recordCameraId' in store.get()).toBe(false);
  });

  it('update persists, deep-merges keyboard, and notifies subscribers', () => {
    const kv = memoryKV();
    const store = new SettingsStore(kv);
    const seen: string[] = [];
    const unsub = store.subscribe((s) => seen.push(s.playerName));

    const next = store.update({ playerName: 'AMY', keyboard: { snare: ['KeyQ'] } as never, lastDeviceKey: 'FGDP-50' });
    expect(next.playerName).toBe('AMY');
    expect(next.keyboard.snare).toEqual(['KeyQ']);
    expect(next.keyboard.kick).toEqual(DEFAULT_KEYBOARD.kick);
    expect(next.lastDeviceKey).toBe('FGDP-50');
    expect(JSON.parse(kv.get(SETTINGS_KEY)!).playerName).toBe('AMY');
    expect(new SettingsStore(kv).get()).toEqual(next);

    store.update({ lastDeviceKey: undefined });
    expect(store.get().lastDeviceKey).toBeUndefined();

    expect(seen).toEqual(['AMY', 'AMY']);
    unsub();
    store.update({ playerName: 'BOB' });
    expect(seen).toEqual(['AMY', 'AMY']);
  });

  it('reset restores defaults and notifies', () => {
    const store = new SettingsStore(memoryKV());
    store.update({ playerName: 'X', inputOffset: 0.02 });
    let notified = 0;
    store.subscribe(() => notified++);
    expect(store.reset()).toEqual(DEFAULT_SETTINGS);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(notified).toBe(1);
  });
});
