/**
 * Headless end-to-end smoke test (no Playwright needed): drives Chrome over the DevTools protocol.
 *
 *   npm run dev            # in one terminal
 *   node scripts/browser-test.mjs [http://localhost:5173/]
 *
 * Boots the app, opens the song list, plays 12 s of "Back Pocket" on expert with a scripted
 * keyboard auto-player, and asserts the judge scored the hits. Screenshots land in ./.e2e/.
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

const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
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
function fail(msg) { console.error('✗', msg); cleanup(); process.exit(1); }
function cleanup() { try { ws.close(); } catch { /* ignore */ } chrome.kill(); fs.rmSync(profile, { recursive: true, force: true }); }
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
      while (i < notes.length && notes[i].time <= t + 0.004) { const n = notes[i++]; if (n.time < t - 0.05) continue;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: keys[n.voice], bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code: keys[n.voice], bubbles: true })); }
      requestAnimationFrame(tick); })();`);
  await sleep(12000);
  await shot('03-gameplay.png');
  const j = await evaluate(`JSON.stringify({ score: dkSession.judge.score, combo: dkSession.judge.combo, acc: dkSession.judge.accuracy, hits: dkSession.judge.hits, over: dkSession.judge.overhits, err: dkSession.judge.meanSignedError })`).then(JSON.parse);
  console.log('  judge:', JSON.stringify(j));
  assert(j.score > 0 && j.combo > 50, `auto-player scored ${j.score} with combo ${j.combo}`);
  assert(j.acc > 0.9, `accuracy ${(j.acc * 100).toFixed(1)}% > 90%`);
  assert(Math.abs(j.err) < 0.03, `mean timing error ${(j.err * 1000).toFixed(1)} ms within ±30 ms`);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }))`);
  await sleep(300);
  assert(await evaluate(`dkSession.isPaused`), 'ESC pauses');
  await click('QUIT');
  await sleep(800);
  assert((await evaluate(`location.hash`)) === '#songs', 'quit returns to song list');
  const errors = logs.filter((l) => !l.includes('favicon'));
  assert(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log(`\nAll good. Screenshots in ${outDir}`);
} catch (e) {
  fail(e.message);
}
cleanup();
process.exit(0);
