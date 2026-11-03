import { h, nextId } from '../lib/dom';

// Floating 98 windows above the grid: Info, Setup, Retired habits, Display
// Properties and the keyboard help. Never a grid slot.
//
// Each opens centred, can be dragged by its title bar (pointer events, kept
// inside the viewport above the taskbar), comes to the front when touched,
// and closes with × or Esc, giving focus back to whatever opened it. Below
// 900px they are full-width sheets and do not drag (style.css).

export interface FloatWindow {
  root: HTMLElement;
  body: HTMLDivElement;
  setTitle(text: string): void;
  close(): void;
  isOpen(): boolean;
}

interface FloatOptions {
  // One window per key: opening it again brings the open one forward.
  key: string;
  title: string;
  className?: string;
  opener?: HTMLElement | null;
  // Runs once, after the window is removed (× / Esc / close()).
  onClose?: () => void;
  isPhone: () => boolean;
  // Where it opens: centred (default), or tucked into the bottom-right corner
  // without taking focus (the drag log, which must not get in the way).
  at?: 'center' | 'corner';
}

const TASKBAR_H = 40;
const open = new Map<string, FloatWindow & { z: number; opener: HTMLElement | null }>();
let zTop = 20;

export function floatOpen(key: string): FloatWindow | null {
  return open.get(key) ?? null;
}

// The front-most floating window, for Esc.
export function topFloat(): FloatWindow | null {
  let best: (FloatWindow & { z: number }) | null = null;
  for (const w of open.values()) if (!best || w.z > best.z) best = w;
  return best;
}

export function closeAllFloats(): void {
  for (const w of [...open.values()]) w.close();
}

export function openFloat(opts: FloatOptions): FloatWindow {
  const existing = open.get(opts.key);
  if (existing) {
    raise(existing);
    existing.root.focus();
    return existing;
  }

  const titleId = nextId('float-title');
  const titleText = h('div', { className: 'title-bar-text', id: titleId, text: opts.title });
  const closeBtn = h('button', { type: 'button', attrs: { 'aria-label': 'Close' } });
  const bar = h('div', { className: 'title-bar' }, titleText, h('div', { className: 'title-bar-controls' }, closeBtn));
  const body = h('div', { className: 'window-body float-body' });
  const root = h(
    'section',
    {
      className: `window float ${opts.className ?? ''}`.trim(),
      tabIndex: -1,
      dataset: { float: opts.key },
      attrs: { role: 'dialog', 'aria-labelledby': titleId, 'aria-modal': 'false' },
    },
    bar,
    body,
  );

  let closed = false;
  const win: FloatWindow & { z: number; opener: HTMLElement | null } = {
    root,
    body,
    z: 0,
    opener: opts.opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
    setTitle(text) {
      titleText.textContent = text;
    },
    isOpen: () => !closed,
    close() {
      if (closed) return;
      closed = true;
      open.delete(opts.key);
      window.removeEventListener('resize', onResize);
      root.remove();
      const back = win.opener;
      if (back && back.isConnected) back.focus();
      opts.onClose?.();
    },
  };

  closeBtn.addEventListener('click', () => win.close());
  root.addEventListener('pointerdown', () => raise(win), true);

  // ── drag by the title bar ───────────────────────────────────────────────
  let drag: { dx: number; dy: number; id: number } | null = null;
  bar.addEventListener('pointerdown', (e) => {
    if (opts.isPhone() || e.button !== 0 || (e.target as Element).closest('button')) return;
    const r = root.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    bar.setPointerCapture(e.pointerId);
    root.classList.add('dragging');
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    place(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    root.classList.remove('dragging');
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);

  // Inside the viewport, above the taskbar; a window taller than the space
  // keeps its title bar on screen.
  function place(x: number, y: number) {
    if (opts.isPhone()) {
      root.style.left = '';
      root.style.top = '';
      return;
    }
    const w = root.offsetWidth;
    const hgt = root.offsetHeight;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - TASKBAR_H - hgt);
    root.style.left = `${Math.round(Math.min(maxX, Math.max(0, x)))}px`;
    root.style.top = `${Math.round(Math.min(maxY, Math.max(0, y)))}px`;
  }
  const onResize = () => {
    const r = root.getBoundingClientRect();
    place(r.left, r.top);
  };
  window.addEventListener('resize', onResize);

  open.set(opts.key, win);
  document.body.append(root);
  raise(win);
  // Centred once its content is in: the caller fills `body` synchronously.
  queueMicrotask(() => {
    if (closed) return;
    if (opts.at === 'corner') {
      place(window.innerWidth - root.offsetWidth - 12, window.innerHeight - TASKBAR_H - root.offsetHeight - 12);
      return;
    }
    place((window.innerWidth - root.offsetWidth) / 2, (window.innerHeight - TASKBAR_H - root.offsetHeight) / 2);
    root.focus();
  });
  return win;
}

function raise(w: { root: HTMLElement; z: number }) {
  zTop += 1;
  w.z = zTop;
  w.root.style.zIndex = String(zTop);
  for (const o of open.values()) o.root.classList.toggle('active', o === w);
}

// Re-centre after the body changed size (content loaded after opening).
export function recenter(w: FloatWindow): void {
  const r = w.root;
  r.style.left = `${Math.max(0, Math.round((window.innerWidth - r.offsetWidth) / 2))}px`;
  r.style.top = `${Math.max(0, Math.round((window.innerHeight - TASKBAR_H - r.offsetHeight) / 2))}px`;
}
