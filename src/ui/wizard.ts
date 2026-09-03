import type { App, Screen } from '@/app';
import { VOICE_LABELS, type DeviceConfig, type DrumVoice, type PadBinding } from '@/types';
import { DEVICE_PRESETS, GM_DRUM_NAMES, findPreset } from '@/midi';
import { emptyBindings } from '@/store';
import type { RawMidiHit } from '@/input';
import { VOICE_COLORS } from '@/game/renderer';
import { VOICE_ORDER_FOR_UI } from '@/game/session';
import { h, button, toast, clear, select } from './dom';
import { topbar } from './topbar';

/**
 * Pad Setup wizard: walks through each drum voice and asks the player to hit the pad(s) for it.
 * Saves one config per MIDI device (keyed by port name).
 */
export function wizardScreen(app: App): Screen {
  let portName: string | null = app.input.midi.activePort?.name ?? app.input.midi.ports()[0]?.name ?? null;
  let bindings: Record<DrumVoice, PadBinding[]> = emptyBindings();
  let step = 0; // index into VOICE_ORDER_FOR_UI, or VOICE_ORDER_FOR_UI.length = done
  let testing = false;
  const monitorLines: string[] = [];

  if (portName) {
    const existing = app.devices.get(portName);
    if (existing) bindings = structuredClone(existing.bindings);
  }

  const portSelect = h('div');
  const chips = h('div', { class: 'voice-list' });
  const prompt = h('div');
  const monitor = h('div', { class: 'pad-monitor' }, 'Waiting for MIDI…\nHit any pad to see its note number here.');
  const controls = h('div', { class: 'btn-row', style: { marginTop: '16px' } });

  function renderPorts(): void {
    clear(portSelect);
    const ports = app.input.midi.ports();
    if (!app.input.midi.supported) {
      portSelect.appendChild(h('div', { class: 'hint-box' }, 'Web MIDI is not available in this browser. Use Chrome/Edge (or Firefox 108+). You can still play with the keyboard.'));
      return;
    }
    if (!ports.length) {
      portSelect.appendChild(h('div', { class: 'hint-box' }, app.input.midi.error ? `${app.input.midi.error} Allow MIDI access in the browser's site permissions, then reload.` : 'No MIDI inputs found. Plug in your pad controller (USB) and it will appear here automatically.'));
      return;
    }
    if (!portName || !ports.some((p) => p.name === portName)) portName = ports[0].name;
    const sel = select(ports.map((p) => ({ value: p.name, label: `${p.name}${p.manufacturer ? ' — ' + p.manufacturer : ''}` })), portName, (v) => {
      portName = v;
      const existing = app.devices.get(v);
      bindings = existing ? structuredClone(existing.bindings) : emptyBindings();
      app.selectDevice(v);
      step = 0;
      render();
    });
    const preset = findPreset(portName);
    portSelect.append(
      h('div', { class: 'row' }, h('div', { class: 'field', style: { flex: 1, marginBottom: 0 } }, h('label', null, 'MIDI device'), sel),
        h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', null, 'Preset'),
          h('div', { class: 'btn-row' }, ...DEVICE_PRESETS.map((p) => button(p.name, () => { bindings = structuredClone(p.bindings); step = VOICE_ORDER_FOR_UI.length; render(); toast(`Loaded ${p.name} preset`); }, p.id === preset.id ? 'primary' : ''))))),
    );
  }

  function renderChips(): void {
    clear(chips);
    VOICE_ORDER_FOR_UI.forEach((voice, i) => {
      const pads = bindings[voice] ?? [];
      const chip = h(
        'div',
        { class: `voice-chip ${i === step ? 'active' : ''} ${pads.length ? 'done' : ''}`, style: { '--v': VOICE_COLORS[voice] }, dataset: { voice }, onClick: () => { step = i; render(); } },
        h('div', { class: 'name' }, VOICE_LABELS[voice]),
        h('div', { class: 'pads' }, pads.length ? pads.map((p) => `${p.note}${p.channel >= 0 ? '/ch' + (p.channel + 1) : ''}`).join('  ') : '— not set —'),
      );
      chips.appendChild(chip);
    });
  }

  function renderPrompt(): void {
    clear(prompt);
    clear(controls);
    if (step >= VOICE_ORDER_FOR_UI.length) {
      const unset = VOICE_ORDER_FOR_UI.filter((v) => !(bindings[v] ?? []).length);
      prompt.append(
        h('div', { class: 'big-prompt' }, 'ALL SET. ', h('em', { style: { '--v': 'var(--great)' } }, 'TEST YOUR KIT')),
        h('div', { class: 'dim' }, unset.length ? `Unassigned: ${unset.map((v) => VOICE_LABELS[v]).join(', ')}. Those notes will be ignored in-game.` : 'Every drum has at least one pad. Hit pads to see them light up, then save.'),
      );
      testing = true;
      controls.append(
        button('SAVE FOR THIS DEVICE', save, 'primary big'),
        button('START OVER', () => { bindings = emptyBindings(); step = 0; render(); }, 'ghost'),
      );
      return;
    }
    testing = false;
    const voice = VOICE_ORDER_FOR_UI[step];
    const pads = bindings[voice] ?? [];
    prompt.append(
      h('div', { class: 'small dim' }, `STEP ${step + 1} / ${VOICE_ORDER_FOR_UI.length}`),
      h('div', { class: 'big-prompt', style: { '--v': VOICE_COLORS[voice] } }, 'HIT THE PAD FOR ', h('em', null, VOICE_LABELS[voice].toUpperCase())),
      h('div', { class: 'dim' }, 'Hit one or more pads — every pad you hit gets assigned to this drum. Then press NEXT. Hit the pad again to remove it.'),
      h('div', { style: { marginTop: '10px' } }, pads.length ? pads.map((p) => h('span', { class: 'pill accent', style: { marginRight: '6px' } }, `note ${p.note} (${GM_DRUM_NAMES[p.note] ?? '?'})${p.channel >= 0 ? ' ch' + (p.channel + 1) : ''}`)) : h('span', { class: 'mute' }, 'no pads yet')),
    );
    controls.append(
      button(step === VOICE_ORDER_FOR_UI.length - 1 ? 'FINISH' : 'NEXT', () => { step++; render(); }, 'primary'),
      button('SKIP', () => { step++; render(); }, 'ghost'),
      button('CLEAR', () => { bindings[voice] = []; render(); }, 'ghost'),
      step > 0 ? button('BACK', () => { step--; render(); }, 'ghost') : '',
    );
  }

  function render(): void {
    renderPorts();
    renderChips();
    renderPrompt();
  }

  function save(): void {
    if (!portName) {
      toast('No MIDI device selected', 'bad');
      return;
    }
    const existing = app.devices.get(portName);
    const cfg: DeviceConfig = existing
      ? { ...existing, bindings, updatedAt: Date.now() }
      : app.devices.createFromPreset(portName, portName, bindings);
    cfg.bindings = bindings;
    app.devices.save(cfg);
    app.selectDevice(portName);
    app.input.setDevice(cfg);
    toast(`Saved pad setup for ${portName}`, 'ok');
    app.navigate('title');
  }

  function onRaw(hit: RawMidiHit): void {
    if (portName && hit.portName !== portName) return;
    monitorLines.unshift(`note ${String(hit.note).padStart(3)}  ch ${String(hit.channel + 1).padStart(2)}  vel ${String(hit.velocity).padStart(3)}  ts ${hit.skew >= 0 ? '+' : ''}${Math.round(hit.skew)}ms${hit.timeStampFallback ? ' (ignored)' : ''}  ${GM_DRUM_NAMES[hit.note] ?? ''}`);
    monitorLines.splice(5);
    monitor.textContent = monitorLines.join('\n');
    if (testing) {
      // light up the chip whose binding matches
      for (const voice of VOICE_ORDER_FOR_UI) {
        if ((bindings[voice] ?? []).some((b) => b.note === hit.note && (b.channel === -1 || b.channel === hit.channel))) {
          const chip = chips.querySelector(`[data-voice="${voice}"]`);
          chip?.classList.remove('hit');
          void (chip as HTMLElement | null)?.offsetWidth;
          chip?.classList.add('hit');
          app.kit.trigger(voice, hit.velocity / 127);
        }
      }
      return;
    }
    if (step >= VOICE_ORDER_FOR_UI.length) return;
    const voice = VOICE_ORDER_FOR_UI[step];
    const pads = bindings[voice] ?? (bindings[voice] = []);
    const idx = pads.findIndex((p) => p.note === hit.note && (p.channel === -1 || p.channel === hit.channel));
    if (idx >= 0) pads.splice(idx, 1);
    else {
      // Remove this note from other voices so a pad maps to one drum only.
      for (const v of VOICE_ORDER_FOR_UI) if (v !== voice) bindings[v] = (bindings[v] ?? []).filter((p) => p.note !== hit.note);
      pads.push({ note: hit.note, channel: -1 });
      app.kit.trigger(voice, hit.velocity / 127);
    }
    render();
  }

  const unsubRaw = app.input.onRaw(onRaw);
  const unsubPorts = app.input.midi.onPortsChanged(() => render());
  app.boot().then(() => render());

  const el = h(
    'div',
    { class: 'screen' },
    topbar(app, 'PAD SETUP', button('BACK', () => app.navigate('title'), 'ghost')),
    h(
      'div',
      { class: 'screen-body center' },
      h(
        'div',
        { class: 'wizard' },
        h('div', { class: 'panel' }, portSelect, h('div', { style: { height: '16px' } }), prompt, controls),
        h('div', { style: { height: '16px' } }),
        h('div', { class: 'grid-2', style: { gridTemplateColumns: '1.4fr 1fr' } }, h('div', { class: 'panel tight' }, h('h3', { style: { marginTop: 0 } }, 'Kit map'), chips), h('div', { class: 'panel tight' }, h('h3', { style: { marginTop: 0 } }, 'MIDI monitor'), monitor)),
      ),
    ),
  );
  render();
  return { el, dispose: () => { unsubRaw(); unsubPorts(); } };
}
