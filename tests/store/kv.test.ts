import { describe, expect, it } from 'vitest';
import { localStorageKV, memoryKV, readJson, writeJson } from '@/store';

describe('kv', () => {
  it('memoryKV stores strings', () => {
    const kv = memoryKV({ a: '1' });
    expect(kv.get('a')).toBe('1');
    expect(kv.get('b')).toBeNull();
    kv.set('b', 'x');
    expect(kv.get('b')).toBe('x');
    kv.remove('a');
    expect(kv.get('a')).toBeNull();
  });

  it('localStorageKV degrades to memory when localStorage is unavailable', () => {
    const kv = localStorageKV();
    kv.set('k', 'v');
    expect(kv.get('k')).toBe('v');
    kv.remove('k');
    expect(kv.get('k')).toBeNull();
  });

  it('readJson falls back on corrupt data', () => {
    const kv = memoryKV({ bad: '{nope' });
    expect(readJson(kv, 'bad', { ok: true })).toEqual({ ok: true });
    writeJson(kv, 'good', { n: 1 });
    expect(readJson(kv, 'good', null)).toEqual({ n: 1 });
  });
});
