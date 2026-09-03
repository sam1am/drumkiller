import { App } from './app';
import { h } from './ui/dom';
import { titleScreen } from './ui/title';
import { songSelectScreen } from './ui/songselect';
import { gameScreen } from './ui/game';
import { resultsScreen } from './ui/results';
import { wizardScreen } from './ui/wizard';
import { settingsScreen } from './ui/settings';
import { studioScreen } from './ui/studio';

const root = document.getElementById('app')!;
root.appendChild(h('div', { class: 'backdrop' }));
const app = new App(root);
app.register('title', titleScreen);
app.register('songs', (a) => songSelectScreen(a, { practice: false }));
app.register('songs-practice', (a) => songSelectScreen(a, { practice: true }));
app.register('game', gameScreen);
app.register('results', resultsScreen);
app.register('wizard', wizardScreen);
app.register('settings', settingsScreen);
app.register('studio', studioScreen);

// Deep-linkable top-level screens (game/results need params, so they fall back to title).
const initial = location.hash.replace('#', '');
const direct = ['songs', 'songs-practice', 'wizard', 'settings', 'studio'];
app.navigate(direct.includes(initial) ? initial : 'title');

// Expose for debugging / automated tests.
(window as unknown as { dk: App }).dk = app;
