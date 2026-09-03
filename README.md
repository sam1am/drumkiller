# DRUMKILLER

**Play it now: https://sam1am.github.io/drumkiller/**

A finger-drumming rhythm game in the spirit of Guitar Hero — for MIDI pad controllers (4×4 pads, Yamaha FGDP-30/50, e-kits) — that runs in the browser on Mac, Linux, and Windows.

```
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # static build in dist/ — host anywhere
```

Use **Chrome or Edge** (Web MIDI). Firefox 108+ also works. Safari has no Web MIDI; the keyboard fallback still works there.

## What it does

- **Six drum tracks on a 3D highway**: hi-hat (closed ✕ / open ◯ symbols), snare, kick, toms (high/mid/low as sub-positions in one lane), ride, and crash as a full-width horizontal bar.
- **Four difficulties** per song: easy, medium, hard, expert. If a song folder only ships an `expert.mid`, the easier charts are derived automatically with musical rules (ghost notes go first, hats thin to 8ths → quarters, fills collapse to their last hit, and so on).
- **Scoring**: perfect/great/good hit windows, combo multiplier up to 4×, overhit penalty, star rating, full-combo badge, per-song per-difficulty leaderboards (top 25) saved locally, exportable as JSON.
- **Practice mode**: 50–125% speed, A/B looping, seek, optional guide drums. Scores are never saved.
- **Studio (recorder)**: load any drum-less mix (mp3/wav/flac/aac/m4a/ogg), tap tempo, set the offset by hitting a pad on the first downbeat, record a take with count-in + metronome, then **quantize** (1/4 … 1/32, triplets, strength, swing, double-hit merge) with live preview, and save as any difficulty. Export the chart as standard **MIDI** (GM drum notes on channel 10) to polish in a DAW, or download the whole **song folder as a zip**.
- **Song folders**: everything for a song lives in one folder — `song.json`, the audio, one MIDI per difficulty, optional custom drum samples and artwork. Zip it and share it. Drag a zip onto the song list to import. See [docs/SONG-FORMAT.md](docs/SONG-FORMAT.md).
- **Pad Setup wizard**: walks through kick, snare, toms, hats, ride, crash and asks you to hit the pad(s) for each. Saved per MIDI device. Presets for FGDP-30/50, generic 4×4 pads (MPD/MPK/Launchpad/…), and General MIDI.
- **Built-in drum kit**: synthesized at startup (no downloads); any song can override any drum with its own samples.
- **Latency calibration** in Settings, plus a keyboard fallback so you can play with no hardware.
- **Performance video**: turn on *Record my performances* in Settings and every play/practice take is recorded in the browser — your webcam overlaid on the game screen (small window bottom-left or a full-height left column), the live HUD, and the game audio (optionally your mic). The results screen shows the video with a **SAVE VIDEO** button. It is plain WebM from `MediaRecorder`, so nothing leaves your machine and the site stays static. 720p is the default; 1080p costs more CPU.

## Chart editor

Song list → **EDIT CHART** (or Studio → **OPEN IN EDITOR**) opens a piano-roll editor: one row per drum over the song's waveform and beat grid. Click to add a note, drag to move it (across rows to change the drum), shift-drag for marquee selection, right-click to delete, ⌘Z/⇧⌘Z undo/redo, ⌘D duplicate a bar later, arrow keys nudge on the snap grid, velocity slider, snap grid from 1/4 to 1/32 and triplets, ⌘+wheel to zoom. Space plays the song with your drum samples; while playing, pad hits insert notes at the playhead. Save writes `<difficulty>.mid` back into the song folder in your library, or export the MIDI / whole song zip.

## Keyboard fallback

| Key | Drum |
| --- | --- |
| Space / B | kick |
| F / J | snare |
| D | hi-hat closed |
| S | hi-hat open |
| G / H / K | tom high / mid / low |
| L | ride |
| A / ; | crash |

`Esc` pauses. `[` / `]` nudge the input offset by 10 ms while playing.

## Timing feels off?

- The HUD shows your average timing error live ("+120ms LATE"), and stray hits show how far they were from the nearest note.
- Pause (`Esc`) → **AUTO-FIX OFFSET** sets the input offset from what you have played so far. The results screen offers the same.
- Settings → **Hit window size** scales the perfect/great/good windows (default 1.5×; presets from TIGHT to VERY LOOSE), and **Strict drums** can be turned off so any drum on the same lane counts.
- Settings → **Run calibration** for a click-based measurement. Pad Setup's MIDI monitor shows each event's timestamp skew; if a device reports timestamps in the wrong clock domain the game falls back to arrival time automatically.

## Project layout

```
src/types.ts      shared data contracts (chart, song.json schema, device config, settings)
src/midi/         SMF parser/writer, GM drum map + device presets, chart<->MIDI, quantizer, difficulty derivation
src/audio/        AudioEngine, Transport (variable-rate playback), synthesized DrumKit, ChartPlayer, Metronome, WAV codec
src/song/         song folder/zip packaging, IndexedDB library, bundled-song discovery
src/store/        high scores, device configs, settings (localStorage)
src/input/        Web MIDI + keyboard → unified hit stream
src/game/         Judge (scoring), HighwayRenderer (canvas), GameSession (ties it together)
src/ui/           screens: title, song select, game, results, pad wizard, studio, settings
scripts/          make-demo-song.mjs — generates the two bundled demo songs (audio + charts) from scratch
public/songs/     bundled songs (index.json lists folder names)
docs/SONG-FORMAT.md
```

## Deploying

Pushes to `main` run `.github/workflows/pages.yml`, which runs the tests, builds the game, and publishes `docs/` (landing page) plus the build under `/play` to GitHub Pages.

## Adding songs

1. Put a folder in `public/songs/<slug>/` with `song.json`, the audio, and `expert.mid` (see the format doc), and add the slug to `public/songs/index.json`. Or:
2. Import a zip / folder from the song list (stored in the browser's IndexedDB). Or:
3. Make one in the Studio.

Regenerate the demo songs with `npm run demo-song`.
