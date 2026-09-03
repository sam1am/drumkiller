/**
 * Minimal WAV (RIFF) encoder / decoder. Pure functions — no Web Audio required.
 */

export type WavBitDepth = 16 | 24;

/** Encode float channels (-1..1) to a PCM WAV file. */
export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: WavBitDepth = 16): ArrayBuffer {
  const numChannels = channels.length;
  if (numChannels === 0) throw new Error('encodeWav: no channels');
  const frames = channels[0].length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  if (bitDepth === 16) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        const s = clampSample(channels[c][i]);
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
  } else {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        const s = clampSample(channels[c][i]);
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        view.setUint8(offset, v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
        offset += 3;
      }
    }
  }
  return buffer;
}

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
}

/** Decode a PCM WAV (16/24-bit integer or 32-bit float). Handles extra chunks and WAVE_FORMAT_EXTENSIBLE. */
export function decodeWav(data: ArrayBuffer): DecodedWav {
  const view = new DataView(data);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('decodeWav: not a RIFF/WAVE file');
  }
  let pos = 12;
  let format = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (pos + 8 <= view.byteLength) {
    const id = readAscii(view, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitDepth = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) {
        // WAVE_FORMAT_EXTENSIBLE: sub-format GUID's first two bytes hold the real format tag.
        format = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = Math.min(size, view.byteLength - body);
      break;
    }
    pos = body + size + (size & 1);
  }
  if (dataOffset < 0) throw new Error('decodeWav: no data chunk');
  if (numChannels === 0 || sampleRate === 0) throw new Error('decodeWav: missing fmt chunk');

  const bytesPerSample = bitDepth / 8;
  const frames = Math.floor(dataSize / (bytesPerSample * numChannels));
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(frames));

  let off = dataOffset;
  if (format === 3 && bitDepth === 32) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < numChannels; c++) {
        channels[c][i] = view.getFloat32(off, true);
        off += 4;
      }
  } else if (format === 1 && bitDepth === 16) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < numChannels; c++) {
        const s = view.getInt16(off, true);
        channels[c][i] = s < 0 ? s / 0x8000 : s / 0x7fff;
        off += 2;
      }
  } else if (format === 1 && bitDepth === 24) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < numChannels; c++) {
        let v = view.getUint8(off) | (view.getUint8(off + 1) << 8) | (view.getUint8(off + 2) << 16);
        if (v & 0x800000) v |= ~0xffffff; // sign-extend
        channels[c][i] = v < 0 ? v / 0x800000 : v / 0x7fffff;
        off += 3;
      }
  } else if (format === 1 && bitDepth === 32) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < numChannels; c++) {
        channels[c][i] = view.getInt32(off, true) / 0x80000000;
        off += 4;
      }
  } else if (format === 1 && bitDepth === 8) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < numChannels; c++) {
        channels[c][i] = (view.getUint8(off) - 128) / 128;
        off += 1;
      }
  } else {
    throw new Error(`decodeWav: unsupported format ${format} / ${bitDepth}-bit`);
  }
  return { sampleRate, channels };
}

/** Convert an AudioBuffer to a 16-bit WAV Blob. */
export function audioBufferToWav(buffer: AudioBuffer, bitDepth: WavBitDepth = 16): Blob {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return new Blob([encodeWav(channels, buffer.sampleRate, bitDepth)], { type: 'audio/wav' });
}

function clampSample(s: number): number {
  return s < -1 ? -1 : s > 1 ? 1 : s;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}
