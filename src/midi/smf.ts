/**
 * Standard MIDI File (SMF) parser and writer.
 *
 * Zero-dependency, tolerant of real-world quirks:
 *  - running status (data bytes without a repeated status byte)
 *  - noteOn with velocity 0 is normalised to a `noteOff`
 *  - sysex events are skipped, unknown meta / channel messages are kept as
 *    `unknown` events so nothing ever crashes the parser
 *  - trailing garbage after the last chunk and truncated tracks are tolerated
 *    (parsing of that track simply stops)
 *
 * Every parsed event carries an ABSOLUTE `tick` (delta-times are resolved while
 * parsing) which makes downstream processing (tempo maps, quantising) trivial.
 *
 * SMPTE time divisions are not supported and raise a clear `Error`.
 */

// ─────────────────────────── Types ───────────────────────────

/** Note-on: a key/pad was struck. `velocity` is always > 0 (velocity 0 becomes `noteOff`). */
export interface MidiNoteOnEvent {
  type: 'noteOn';
  /** Absolute tick from the start of the file. */
  tick: number;
  /** 0..15 */
  channel: number;
  /** 0..127 */
  note: number;
  /** 1..127 */
  velocity: number;
}

/** Note-off (either an explicit 0x8n message or a 0x9n message with velocity 0). */
export interface MidiNoteOffEvent {
  type: 'noteOff';
  tick: number;
  channel: number;
  note: number;
  /** Release velocity 0..127 (0 when the note-off came from a velocity-0 note-on). */
  velocity: number;
}

/** Set-tempo meta event (FF 51). */
export interface MidiTempoEvent {
  type: 'tempo';
  tick: number;
  /** Beats per minute (derived from `microsecondsPerQuarter`). */
  bpm: number;
  /** Raw tempo value: microseconds per quarter note. */
  microsecondsPerQuarter: number;
}

/** Time-signature meta event (FF 58). */
export interface MidiTimeSignatureEvent {
  type: 'timeSignature';
  tick: number;
  numerator: number;
  /** Actual denominator (4 = quarter note), i.e. 2^dd already resolved. */
  denominator: number;
}

/** Track-name meta event (FF 03). */
export interface MidiTrackNameEvent {
  type: 'trackName';
  tick: number;
  text: string;
}

/** Any other textual meta event (FF 01 text, 02 copyright, 04 instrument, 05 lyric, 06 marker, 07 cue). */
export interface MidiTextEvent {
  type: 'text';
  tick: number;
  text: string;
}

/** End-of-track meta event (FF 2F). */
export interface MidiEndOfTrackEvent {
  type: 'endOfTrack';
  tick: number;
}

/** Control change (0xBn). */
export interface MidiControlChangeEvent {
  type: 'controlChange';
  tick: number;
  channel: number;
  controller: number;
  value: number;
}

/** Program change (0xCn). */
export interface MidiProgramChangeEvent {
  type: 'programChange';
  tick: number;
  channel: number;
  program: number;
}

/**
 * Catch-all for messages the parser does not model (pitch bend, aftertouch,
 * unknown meta events, ...). `data` holds the complete raw message bytes
 * (status byte included, delta-time excluded) so the writer can emit it verbatim.
 */
export interface MidiUnknownEvent {
  type: 'unknown';
  tick: number;
  data: Uint8Array;
}

/** Union of every event the parser produces. All carry an absolute `tick`. */
export type MidiEvent =
  | MidiNoteOnEvent
  | MidiNoteOffEvent
  | MidiTempoEvent
  | MidiTimeSignatureEvent
  | MidiTrackNameEvent
  | MidiTextEvent
  | MidiEndOfTrackEvent
  | MidiControlChangeEvent
  | MidiProgramChangeEvent
  | MidiUnknownEvent;

/** One MTrk chunk. */
export interface MidiTrack {
  /** Text of the first `trackName` event, if any. */
  name?: string;
  /** Events in file order with absolute ticks. */
  events: MidiEvent[];
}

