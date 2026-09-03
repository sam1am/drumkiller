/** Tiny DOM helpers — no framework needed. */

type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v as Record<string, string>);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v as Record<string, string>);
      else if (k in el && k !== 'list' && k !== 'form') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function button(label: Child, onClick: (ev: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `btn ${cls}`.trim(), onClick }, label);
}

export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'small mute' }, hint) : null);
}

export function select(options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const sel = h('select', { class: 'input', onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value) });
  for (const o of options) sel.appendChild(h('option', { value: o.value, selected: o.value === value }, o.label));
  return sel;
}

let toastRoot: HTMLElement | null = null;
export function toast(message: string, kind: 'ok' | 'bad' | '' = '', ms = 2600): void {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts' });
    document.body.appendChild(toastRoot);
  }
  const el = h('div', { class: `toast ${kind}` }, message);
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function modal(content: HTMLElement, opts: { closeOnBackdrop?: boolean } = {}): { close: () => void } {
  const back = h('div', { class: 'modal-back' }, h('div', { class: 'panel modal' }, content));
  const close = () => back.remove();
  if (opts.closeOnBackdrop !== false) {
    back.addEventListener('click', (e) => {
      if (e.target === back) close();
    });
  }
  document.body.appendChild(back);
  return { close };
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec)) return '0:00';
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtScore(n: number): string {
  return n.toLocaleString('en-US');
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

export function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', style: { display: 'none' } });
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}
