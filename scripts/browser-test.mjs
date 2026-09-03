/**
 * Headless end-to-end smoke test (no Playwright needed): drives Chrome over the DevTools protocol.
 *
 *   npm run dev            # in one terminal
 *   node scripts/browser-test.mjs [http://localhost:5173/]
 *
 * Boots the app, opens the song list, plays 12 s of "Back Pocket" on expert with a scripted
 * keyboard auto-player, and asserts the judge scored the hits. Then turns on performance video
 * recording (Chrome's fake camera), plays a short take and checks the results screen offers a WebM
 * whose frames contain the composite. Screenshots (and a frame of the recording) land in ./.e2e/.
 * Set CHROME=/path/to/chrome to override the binary.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL = process.argv[2] ?? 'http://localhost:5173/';
const CHROME =
  process.env.CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : 'google-chrome');
const port = 9333 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-chrome-'));
const outDir = path.resolve('.e2e');
fs.mkdirSync(outDir, { recursive: true });

const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', 'about:blank'], { stdio: 'ignore' });
let targets = null;
for (let i = 0; i < 40 && !targets; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { /* not up yet */ }
}
if (!targets) fail('Chrome did not start (set CHROME=...)');
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') logs.push('[error] ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(outDir, name), Buffer.from(r.result.data, 'base64')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (text) => evaluate(`(() => { const b = Array.from(document.querySelectorAll('.btn')).find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click(); return true; })()`);
function fail(msg) { console.error('✗', msg); cleanup(); setTimeout(() => process.exit(1), 800); throw new Error(msg); }
function cleanup() { try { ws.close(); } catch { /* ignore */ } chrome.kill(); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }, 500); }
const assert = (cond, msg) => { if (!cond) fail(msg); console.log('✓', msg); };

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await sleep(2000);
  assert((await evaluate(`document.querySelector('.logo')?.textContent`))?.includes('DRUMKILLER'), 'title screen renders');
  await shot('01-title.png');
  await click('PLAYpick a song, chase the high score');
  await sleep(2500);
  const songs = await evaluate(`Array.from(document.querySelectorAll('.songcard .title')).map(e => e.textContent)`);
  assert(songs.length >= 2, `song list shows bundled songs (${songs.join(', ')})`);
  assert((await evaluate(`window.dk.kit.loaded.size`)) === 9, 'default drum kit synthesized (9 voices)');
  await shot('02-songs.png');
  await evaluate(`Array.from(document.querySelectorAll('.songcard')).find(c => c.textContent.includes('Back Pocket')).click()`);
  await sleep(600);
  await evaluate(`document.querySelector('.diff[data-d=expert]').click()`);
  await click('PLAY');
  await sleep(4000);
  const notes = await evaluate(`window.dkSession?.judge.notes.length ?? 0`);
  assert(notes > 500, `game session started with ${notes} expert notes`);
  await evaluate(`
    const keys = { kick:'Space', snare:'KeyF', tomHigh:'KeyG', tomMid:'KeyH', tomLow:'KeyK', hihatClosed:'KeyD', hihatOpen:'KeyS', ride:'KeyL', crash:'KeyA' };
    const s = window.dkSession; const notes = s.judge.notes; let i = 0;
    (function tick() { if (!window.dkSession) return; const t = s.chartTime;
      while (i < notes.length && notes[i].time <= t + 0.004) { const n = notes[i++]; if (n.time < t - 0.1) continue;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: keys[n.voice], bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code: keys[n.voice], bubbles: true })); }
      requestAnimationFrame(tick); })();`);
  await sleep(12000);
  await shot('03-gameplay.png');
  const j = await evaluate(`JSON.stringify({ score: dkSession.judge.score, combo: dkSession.judge.maxCombo, acc: dkSession.judge.accuracy, hits: dkSession.judge.hits, over: dkSession.judge.overhits, err: dkSession.judge.meanSignedError })`).then(JSON.parse);
  console.log('  judge:', JSON.stringify(j));
  assert(j.score > 0 && j.combo > 50, `auto-player scored ${j.score} with max combo ${j.combo}`);
  assert(j.acc > 0.9, `accuracy ${(j.acc * 100).toFixed(1)}% > 90%`);
  assert(Math.abs(j.err) < 0.03, `mean timing error ${(j.err * 1000).toFixed(1)} ms within ±30 ms`);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }))`);
  await sleep(300);
  assert(await evaluate(`dkSession.isPaused`), 'ESC pauses');
  await click('QUIT');
  await sleep(800);
  assert((await evaluate(`location.hash`)) === '#songs', 'quit returns to song list');

  // ── performance video recording (fake webcam) ──
  await evaluate(`window.dk.settingsStore.update({ recordVideo: true, recordResolution: 720 })`);
  await evaluate(`Array.from(document.querySelectorAll('.songcard')).find(c => c.textContent.includes('Back Pocket')).click()`);
  await sleep(600);
  await evaluate(`document.querySelector('.diff[data-d=medium]').click()`);
  await click('PLAY');
  await sleep(5000);
  assert(await evaluate(`!!document.querySelector('.hud .cam-preview') && document.querySelector('.hud .cam-preview').videoWidth > 0`), 'webcam preview is live in the HUD');
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', bubbles: true }))`);
  await sleep(2500);
  await shot('04-recording.png');
  await evaluate(`window.dkSession.finishNow()`);
  await sleep(2500);
  assert((await evaluate(`location.hash`)) === '#results', 'take finished → results screen');
  const vid = await evaluate(`(async () => {
    const v = document.querySelector('.video-box video'); if (!v) return null;
    const r = await fetch(v.src); const blob = await r.blob();
    const probe = document.createElement('video'); probe.muted = true; probe.src = URL.createObjectURL(blob);
    await new Promise((res) => { probe.onloadeddata = res; probe.onerror = res; });
    probe.currentTime = 3;
    await new Promise((res) => { probe.onseeked = res; setTimeout(res, 3000); });
    const c = document.createElement('canvas'); c.width = probe.videoWidth; c.height = probe.videoHeight;
    c.getContext('2d').drawImage(probe, 0, 0);
    return { size: blob.size, type: blob.type, w: probe.videoWidth, h: probe.videoHeight, png: c.toDataURL('image/png').split(',')[1] };
  })()`);
  assert(vid && vid.size > 50_000, `results screen offers a recording (${vid ? (vid.size / 1024).toFixed(0) + ' KB ' + vid.type : 'none'})`);
  assert(vid.w === 1280 && vid.h === 720, `recording is 1280×720 (got ${vid.w}×${vid.h})`);
  fs.writeFileSync(path.join(outDir, '05-recording-frame.png'), Buffer.from(vid.png, 'base64'));
  await shot('06-results-video.png');
  await evaluate(`window.dk.settingsStore.update({ recordVideo: false })`);
  const errors = logs.filter((l) => !l.includes('favicon'));
  assert(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log(`\nAll good. Screenshots in ${outDir}`);
} catch (e) {
  fail(e.message);
}
cleanup();
setTimeout(() => process.exit(0), 800);