/** A parsed (or to-be-written) Standard MIDI File. */
export interface MidiFile {
  /** SMF format: 0 = single track, 1 = simultaneous tracks, 2 = independent sequences. */
  format: 0 | 1 | 2;
  /** Pulses (ticks) per quarter note. */
  ppq: number;
  tracks: MidiTrack[];
}

// ─────────────────────────── Variable-length quantities ───────────────────────────

/** Largest value a 4-byte SMF variable-length quantity can hold. */
export const MAX_VARLEN = 0x0fffffff;

/**
 * Read a MIDI variable-length quantity (7 bits per byte, MSB = continuation).
 *
 * @param data   Byte source.
 * @param offset Index of the first byte of the quantity.
 * @returns The decoded `value` and the number of bytes consumed (`length`).
 * @throws RangeError if the quantity runs past the end of `data` or is absurdly long.
 */
export function readVarLen(data: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0;
  let pos = offset;
  for (;;) {
    if (pos >= data.length) {
      throw new RangeError(`Variable-length quantity at offset ${offset} runs past end of data`);
    }
    const byte = data[pos++];
    // Multiply instead of shifting so we never overflow 32-bit signed ints.
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
    if (pos - offset >= 8) {
      throw new RangeError(`Variable-length quantity at offset ${offset} is too long`);
    }
  }
  return { value, length: pos - offset };
}

/**
 * Encode a non-negative integer as a MIDI variable-length quantity.
 *
 * @param value Integer in 0..0x0FFFFFFF.
 * @returns The encoded bytes (1–4 entries).
 * @throws RangeError for negative, non-integer or out-of-range values.
 */
export function writeVarLen(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > MAX_VARLEN) {
    throw new RangeError(`Cannot encode ${value} as a variable-length quantity`);
  }
  const bytes: number[] = [value & 0x7f];
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return bytes;
}

// ─────────────────────────── Parsing ───────────────────────────

const FOURCC_MTHD = 0x4d546864; // 'MThd'
const FOURCC_MTRK = 0x4d54726b; // 'MTrk'

/** Read a big-endian unsigned 32-bit integer. Throws RangeError on short reads. */
function readU32(data: Uint8Array, pos: number): number {
  if (pos + 4 > data.length) throw new RangeError(`Unexpected end of data at ${pos}`);
  return ((data[pos] << 24) >>> 0) + (data[pos + 1] << 16) + (data[pos + 2] << 8) + data[pos + 3];
}

/** Read a big-endian unsigned 16-bit integer. Throws RangeError on short reads. */
function readU16(data: Uint8Array, pos: number): number {
  if (pos + 2 > data.length) throw new RangeError(`Unexpected end of data at ${pos}`);
  return (data[pos] << 8) + data[pos + 1];
}

/**
 * Decode text bytes: strict UTF-8 first, Latin-1 as fallback (many old
 * sequencers wrote track names in a single-byte code page).
 */
function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
}

/** Encode text as UTF-8 bytes. */
function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Build the raw bytes of a meta event (FF type len payload). */
function rawMeta(metaType: number, payload: Uint8Array): Uint8Array {
  const len = writeVarLen(payload.length);
  const out = new Uint8Array(2 + len.length + payload.length);
  out[0] = 0xff;
  out[1] = metaType & 0x7f;
  out.set(len, 2);
  out.set(payload, 2 + len.length);
  return out;
}

