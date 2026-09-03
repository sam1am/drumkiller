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

`Esc` pauses.

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
