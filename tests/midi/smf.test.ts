import { describe, expect, it } from 'vitest';
import { parseMidi, readVarLen, writeMidi, writeVarLen, type MidiEvent, type MidiFile } from '@/midi/smf';

describe('variable-length quantities', () => {
  const cases: [number, number[]][] = [
    [0, [0x00]],
    [127, [0x7f]],
    [128, [0x81, 0x00]],
    [0x3fff, [0xff, 0x7f]],
    [0x4000, [0x81, 0x80, 0x00]],
    [0x0fffffff, [0xff, 0xff, 0xff, 0x7f]],
  ];

  it.each(cases)('encodes %d', (value, bytes) => {
    expect(writeVarLen(value)).toEqual(bytes);
  });

  it.each(cases)('decodes %d', (value, bytes) => {
    const r = readVarLen(Uint8Array.from(bytes), 0);
    expect(r.value).toBe(value);
    expect(r.length).toBe(bytes.length);
  });

  it('reads with an offset', () => {
    const r = readVarLen(Uint8Array.from([0x00, 0x81, 0x00, 0x05]), 1);
    expect(r).toEqual({ value: 128, length: 2 });
  });

  it('rejects out-of-range values and truncated data', () => {
    expect(() => writeVarLen(-1)).toThrow(RangeError);
    expect(() => writeVarLen(0x10000000)).toThrow(RangeError);
    expect(() => writeVarLen(1.5)).toThrow(RangeError);
    expect(() => readVarLen(Uint8Array.from([0x81]), 0)).toThrow(RangeError);
  });
});

/** Hand-built format-0 file: 480 PPQ, one track, exercising running status + meta + sysex. */
function fixture(): Uint8Array {
  const track = [
    0x00, 0xff, 0x03, 0x05, 0x44, 0x72, 0x75, 0x6d, 0x73, // track name "Drums"
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // tempo 500000 µs = 120 bpm
    0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08, // 3/4
    0x00, 0x99, 0x24, 0x64, // noteOn ch9 note36 vel100
    0x00, 0x26, 0x50, // running status: note38 vel80
    0x60, 0x24, 0x00, // delta 96: noteOn vel0 → noteOff 36
    0x00, 0x26, 0x00, // noteOff 38
    0x00, 0xf0, 0x03, 0x01, 0x02, 0xf7, // sysex (skipped)
    0x00, 0xb9, 0x07, 0x64, // CC7 = 100
    0x81, 0x00, 0xc9, 0x10, // delta 128: program change 16
    0x00, 0xff, 0x7f, 0x02, 0xaa, 0xbb, // sequencer-specific meta (unknown)
    0x00, 0xe9, 0x00, 0x40, // pitch bend (unknown channel message)
    0x00, 0xff, 0x2f, 0x00, // end of track
  ];
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, // MThd len 6
    0x00, 0x00, 0x00, 0x01, 0x01, 0xe0, // format 0, 1 track, 480 ppq
    0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, track.length, // MTrk len
  ];
  return Uint8Array.from([...header, ...track]);
}