/** Convert a meta event's payload into a typed event. */
function metaToEvent(metaType: number, payload: Uint8Array, tick: number): MidiEvent {
  switch (metaType) {
    case 0x01:
    case 0x02:
    case 0x04:
    case 0x05:
    case 0x06:
    case 0x07:
      return { type: 'text', tick, text: decodeText(payload) };
    case 0x03:
      return { type: 'trackName', tick, text: decodeText(payload) };
    case 0x2f:
      return { type: 'endOfTrack', tick };
    case 0x51: {
      if (payload.length < 3) return { type: 'unknown', tick, data: rawMeta(metaType, payload) };
      const mpq = (payload[0] << 16) + (payload[1] << 8) + payload[2];
      if (mpq <= 0) return { type: 'unknown', tick, data: rawMeta(metaType, payload) };
      return { type: 'tempo', tick, bpm: 60_000_000 / mpq, microsecondsPerQuarter: mpq };
    }
    case 0x58: {
      if (payload.length < 2) return { type: 'unknown', tick, data: rawMeta(metaType, payload) };
      return { type: 'timeSignature', tick, numerator: payload[0], denominator: 2 ** payload[1] };
    }
    default:
      return { type: 'unknown', tick, data: rawMeta(metaType, payload) };
  }
}

/**
 * Parse one MTrk chunk body. Never throws on truncation: when the data runs out
 * mid-event, parsing of the track simply stops and the events read so far are returned.
 */
function parseTrack(data: Uint8Array, start: number, end: number): MidiTrack {
  const events: MidiEvent[] = [];
  let name: string | undefined;
  let tick = 0;
  let pos = start;
  let running: number | null = null;

  try {
    while (pos < end) {
      const delta = readVarLen(data, pos);
      pos += delta.length;
      tick += delta.value;
      if (pos >= end) break;

      let status = data[pos];
      if (status < 0x80) {
        // Running status: reuse the previous channel status byte.
        if (running === null) break; // malformed — nothing sensible we can do
        status = running;
      } else {
        pos++;
      }

      if (status === 0xff) {
        // Meta event
        if (pos >= end) break;
        const metaType = data[pos++];
        const len = readVarLen(data, pos);
        pos += len.length;
        const payloadEnd = pos + len.value;
        const payload = data.subarray(pos, Math.min(payloadEnd, end));
        pos = payloadEnd;
        const ev = metaToEvent(metaType, payload, tick);
        events.push(ev);
        if (ev.type === 'trackName' && name === undefined) name = ev.text;
        if (ev.type === 'endOfTrack') break;
      } else if (status === 0xf0 || status === 0xf7) {
        // Sysex / escape: skip the payload.
        const len = readVarLen(data, pos);
        pos += len.length + len.value;
      } else if (status >= 0xf1) {
        // System common / real-time messages are not expected inside an SMF but
        // some tools write them. Keep the bytes, do not crash.
        const dataBytes = status === 0xf2 ? 2 : status === 0xf1 || status === 0xf3 ? 1 : 0;
        if (pos + dataBytes > end) break;
        events.push({ type: 'unknown', tick, data: Uint8Array.from(data.subarray(pos - 1, pos + dataBytes)) });
        pos += dataBytes;
      } else {
        // Channel voice message
        running = status;
        const kind = status >> 4;
        const channel = status & 0x0f;
        const needs = kind === 0xc || kind === 0xd ? 1 : 2;
        if (pos + needs > end) break;
        const d1 = data[pos] & 0x7f;
        const d2 = needs === 2 ? data[pos + 1] & 0x7f : 0;
        pos += needs;
        switch (kind) {
          case 0x8:
            events.push({ type: 'noteOff', tick, channel, note: d1, velocity: d2 });
            break;
          case 0x9:
            if (d2 === 0) events.push({ type: 'noteOff', tick, channel, note: d1, velocity: 0 });
            else events.push({ type: 'noteOn', tick, channel, note: d1, velocity: d2 });
            break;
          case 0xb:
            events.push({ type: 'controlChange', tick, channel, controller: d1, value: d2 });
            break;
          case 0xc:
            events.push({ type: 'programChange', tick, channel, program: d1 });
            break;
          default:
            events.push({
              type: 'unknown',
              tick,
              data: needs === 2 ? Uint8Array.of(status, d1, d2) : Uint8Array.of(status, d1),
            });
        }
      }
    }
  } catch (err) {
    // Truncated track: keep what we have.
    if (!(err instanceof RangeError)) throw err;
  }

  return name === undefined ? { events } : { name, events };
}

