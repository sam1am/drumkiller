# DRUMKILLER — notes for contributors

Browser rhythm game for MIDI finger-drum pads. Vite + TypeScript, no UI framework, Canvas 2D highway, Web MIDI + Web Audio.

- `npm run dev` / `npm test` / `npm run typecheck` / `npm run build` / `npm run e2e` (headless Chrome smoke test against a running dev server) / `npm run demo-song` (regenerates the two bundled songs; uses ffmpeg for AAC if present).
- `src/types.ts` is the shared contract — change it deliberately; every module depends on it.
- Time model: `chartTime = transport.position − song.offset`. Input hits are timestamped with `performance.now()` and mapped to the audio clock via `AudioEngine.perfToAudioTime` (uses `getOutputTimestamp`, so no extra output-latency compensation on that path — see `inputLatencyCompensation`).
- Charts are standard MIDI (GM drum notes, channel 10). `deriveDifficulty` is filter-only: easy ⊆ medium ⊆ hard ⊆ expert.
- Song folder format is documented in `docs/SONG-FORMAT.md`; `public/songs/index.json` lists bundled folders.
- `window.dk` (App) and `window.dkSession` (active GameSession) are exposed for debugging and the e2e test.