describe('parseMidi', () => {
  it('parses a hand-built file with running status, meta and sysex', () => {
    const midi = parseMidi(fixture());
    expect(midi.format).toBe(0);
    expect(midi.ppq).toBe(480);
    expect(midi.tracks).toHaveLength(1);
    const track = midi.tracks[0];
    expect(track.name).toBe('Drums');

    const ev = track.events;
    expect(ev[0]).toEqual({ type: 'trackName', tick: 0, text: 'Drums' });
    expect(ev[1]).toEqual({ type: 'tempo', tick: 0, bpm: 120, microsecondsPerQuarter: 500000 });
    expect(ev[2]).toEqual({ type: 'timeSignature', tick: 0, numerator: 3, denominator: 4 });
    expect(ev[3]).toEqual({ type: 'noteOn', tick: 0, channel: 9, note: 36, velocity: 100 });
    expect(ev[4]).toEqual({ type: 'noteOn', tick: 0, channel: 9, note: 38, velocity: 80 });
    expect(ev[5]).toEqual({ type: 'noteOff', tick: 96, channel: 9, note: 36, velocity: 0 });
    expect(ev[6]).toEqual({ type: 'noteOff', tick: 96, channel: 9, note: 38, velocity: 0 });
    // sysex skipped
    expect(ev[7]).toEqual({ type: 'controlChange', tick: 96, channel: 9, controller: 7, value: 100 });
    expect(ev[8]).toEqual({ type: 'programChange', tick: 224, channel: 9, program: 16 });
    expect(ev[9].type).toBe('unknown');
    expect(Array.from((ev[9] as { data: Uint8Array }).data)).toEqual([0xff, 0x7f, 0x02, 0xaa, 0xbb]);
    expect(ev[10].type).toBe('unknown');
    expect(Array.from((ev[10] as { data: Uint8Array }).data)).toEqual([0xe9, 0x00, 0x40]);
    expect(ev[11]).toEqual({ type: 'endOfTrack', tick: 224 });
    expect(ev).toHaveLength(12);
  });

  it('accepts an ArrayBuffer', () => {
    const bytes = fixture();
    const buf: ArrayBuffer = Uint8Array.from(bytes).buffer;
    expect(parseMidi(buf).tracks[0].events.length).toBe(12);
  });

  it('throws a clear error for SMPTE division', () => {
    const bytes = fixture();
    bytes[12] = 0xe7; // -25 fps
    bytes[13] = 0x28;
    expect(() => parseMidi(bytes)).toThrow(/SMPTE/);
  });

  it('throws for non-MIDI data', () => {
    expect(() => parseMidi(new Uint8Array(40))).toThrow(/MThd/);
  });

  it('tolerates a truncated last track', () => {
    const bytes = fixture();
    const cut = bytes.subarray(0, bytes.length - 9); // chop into the pitch-bend / EOT
    const midi = parseMidi(cut);
    expect(midi.tracks).toHaveLength(1);
    const types = midi.tracks[0].events.map((e) => e.type);
    expect(types).toContain('programChange');
    expect(types).not.toContain('endOfTrack');
  });

  it('tolerates trailing garbage after the last chunk', () => {
    const bytes = fixture();
    const garbage = Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const joined = new Uint8Array(bytes.length + garbage.length);
    joined.set(bytes);
    joined.set(garbage, bytes.length);
    const midi = parseMidi(joined);
    expect(midi.tracks).toHaveLength(1);
    expect(midi.tracks[0].events).toHaveLength(12);
  });
});