/**
 * Parse a Standard MIDI File.
 *
 * @param input Raw file bytes.
 * @returns The parsed file with absolute ticks on every event.
 * @throws Error if the data is not an SMF (missing `MThd`), or uses SMPTE time division.
 */
export function parseMidi(input: ArrayBuffer | Uint8Array): MidiFile {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);

  // Locate the header. Normally at offset 0; RIFF-wrapped (.rmi) files embed it later.
  let headerPos = -1;
  for (let i = 0; i + 4 <= data.length && i < 4096; i++) {
    if (readU32(data, i) === FOURCC_MTHD) {
      headerPos = i;
      break;
    }
  }
  if (headerPos < 0) throw new Error('Not a Standard MIDI File (missing MThd header)');
  if (headerPos + 14 > data.length) throw new Error('Truncated MIDI header');

  const headerLength = readU32(data, headerPos + 4);
  const formatRaw = readU16(data, headerPos + 8);
  const division = readU16(data, headerPos + 12);

  if (division & 0x8000) {
    throw new Error('SMPTE time division is not supported (only PPQ-based MIDI files can be loaded)');
  }
  if (division === 0) throw new Error('Invalid MIDI file: PPQ is 0');

  const format: 0 | 1 | 2 = formatRaw === 0 || formatRaw === 1 || formatRaw === 2 ? formatRaw : 1;
  const tracks: MidiTrack[] = [];

  let pos = headerPos + 8 + Math.max(6, headerLength);
  while (pos + 8 <= data.length) {
    const id = readU32(data, pos);
    const length = readU32(data, pos + 4);
    const bodyStart = pos + 8;
    const bodyEnd = Math.min(bodyStart + length, data.length);
    if (id === FOURCC_MTRK) {
      tracks.push(parseTrack(data, bodyStart, bodyEnd));
    } else if (id !== FOURCC_MTHD && !isPlausibleChunkId(id)) {
      // Trailing garbage: stop.
      break;
    }
    pos = bodyStart + length;
  }

  return { format, ppq: division, tracks };
}

