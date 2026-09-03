import type { App, Screen } from '@/app';
import { DRUM_VOICES, VOICE_LABELS, type DrumVoice } from '@/types';
import { h, button, field, toast, clear, downloadBlob, pickFile } from './dom';
import { topbar } from './topbar';
import { VOICE_COLORS } from '@/game/renderer';
import { Metronome, Transport } from '@/audio';

export function settingsScreen(app: App): Screen {
  const s = app.settings;
  const num = (v: number, step: number, min: number, max: number, onChange: (n: number) => void) => {
    const input = h('input', { class: 'input', type: 'number', step, min, max, value: v, onChange: (e: Event) => onChange(Number((e.target as HTMLInputElement).value)) });
    return input;
  };
  const range = (v: number, min: number, max: number, step: number, onInput: (n: number) => void) => {
    const label = h('span', { class: 'mono small', style: { minWidth: '52px', display: 'inline-block' } }, fmt(v));
    const input = h('input', { class: 'input', type: 'range', min, max, step, value: v, style: { flex: 1 }, onInput: (e: Event) => { const n = Number((e.target as HTMLInputElement).value); label.textContent = fmt(n); onInput(n); } });
    function fmt(n: number): string { return max <= 1 ? `${Math.round(n * 100)}%` : `${n}`; }
    return h('div', { class: 'row' }, input, label);
  };

  const offsetInput = num(Math.round(s.inputOffset * 1000), 1, -300, 300, (ms) => app.settingsStore.update({ inputOffset: ms / 1000 }));

  // keyboard binding editor
  const keys = h('div', { class: 'voice-list' });
  function renderKeys(): void {
    clear(keys);
    const kb = app.settings.keyboard;
    for (const voice of DRUM_VOICES) {
      const chip = h('div', { class: 'voice-chip', style: { '--v': VOICE_COLORS[voice] } },
        h('div', { class: 'name' }, VOICE_LABELS[voice]),
        h('div', { class: 'pads' }, (kb[voice] ?? []).map((c) => c.replace('Key', '').replace('Digit', '')).join(' · ') || '—'),
        h('div', { class: 'btn-row' }, button('SET', () => captureKey(voice), 'icon small'), button('CLEAR', () => { app.settingsStore.update({ keyboard: { ...app.settings.keyboard, [voice]: [] } }); renderKeys(); }, 'icon ghost small')),
      );
      keys.appendChild(chip);
    }
  }
  function captureKey(voice: DrumVoice): void {
    toast(`Press a key for ${VOICE_LABELS[voice]}…`);
    app.input.keyboard.setEnabled(false);
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      window.removeEventListener('keydown', handler, true);
      app.input.keyboard.setEnabled(true);
      if (e.code === 'Escape') return;
      const kb = { ...app.settings.keyboard };
      for (const v of DRUM_VOICES) kb[v] = (kb[v] ?? []).filter((c) => c !== e.code);
      kb[voice] = [...(kb[voice] ?? []), e.code];
      app.settingsStore.update({ keyboard: kb });
      renderKeys();
    };
    window.addEventListener('keydown', handler, true);
  }
  renderKeys();

  // latency calibration
  const calib = h('div', { class: 'panel tight' });
  function renderCalib(result?: { mean: number; n: number }): void {
    clear(calib);
    calib.append(
      h('h3', { style: { marginTop: 0 } }, 'Latency calibration'),
      h('div', { class: 'small dim' }, 'Plays 12 clicks at 120 BPM. Hit any pad (or key) exactly on each click. We measure the average delay and set the input offset for you.'),
      result ? h('div', { style: { marginTop: '8px' } }, h('span', { class: 'pill ok' }, `avg ${(result.mean * 1000).toFixed(0)} ms over ${result.n} hits`)) : '',
      h('div', { class: 'btn-row', style: { marginTop: '10px' } }, button('RUN CALIBRATION', runCalibration, 'primary')),
    );
  }
  async function runCalibration(): Promise<void> {
    await app.boot();
    const ctx = app.engine.ctx;
    const bpm = 120;
    const beat = 60 / bpm;
    const clicks = 12;
    const silent = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * (beat * (clicks + 2))), ctx.sampleRate);
    const t = new Transport(app.engine);
    t.load(silent);
    const m = new Metronome(app.engine, t);
    m.setTempoMap([{ tick: 0, time: 0, bpm }], 480, [{ tick: 0, numerator: 4, denominator: 4 }]);
    m.setOffset(beat); // first click at 1 beat in
    await m.prepare();
    const deltas: number[] = [];
    const unsub = app.input.onHit((hit) => {
      const pos = t.positionAtPerfTime(hit.timeStamp) - beat - app.engine.inputLatencyCompensation;
      const nearest = Math.round(pos / beat) * beat;
      const d = pos - nearest;
      if (Math.abs(d) < beat / 2 && nearest >= 0 && nearest < beat * clicks) deltas.push(d);
    });
    toast('Calibrating… hit along with the clicks');
    t.play(0);
    m.start();
    await new Promise((r) => setTimeout(r, beat * (clicks + 1.5) * 1000));
    m.stop();
    t.stop();
    unsub();
    if (deltas.length < 4) {
      toast('Not enough hits registered. Try again.', 'bad');
      renderCalib();
      return;
    }
    deltas.sort((a, b) => a - b);
    const trimmed = deltas.slice(1, -1);
    const mean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    // player hits late by `mean` → subtract it from their timing
    app.settingsStore.update({ inputOffset: -mean });
    offsetInput.value = String(Math.round(-mean * 1000));
    renderCalib({ mean, n: deltas.length });
    toast(`Input offset set to ${Math.round(-mean * 1000)} ms`, 'ok');
  }
  renderCalib();

  const el = h(
    'div',
    { class: 'screen' },
    topbar(app, 'SETTINGS', button('BACK', () => app.navigate('title'), 'ghost')),
    h(
      'div',
      { class: 'screen-body' },
      h(
        'div',
        { class: 'grid-2', style: { maxWidth: '1100px', margin: '0 auto' } },
        h(
          'div',
          { class: 'panel' },
          h('h3', { style: { marginTop: 0 } }, 'Player'),
          field('Name (for high scores)', h('input', { class: 'input', value: s.playerName, maxLength: 16, onChange: (e: Event) => app.settingsStore.update({ playerName: (e.target as HTMLInputElement).value.trim().toUpperCase() || 'PLAYER' }) })),
          h('h3', null, 'Timing'),
          field('Input offset (ms)', offsetInput, 'Positive = your hits are judged earlier. Negative = later. Use calibration below if unsure.'),
          field('Highway length (seconds visible)', range(s.scrollWindow, 0.8, 3, 0.1, (v) => app.settingsStore.update({ scrollWindow: v })), 'Shorter = faster notes.'),
          h('div', { style: { marginTop: '12px' } }, calib),
          h('h3', null, 'Audio'),
          field('Song volume', range(s.songVolume, 0, 1, 0.01, (v) => app.settingsStore.update({ songVolume: v }))),
          field('Drum volume', range(s.drumVolume, 0, 1, 0.01, (v) => app.settingsStore.update({ drumVolume: v }))),
          h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.drumSoundsOnHit, onChange: (e: Event) => app.settingsStore.update({ drumSoundsOnHit: (e.target as HTMLInputElement).checked }) }), 'Play drum samples when I hit a pad (turn off if your FGDP makes its own sound)'),
          h('div', { style: { height: '8px' } }),
          h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.reducedMotion, onChange: (e: Event) => app.settingsStore.update({ reducedMotion: (e.target as HTMLInputElement).checked }) }), 'Reduced motion (no shake / particles)'),
        ),
        h(
          'div',
          { class: 'panel' },
          h('h3', { style: { marginTop: 0 } }, 'Keyboard fallback'),
          h('div', { class: 'small dim', style: { marginBottom: '10px' } }, 'No pads handy? Play with the keyboard. Click SET then press a key.'),
          keys,
          h('h3', null, 'Data'),
          h('div', { class: 'btn-row' },
            button('EXPORT SCORES', () => downloadBlob(new Blob([app.scores.exportJson()], { type: 'application/json' }), 'drumkiller-scores.json')),
            button('IMPORT SCORES', async () => { const [f] = await pickFile('.json'); if (!f) return; const r = app.scores.importJson(await f.text()); toast(`Imported ${r.imported} scores`, 'ok'); }),
            button('RESET ALL SCORES', () => { if (confirm('Delete ALL high scores?')) { app.scores.clear(); toast('Scores cleared'); } }, 'danger'),
            button('RESET SETTINGS', () => { app.settingsStore.reset(); app.navigate('settings'); }, 'danger'),
          ),
          h('h3', null, 'Devices'),
          h('div', { class: 'small dim' }, app.devices.list().length ? app.devices.list().map((d) => h('div', { class: 'row', style: { marginBottom: '6px' } }, h('span', { class: 'pill' }, d.deviceName), h('span', { class: 'mute' }, `${Object.values(d.bindings).flat().length} pads`), button('DELETE', () => { app.devices.remove(d.deviceKey); app.navigate('settings'); }, 'icon ghost small'))) : 'No saved pad setups yet.'),
        ),
      ),
    ),
  );
  return { el };
}
