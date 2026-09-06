# DRUMKILLER — notes for contributors

Browser rhythm game for MIDI finger-drum pads. Vite + TypeScript, no UI framework, Canvas 2D highway, Web MIDI + Web Audio.

- `npm run dev` / `npm test` / `npm run typecheck` / `npm run build` / `npm run e2e` (headless Chrome smoke test against a running dev server) / `npm run demo-song` (regenerates the two bundled songs; uses ffmpeg for AAC if present).
- `src/types.ts` is the shared contract — change it deliberately; every module depends on it.
- Time model: `chartTime = transport.position − song.offset`. Input hits are timestamped with `performance.now()` and mapped to the audio clock via `AudioEngine.perfToAudioTime` (uses `getOutputTimestamp`, so no extra output-latency compensation on that path — see `inputLatencyCompensation`).
- Charts are standard MIDI (GM drum notes, channel 10). `deriveDifficulty` is filter-only: easy ⊆ medium ⊆ hard ⊆ expert.
- Song folder format is documented in `docs/SONG-FORMAT.md`; `public/songs/index.json` lists bundled folders.
- Performance video: `src/game/videoRecorder.ts` composites highway canvas + webcam + a canvas repaint of the DOM HUD into an offscreen 16:9 canvas each frame (`SessionCallbacks.onFrame`), and records it with `MediaRecorder` together with `AudioEngine.captureNode` (master bus tap). When the take ends, `VideoRecorder.finish(card)` keeps recording for `OUTRO_MS` showing a results card (score, stars, stats, judgement bars, timing heatmap) over the frozen highway, with the camera still live; the game screen passes the results screen a *promise* of the video, shown as a placeholder until it resolves. The e2e test exercises it with Chrome's fake camera.
- Studio (`src/ui/studio.ts`): SONG and CHART tabs over one in-memory working copy. Recording happens inside the chart editor (`src/ui/chartEditor.ts`): `Transport.play(from, atAudioTime)` schedules the song after a count-in whose clicks come from a separate `Metronome`, and pad/keyboard hits are inserted at the snapped playhead. A song may carry a second mix with drums (`meta.audioWithDrums`); the editor swaps it in with `Transport.swapBuffer`.
- Results screen: `src/game/timingHeatmap.ts` draws every judged hit (voice + signed delta, passed from the game screen) as a heat map over the strike line.
- `window.dk` (App), `window.dkSession` (active GameSession) and `window.dkEditor` (open chart editor) are exposed for debugging and the e2e test.