/** True when all four bytes of a chunk id are printable ASCII (alien-but-valid chunks get skipped, garbage stops parsing). */
function isPlausibleChunkId(id: number): boolean {
  for (let shift = 0; shift < 32; shift += 8) {
    const c = (id >>> shift) & 0xff;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

// ─────────────────────────── Writing ───────────────────────────

/** Clamp a value to a 7-bit data byte. */
function data7(v: number): number {
  return Math.min(127, Math.max(0, Math.round(v))) & 0x7f;
}

/** Clamp a channel to 0..15. */
function chan(v: number): number {
  return Math.min(15, Math.max(0, Math.round(v))) & 0x0f;
}

/**
 * Serialise one track body (without the MTrk header). Events are stably sorted
 * by tick, existing `endOfTrack` events are stripped and a single end-of-track
 * is appended at the last tick. A `trackName` event is synthesised from
 * `track.name` when the track has none.
 */
function writeTrack(track: MidiTrack): number[] {
  let endTick = 0;
  const events: MidiEvent[] = [];
  for (const ev of track.events) {
    if (ev.type === 'endOfTrack') endTick = Math.max(endTick, ev.tick);
    else events.push(ev);
  }
  if (track.name !== undefined && !events.some((e) => e.type === 'trackName')) {
    events.unshift({ type: 'trackName', tick: 0, text: track.name });
  }
  events.sort((a, b) => a.tick - b.tick); // Array.prototype.sort is stable

  const out: number[] = [];
  let lastTick = 0;
  let running = -1;

  const pushDelta = (tick: number) => {
    const t = Math.max(lastTick, Math.round(tick));
    out.push(...writeVarLen(Math.min(MAX_VARLEN, t - lastTick)));
    lastTick = t;
  };
  const pushChannel = (status: number, ...bytes: number[]) => {
    if (status !== running) {
      out.push(status);
      running = status;
    }
    out.push(...bytes);
  };
  const pushMeta = (metaType: number, payload: ArrayLike<number>) => {
    out.push(0xff, metaType, ...writeVarLen(payload.length));
    for (let i = 0; i < payload.length; i++) out.push(payload[i]);
    running = -1; // meta events cancel running status
  };

  for (const ev of events) {
    pushDelta(ev.tick);
    switch (ev.type) {
      case 'noteOn':
        if (ev.velocity <= 0) pushChannel(0x80 | chan(ev.channel), data7(ev.note), 0);
        else pushChannel(0x90 | chan(ev.channel), data7(ev.note), data7(ev.velocity));
        break;
      case 'noteOff':
        pushChannel(0x80 | chan(ev.channel), data7(ev.note), data7(ev.velocity));
        break;
      case 'controlChange':
        pushChannel(0xb0 | chan(ev.channel), data7(ev.controller), data7(ev.value));
        break;
      case 'programChange':
        pushChannel(0xc0 | chan(ev.channel), data7(ev.program));
        break;
      case 'tempo': {
        let mpq = Number.isFinite(ev.microsecondsPerQuarter) && ev.microsecondsPerQuarter > 0
          ? Math.round(ev.microsecondsPerQuarter)
          : Math.round(60_000_000 / (ev.bpm > 0 ? ev.bpm : 120));
        mpq = Math.min(0xffffff, Math.max(1, mpq));
        pushMeta(0x51, [(mpq >> 16) & 0xff, (mpq >> 8) & 0xff, mpq & 0xff]);
        break;
      }
      case 'timeSignature': {
        const num = Math.min(255, Math.max(1, Math.round(ev.numerator)));
        const den = ev.denominator > 0 ? Math.round(Math.log2(ev.denominator)) : 2;
        pushMeta(0x58, [num, Math.min(255, Math.max(0, den)), 24, 8]);
        break;
      }
      case 'trackName':
        pushMeta(0x03, encodeText(ev.text));
        break;
      case 'text':
        pushMeta(0x01, encodeText(ev.text));
        break;
      case 'unknown':
        for (let i = 0; i < ev.data.length; i++) out.push(ev.data[i]);
        running = -1;
        break;
      case 'endOfTrack':
        // stripped above
        break;
    }
  }

  pushDelta(Math.max(endTick, lastTick));
  out.push(0xff, 0x2f, 0x00);
  return out;
}

/**
 * Serialise a `MidiFile` into SMF bytes.
 *
 * - Writes format 0 when there is a single track, format 1 otherwise
 *   (`file.format` is not consulted).
 * - Events in each track are stably sorted by tick and converted to delta-times.
 * - Channel messages use running status; each track ends with an end-of-track meta event.
 *
 * The output round-trips through {@link parseMidi}.
 *
 * @throws RangeError if `ppq` is not an integer in 1..32767.
 */
export function writeMidi(file: MidiFile): Uint8Array {
  const ppq = Math.round(file.ppq);
  if (!Number.isFinite(ppq) || ppq < 1 || ppq > 0x7fff) {
    throw new RangeError(`Invalid PPQ ${file.ppq}; must be an integer in 1..32767`);
  }
  const format = file.tracks.length <= 1 ? 0 : 1;
  const bodies = file.tracks.map(writeTrack);

  let total = 14;
  for (const b of bodies) total += 8 + b.length;
  const out = new Uint8Array(total);
  let pos = 0;
  const u32 = (v: number) => {
    out[pos++] = (v >>> 24) & 0xff;
    out[pos++] = (v >>> 16) & 0xff;
    out[pos++] = (v >>> 8) & 0xff;
    out[pos++] = v & 0xff;
  };
  const u16 = (v: number) => {
    out[pos++] = (v >>> 8) & 0xff;
    out[pos++] = v & 0xff;
  };

  u32(FOURCC_MTHD);
  u32(6);
  u16(format);
  u16(file.tracks.length);
  u16(ppq);
  for (const b of bodies) {
    u32(FOURCC_MTRK);
    u32(b.length);
    out.set(b, pos);
    pos += b.length;
  }
  return out;
}
