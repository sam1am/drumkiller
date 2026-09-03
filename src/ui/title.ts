import type { App, Screen } from '@/app';
import { h, button } from './dom';

export function titleScreen(app: App): Screen {
  const status = h('div', { class: 'status-strip' });
  const refreshStatus = () => {
    status.replaceChildren();
    const midi = app.input.midi;
    if (!midi.supported) status.appendChild(h('span', { class: 'pill bad' }, 'No Web MIDI — keyboard only'));
    else if (!midi.ready) status.appendChild(h('span', { class: 'pill' }, 'MIDI: click to connect'));
    else {
      const ports = midi.ports();
      if (!ports.length) status.appendChild(h('span', { class: 'pill warn' }, 'MIDI: no devices found'));
      else {
        const active = midi.activePort;
        status.appendChild(h('span', { class: 'pill ok' }, `MIDI: ${active?.name ?? ports[0].name}`));
        if (ports.length > 1) status.appendChild(h('span', { class: 'pill' }, `+${ports.length - 1} more`));
      }
    }
    status.appendChild(h('span', { class: 'pill' }, `Keys: `, h('kbd', null, 'D'), ' hat ', h('kbd', null, 'F'), ' snare ', h('kbd', null, 'Space'), ' kick'));
  };
  refreshStatus();
  const unsub = app.input.midi.onPortsChanged(refreshStatus);

  const go = (name: string) => async () => {
    await app.boot();
    refreshStatus();
    app.navigate(name);
  };

  const menuItem = (label: string, hint: string, name: string, cls = '') => {
    const b = button([label, h('span', { class: 'hint' }, hint)], go(name), cls);
    return b;
  };

  const el = h(
    'div',
    { class: 'screen' },
    h(
      'div',
      { class: 'screen-body center' },
      h(
        'div',
        { class: 'title-wrap' },
        h('h1', { class: 'logo' }, h('span', { class: 'a' }, 'DRUMKILLER'), h('span', { class: 'b' }, 'FINGER DRUM ARCADE')),
        h('div', { class: 'tagline' }, 'plug in your pads · hit the notes · burn the highway'),
        h(
          'div',
          { class: 'menu' },
          menuItem('PLAY', 'pick a song, chase the high score', 'songs', 'primary'),
          menuItem('PRACTICE', 'slow it down, loop sections, no pressure', 'songs-practice'),
          menuItem('STUDIO', 'record a performance → MIDI chart → song folder', 'studio'),
          menuItem('PAD SETUP', 'assign your pads to each drum, per device', 'wizard'),
          menuItem('SETTINGS', 'latency, volumes, keys', 'settings'),
        ),
        status,
        h('div', { class: 'small mute' }, 'Works with any MIDI pad controller (4×4 pads, Yamaha FGDP-30/50, e-kits). Chrome or Edge recommended.'),
      ),
    ),
  );
  return { el, dispose: () => unsub() };
}
