import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav } from '@/audio/wav';

function sine(n: number, freq: number, rate: number, amp = 0.8): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function maxError(a: Float32Array, b: Float32Array): number {
  let e = 0;
  for (let i = 0; i < a.length; i++) e = Math.max(e, Math.abs(a[i] - b[i]));
  return e;
}

describe('wav', () => {
  it('writes a valid 44-byte header with matching sizes', () => {
    const buf = encodeWav([new Float32Array(100), new Float32Array(100)], 44100, 16);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(44 + 100 * 2 * 2);
    expect(String.fromCharCode(...new Uint8Array(buf, 0, 4))).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(buf.byteLength - 8);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(400);
  });

  it('round-trips 16-bit stereo', () => {
    const rate = 22050;
    const l = sine(500, 440, rate);
    const r = sine(500, 220, rate, 0.5);
    const decoded = decodeWav(encodeWav([l, r], rate, 16));
    expect(decoded.sampleRate).toBe(rate);
    expect(decoded.channels.length).toBe(2);
    expect(decoded.channels[0].length).toBe(500);
    expect(maxError(decoded.channels[0], l)).toBeLessThan(1 / 32000);
    expect(maxError(decoded.channels[1], r)).toBeLessThan(1 / 32000);
  });

  it('round-trips 24-bit mono', () => {
    const rate = 48000;
    const m = sine(1000, 1000, rate, 0.99);
    const decoded = decodeWav(encodeWav([m], rate, 24));
    expect(decoded.channels.length).toBe(1);
    expect(maxError(decoded.channels[0], m)).toBeLessThan(1 / 8_000_000);
  });

  it('clamps out-of-range samples', () => {
    const src = new Float32Array([2, -2, 1, -1, 0]);
    const decoded = decodeWav(encodeWav([src], 8000, 16));
    expect(decoded.channels[0][0]).toBeCloseTo(1, 4);
    expect(decoded.channels[0][1]).toBeCloseTo(-1, 4);
    expect(decoded.channels[0][4]).toBe(0);
  });

  it('decodes 32-bit float and skips unknown chunks', () => {
    const rate = 8000;
    const m = sine(64, 100, rate);
    // Build: RIFF, fmt(float), LIST junk chunk (odd size → padded), data.
    const dataBytes = m.length * 4;
    const junk = 5;
    const total = 12 + 24 + (8 + junk + 1) + 8 + dataBytes;
    const buf = new ArrayBuffer(total);
    const v = new DataView(buf);
    const put = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    put(0, 'RIFF');
    v.setUint32(4, total - 8, true);
    put(8, 'WAVE');
    put(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 3, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 4, true);
    v.setUint16(32, 4, true);
    v.setUint16(34, 32, true);
    put(36, 'LIST');
    v.setUint32(40, junk, true);
    let o = 44 + junk + 1;
    put(o, 'data');
    v.setUint32(o + 4, dataBytes, true);
    o += 8;
    for (let i = 0; i < m.length; i++) v.setFloat32(o + i * 4, m[i], true);
    const decoded = decodeWav(buf);
    expect(decoded.sampleRate).toBe(rate);
    expect(maxError(decoded.channels[0], m)).toBe(0);
  });

  it('rejects non-wav input', () => {
    expect(() => decodeWav(new ArrayBuffer(64))).toThrow();
  });
});