describe('writeMidi', () => {
  function sampleFile(): MidiFile {
    const meta: MidiEvent[] = [
      { type: 'trackName', tick: 0, text: 'Tempo' },
      { type: 'tempo', tick: 0, bpm: 120, microsecondsPerQuarter: 500000 },
      { type: 'timeSignature', tick: 0, numerator: 4, denominator: 4 },
      { type: 'tempo', tick: 1920, bpm: 90, microsecondsPerQuarter: 666667 },
      { type: 'text', tick: 960, text: 'hello ünïcode' },
    ];
    const drums: MidiEvent[] = [
      { type: 'noteOn', tick: 0, channel: 9, note: 36, velocity: 100 },
      { type: 'noteOn', tick: 0, channel: 9, note: 42, velocity: 64 },
      { type: 'noteOff', tick: 60, channel: 9, note: 36, velocity: 0 },
      { type: 'noteOff', tick: 60, channel: 9, note: 42, velocity: 0 },
      { type: 'noteOn', tick: 240, channel: 9, note: 38, velocity: 127 },
      { type: 'noteOff', tick: 300, channel: 9, note: 38, velocity: 0 },
      { type: 'controlChange', tick: 300, channel: 9, controller: 7, value: 100 },
      { type: 'programChange', tick: 300, channel: 9, program: 1 },
      { type: 'unknown', tick: 400, data: Uint8Array.of(0xe9, 0x00, 0x40) },
      { type: 'noteOn', tick: 100000, channel: 9, note: 49, velocity: 90 }, // multi-byte delta
      { type: 'noteOff', tick: 100060, channel: 9, note: 49, velocity: 0 },
    ];
    return { format: 1, ppq: 480, tracks: [{ name: 'Tempo', events: meta }, { name: 'Drums', events: drums }] };
  }

  it('round-trips through parseMidi', () => {
    const file = sampleFile();
    const bytes = writeMidi(file);
    const back = parseMidi(bytes);
    expect(back.format).toBe(1);
    expect(back.ppq).toBe(480);
    expect(back.tracks).toHaveLength(2);
    expect(back.tracks[0].name).toBe('Tempo');
    expect(back.tracks[1].name).toBe('Drums');

    const strip = (events: MidiEvent[]) =>
      events
        .filter((e) => e.type !== 'endOfTrack')
        .map((e) => (e.type === 'unknown' ? { ...e, data: Array.from(e.data) } : e))
        .sort((a, b) => a.tick - b.tick);

    // Tempo track: order by tick, bpm within float precision of the written µs value.
    const meta = strip(back.tracks[0].events);
    expect(meta.map((e) => e.type)).toEqual(['trackName', 'tempo', 'timeSignature', 'text', 'tempo']);
    expect(meta[1]).toMatchObject({ tick: 0, bpm: 120, microsecondsPerQuarter: 500000 });
    expect(meta[3]).toEqual({ type: 'text', tick: 960, text: 'hello ünïcode' });
    expect((meta[4] as { bpm: number }).bpm).toBeCloseTo(90, 3);

    const drums = strip(back.tracks[1].events);
    expect(drums).toEqual([{ type: 'trackName', tick: 0, text: 'Drums' }, ...strip(file.tracks[1].events)]);
    // The end-of-track lands on the last event tick.
    const eot = back.tracks[1].events.at(-1)!;
    expect(eot).toEqual({ type: 'endOfTrack', tick: 100060 });
  });

  it('uses running status for consecutive channel messages', () => {
    const file: MidiFile = {
      format: 0,
      ppq: 96,
      tracks: [
        {
          events: [
            { type: 'noteOn', tick: 0, channel: 9, note: 36, velocity: 100 },
            { type: 'noteOn', tick: 0, channel: 9, note: 38, velocity: 100 },
            { type: 'noteOn', tick: 0, channel: 9, note: 42, velocity: 100 },
          ],
        },
      ],
    };
    const bytes = writeMidi(file);
    // header(14) + MTrk header(8) + [00 99 24 64] + [00 26 64] + [00 2A 64] + [00 FF 2F 00]
    expect(bytes.length).toBe(14 + 8 + 4 + 3 + 3 + 4);
    expect(bytes[8 + 1]).toBe(0); // format 0
    const back = parseMidi(bytes);
    expect(back.tracks[0].events.filter((e) => e.type === 'noteOn')).toHaveLength(3);
  });

  it('writes format 0 for a single track and format 1 otherwise', () => {
    expect(parseMidi(writeMidi({ format: 1, ppq: 480, tracks: [{ events: [] }] })).format).toBe(0);
    expect(parseMidi(writeMidi({ format: 0, ppq: 480, tracks: [{ events: [] }, { events: [] }] })).format).toBe(1);
  });

  it('sorts events by tick (stable) before writing', () => {
    const file: MidiFile = {
      format: 0,
      ppq: 480,
      tracks: [
        {
          events: [
            { type: 'noteOn', tick: 480, channel: 0, note: 60, velocity: 1 },
            { type: 'noteOn', tick: 0, channel: 0, note: 61, velocity: 2 },
            { type: 'noteOn', tick: 0, channel: 0, note: 62, velocity: 3 },
          ],
        },
      ],
    };
    const back = parseMidi(writeMidi(file));
    const notes = back.tracks[0].events.filter((e): e is Extract<MidiEvent, { type: 'noteOn' }> => e.type === 'noteOn');
    expect(notes.map((n) => [n.tick, n.note])).toEqual([
      [0, 61],
      [0, 62],
      [480, 60],
    ]);
  });

  it('rejects invalid PPQ', () => {
    expect(() => writeMidi({ format: 0, ppq: 0, tracks: [] })).toThrow(RangeError);
  });
});
