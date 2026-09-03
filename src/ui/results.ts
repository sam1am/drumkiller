import type { App, Screen } from '@/app';
import type { Difficulty, HighScore, ScoreSummary, SongPackage } from '@/types';
import { h, button, fmtScore, pct } from './dom';
import { topbar } from './topbar';
import { starString } from '@/game/scoring';

export function resultsScreen(app: App, params?: Record<string, unknown>): Screen {
  const pkg = params?.pkg as SongPackage;
  const difficulty = params?.difficulty as Difficulty;
  const mode = params?.mode as string;
  const summary = params?.summary as ScoreSummary;
  const rate = (params?.rate as number) ?? 1;
  const saved = mode === 'play';
  let rankInfo: { rank: number; isNewBest: boolean } | null = null;
  const entry: HighScore = { ...summary, songId: pkg.meta.id, difficulty, player: app.settings.playerName || 'PLAYER', date: Date.now() };
  if (saved && summary.totalNotes > 0) rankInfo = app.scores.submit(entry);

  const top = app.scores.getTop(pkg.meta.id, difficulty, 10);
  const total = Math.max(1, summary.totalNotes);
  const bar = (label: string, n: number, color: string) => h('div', { class: 'jb' }, h('span', null, label), h('div', { class: 'bar' }, h('div', { style: { width: `${(n / total) * 100}%`, background: color } })), h('span', { style: { textAlign: 'right' } }, String(n)));

  const verdict = summary.fullCombo ? 'FULL COMBO!' : summary.stars >= 5 ? 'FLAWLESS' : summary.stars >= 4 ? 'KILLER' : summary.stars >= 3 ? 'SOLID' : summary.stars >= 2 ? 'ROUGH' : 'WIPEOUT';

  const el = h(
    'div',
    { class: 'screen' },
    topbar(app, 'RESULTS'),
    h(
      'div',
      { class: 'screen-body center' },
      h(
        'div',
        { class: 'results' },
        h(
          'div',
          { class: 'panel' },
          h('div', { class: 'dim' }, `${pkg.meta.title} — ${pkg.meta.artist} · ${difficulty.toUpperCase()}${mode === 'practice' ? ` · PRACTICE ${Math.round(rate * 100)}%` : ''}`),
          h('h2', { class: 'display', style: { marginTop: '6px' } }, verdict),
          h('div', { class: 'big-score' }, fmtScore(summary.score)),
          h('div', { class: 'stars-big' }, starString(summary.stars)),
          summary.fullCombo ? h('div', { style: { marginTop: '10px' } }, h('span', { class: 'fc-badge' }, 'FULL COMBO')) : null,
          rankInfo?.isNewBest ? h('div', { style: { marginTop: '10px' } }, h('span', { class: 'pill accent' }, 'NEW PERSONAL BEST')) : null,
          !saved ? h('div', { style: { marginTop: '10px' } }, h('span', { class: 'pill warn' }, 'PRACTICE — SCORE NOT SAVED')) : null,
          h('div', { class: 'grid-3', style: { marginTop: '20px' } },
            h('div', { class: 'stat' }, h('div', { class: 'v' }, pct(summary.accuracy)), h('div', { class: 'k' }, 'Accuracy')),
            h('div', { class: 'stat' }, h('div', { class: 'v' }, String(summary.maxCombo)), h('div', { class: 'k' }, 'Max combo')),
            h('div', { class: 'stat' }, h('div', { class: 'v' }, `${summary.totalNotes - summary.hits.miss}/${summary.totalNotes}`), h('div', { class: 'k' }, 'Notes hit')),
          ),
          h('div', { class: 'judge-bars' },
            bar('PERFECT', summary.hits.perfect, 'var(--perfect)'),
            bar('GREAT', summary.hits.great, 'var(--great)'),
            bar('GOOD', summary.hits.good, 'var(--good)'),
            bar('MISS', summary.hits.miss, 'var(--miss)'),
          ),
          h('div', { class: 'btn-row', style: { marginTop: '24px' } },
            button('PLAY AGAIN', () => app.navigate('game', { pkg, difficulty, mode }), 'primary'),
            button('SONG LIST', () => app.navigate(mode === 'practice' ? 'songs-practice' : 'songs')),
            button('TITLE', () => app.navigate('title'), 'ghost'),
          ),
        ),
        h(
          'div',
          { class: 'panel' },
          h('h3', { style: { marginTop: 0 } }, `Leaderboard · ${difficulty}`),
          h('table', { class: 'leaderboard' },
            h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Player'), h('th', null, 'Score'), h('th', null, 'Acc'), h('th', null, 'Combo'), h('th', null, 'Date'))),
            h('tbody', null, top.length ? top.map((s, i) => h('tr', { class: rankInfo && i === rankInfo.rank - 1 && s.date === entry.date ? 'you' : '' }, h('td', null, String(i + 1)), h('td', null, s.player), h('td', null, fmtScore(s.score)), h('td', null, pct(s.accuracy)), h('td', null, `${s.maxCombo}${s.fullCombo ? ' FC' : ''}`), h('td', null, new Date(s.date).toLocaleDateString()))) : h('tr', null, h('td', { colSpan: 6, class: 'mute' }, 'No saved scores yet.'))),
          ),
        ),
      ),
    ),
  );
  return { el };
}
