import type { App } from '@/app';
import { h } from './dom';

export function topbar(app: App, title: string, ...right: (HTMLElement | null)[]): HTMLElement {
  return h(
    'div',
    { class: 'topbar' },
    h('a', { class: 'brand', onClick: () => app.navigate('title') }, 'DRUMKILLER'),
    h('h1', null, title),
    h('div', { class: 'spacer' }),
    ...right,
  );
}
