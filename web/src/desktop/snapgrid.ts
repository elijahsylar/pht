import { h } from '../lib/dom';
import { trace } from '../lib/dragTrace';
import {
  cellOf,
  COLS,
  defaultLayout,
  fillVertical,
  fmt,
  upgradeLayout,
  isShowing,
  minimize,
  moveLanding,
  nudge,
  presetLayout,
  resizeLanding,
  resizeStep,
  restoreRect,
  ROWS,
  same,
  snap,
  swap,
  toPx,
  withRect,
  type Dir,
  type GridLayout,
  type Landing,
  type Mode,
  type PresetName,
  type PxRect,
  type Rect,
} from '../lib/grid';
import { WINDOWS, type WindowName } from '../lib/layout';
import { OLD_LAYOUT_KEYS, PREF, readPref, removePref, writePref } from '../lib/prefs';

// The snap-grid desk on screen (the model is `src/lib/grid.ts`): each window
// sits on a 12 × 10 grid of cells. Drag a title bar and the window follows
// the pointer while a dotted outline shows where it will land: a free spot,
// a swap (green, the pointer over another window) or a bad drop (red: the
// spot is taken, release puts it back). Drag any edge or corner to resize;
// sizes snap to cells and stop at neighbors. The dashed grid shows only
// while dragging. Double-click a title bar (or Enter on it) to fill the free
// space above and below. With a title bar focused, Alt+arrows move one cell
// (swapping on a bump) and Alt+Shift+arrows resize. With ?debug=drag each step
// is traced to the "Drag log".
//
// Firefox under a real mouse: title bars and handles cancel mousedown and
// dragstart, selectstart is cancelled during a drag, move/up are followed on
// the document, and the drag ends on pointercancel, window blur, and a mouse
// move with no button down (released where no pointerup reached the page).

const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
// The smallest a window may look while it follows the pointer.
const LIVE_MIN_W = 120;
const LIVE_MIN_H = 80;

export interface SnapWin {
  name: WindowName;
  root: HTMLElement;
  titleBar: HTMLElement;
  task: HTMLButtonElement;
}

export interface SnapDesk {
  // Build the desk for the current mode (phone: stacked, no grid).
  arrange(): void;
  // Put every window on its cells again (the desk changed size).
  place(): void;
  isMinimized(name: WindowName): boolean;
  setMinimized(name: WindowName, on: boolean): void;
  applyPreset(p: PresetName): void;
  // The current layout, for the drag log.
  layoutJson(): string;
  // A window's rect in cells.
  rectOf(name: WindowName): Rect;
  destroy(): void;
}

function storedLayout(): GridLayout {
  // The docking layout's keys are not carried over: the first load is Three columns.
  for (const k of OLD_LAYOUT_KEYS) removePref(k);
  // A layout saved before AI Wire existed keeps its windows and makes room
  // for the new one (upgradeLayout).
  const any = (_v: unknown): _v is unknown => true;
  return upgradeLayout(readPref<unknown>(PREF.grid, any, null)) ?? defaultLayout();
}

export function createSnapDesk(opts: {
  root: HTMLElement;
  desk: HTMLElement;
  wins: SnapWin[];
  titles: Record<WindowName, string>;
  isPhone(): boolean;
  // Read out through the live region.
  announce(text: string): void;
}): SnapDesk {
  const { root, desk, wins, titles, isPhone, announce } = opts;
  const winOf = (n: WindowName) => wins.find((w) => w.name === n)!;
  let layout = storedLayout();
  const save = () => writePref(PREF.grid, layout);

  const lines = h('div', { className: 'snap-lines', attrs: { 'aria-hidden': 'true' } });
  const ghostMsg = h('span', { className: 'snap-ghost-msg' });
  const ghost = h('div', { className: 'snap-ghost', hidden: true, attrs: { 'aria-hidden': 'true' } }, ghostMsg);

  // ── geometry ─────────────────────────────────────────────────────────────
  const cell = () => {
    const r = desk.getBoundingClientRect();
    return cellOf(r.width, r.height);
  };
  function setBox(el: HTMLElement, p: PxRect) {
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;
    el.style.width = `${p.width}px`;
    el.style.height = `${p.height}px`;
  }
  function place() {
    if (isPhone()) return;
    const c = cell();
    for (const w of wins) {
      setBox(w.root, toPx(layout.rects[w.name], c));
      w.root.dataset.rect = layout.rects[w.name].join(',');
    }
  }
  function drawLines() {
    const c = cell();
    const cells: HTMLElement[] = [];
    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const d = h('div', { className: 'snap-cell' });
        setBox(d, toPx([x, y, 1, 1], c));
        cells.push(d);
      }
    }
    lines.replaceChildren(...cells);
  }
  // Is the pointer over `n`'s cells (its rect on screen, not its element,
  // which may be the one being dragged)?
  function pointerOver(n: WindowName, cx: number, cy: number) {
    const d = desk.getBoundingClientRect();
    const p = toPx(layout.rects[n], cell());
    const x = cx - d.left;
    const y = cy - d.top;
    return x >= p.left && x <= p.left + p.width && y >= p.top && y <= p.top + p.height;
  }

  // ── pointer drags ────────────────────────────────────────────────────────
  interface Op {
    name: WindowName;
    el: HTMLElement;
    mode: Mode;
    id: number;
    x0: number;
    y0: number;
    start: PxRect;
    // Move: where it would land now (null until the pointer moves).
    landing: Landing | null;
    // Resize: the clamped rect.
    rect: Rect | null;
    seen: string;
  }
  let op: Op | null = null;

  function showGhost(r: Rect, kind: 'free' | 'swap' | 'bad') {
    setBox(ghost, toPx(r, cell()));
    ghost.hidden = false;
    ghost.classList.toggle('swap', kind === 'swap');
    ghost.classList.toggle('bad', kind === 'bad');
    ghost.dataset.kind = kind;
    ghostMsg.textContent = kind === 'swap' ? 'Release to swap' : kind === 'bad' ? 'Spot taken: drop on a window to swap, or shrink one first' : '';
  }

  function onDown(e: PointerEvent) {
    if (e.button !== 0 || isPhone()) return;
    const t = e.target as Element;
    const w = wins.find((x) => x.root.contains(t));
    if (!w || !isShowing(layout, w.name)) return;
    const handle = t.closest<HTMLElement>('.rh');
    const onBar = !handle && !!t.closest('.title-bar') && !t.closest('button');
    if (!handle && !onBar) return;
    e.preventDefault();
    if (op) end('a new drag started');
    const r = w.root.getBoundingClientRect();
    const d = desk.getBoundingClientRect();
    const mode = (handle ? handle.dataset.dir : 'move') as Mode;
    op = {
      name: w.name,
      el: w.root,
      mode,
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      start: { left: r.left - d.left, top: r.top - d.top, width: r.width, height: r.height },
      landing: null,
      rect: null,
      seen: '',
    };
    trace(`${mode === 'move' ? 'move' : `resize ${mode}`} ${w.name} start at ${Math.round(e.clientX)},${Math.round(e.clientY)} (pointer ${e.pointerId} ${e.pointerType}), rect ${fmt(layout.rects[w.name])}`);
    w.root.classList.add('live');
    root.classList.add('snapping');
    drawLines();
    showGhost(layout.rects[w.name], 'free');
    window.getSelection()?.removeAllRanges();
  }

  function onMove(e: PointerEvent) {
    if (!op || e.pointerId !== op.id) return;
    // The button came up where no pointerup reached us (outside the window).
    if (e.pointerType === 'mouse' && e.buttons === 0) return end('pointermove with no button down');
    const dx = e.clientX - op.x0;
    const dy = e.clientY - op.y0;
    let { left, top, width, height } = op.start;
    if (op.mode === 'move') {
      left += dx;
      top += dy;
    } else {
      if (op.mode.includes('e')) width += dx;
      if (op.mode.includes('s')) height += dy;
      if (op.mode.includes('w')) {
        left += dx;
        width -= dx;
      }
      if (op.mode.includes('n')) {
        top += dy;
        height -= dy;
      }
    }
    setBox(op.el, { left, top, width: Math.max(width, LIVE_MIN_W), height: Math.max(height, LIVE_MIN_H) });
    const cur = layout.rects[op.name];
    const target = snap(op.mode, cur, { left, top, width, height }, cell());
    let line: string;
    if (op.mode === 'move') {
      const l = moveLanding(layout, op.name, target, (n) => pointerOver(n, e.clientX, e.clientY));
      op.landing = l;
      showGhost(l.rect, l.kind);
      line =
        l.kind === 'free'
          ? `landing ${fmt(l.rect)} free`
          : l.kind === 'swap'
            ? `landing ${fmt(l.rect)}: swap with ${l.with}`
            : `landing ${fmt(l.rect)}: bad drop, taken by ${l.by.join(' and ')}`;
    } else {
      const { rect, clampedBy } = resizeLanding(layout, op.name, op.mode, target);
      op.rect = rect;
      showGhost(rect, 'free');
      line = `rect ${fmt(rect)}${clampedBy.length ? ` (wanted ${fmt(target)}, clamped by ${clampedBy.join(' and ')})` : ''}`;
    }
    if (line !== op.seen) {
      op.seen = line;
      trace(`${op.mode === 'move' ? 'move' : `resize ${op.mode}`} ${op.name}: ${line}`);
    }
  }

  // `why`: the event that ended it. `commit` false puts everything back.
  function end(why: string, commit = true) {
    if (!op) return;
    const { name, el, mode, landing, rect } = op;
    op = null;
    let result = 'no change';
    if (commit && mode === 'move' && landing) {
      if (landing.kind === 'swap') {
        layout = swap(layout, name, landing.with);
        result = `swapped with ${landing.with}`;
      } else if (landing.kind === 'free') {
        if (!same(landing.rect, layout.rects[name])) result = `moved to ${fmt(landing.rect)}`;
        layout = withRect(layout, name, landing.rect);
      } else result = 'bad drop: reverted';
    } else if (commit && rect) {
      if (!same(rect, layout.rects[name])) result = `resized to ${fmt(rect)}`;
      layout = withRect(layout, name, rect);
    } else if (!commit) result = 'cancelled: reverted';
    trace(`${mode === 'move' ? 'move' : `resize ${mode}`} ${name} end: ${why}, ${result}`);
    el.classList.remove('live');
    root.classList.remove('snapping');
    ghost.hidden = true;
    ghost.classList.remove('swap', 'bad');
    place();
    save();
  }

  const onUp = (e: PointerEvent) => {
    if (op && e.pointerId === op.id) end(e.type);
  };
  const onBlur = () => end('window blur');
  const onSelect = (e: Event) => {
    if (op) e.preventDefault();
  };
  const onKey = (e: KeyboardEvent) => {
    if (op && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      end('Escape', false);
    }
  };
  const noDrag = (e: Event) => e.preventDefault();
  desk.addEventListener('pointerdown', onDown);
  desk.addEventListener('dragstart', noDrag);
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  document.addEventListener('selectstart', onSelect);
  window.addEventListener('blur', onBlur);
  window.addEventListener('keydown', onKey, true);

  // ── handles, title bars, keyboard ────────────────────────────────────────
  function setLayout(next: GridLayout) {
    layout = next;
    save();
    place();
  }
  const sizeWords = (r: Rect) => `${r[2]} by ${r[3]} cells`;
  function fill(name: WindowName, how: string) {
    const r = fillVertical(layout, name);
    trace(`${how} on ${name}: fill ${fmt(layout.rects[name])} → ${fmt(r)}`);
    const grew = !same(r, layout.rects[name]);
    setLayout(withRect(layout, name, r));
    announce(grew ? `${titles[name]} fills the free space above and below: ${sizeWords(r)}.` : `${titles[name]} has no free space above or below.`);
  }

  for (const w of wins) {
    for (const dir of DIRS) {
      const el = h('div', {
        className: `rh rh-${dir}${dir === 'se' ? ' win-sizegrip' : ''}`,
        dataset: { dir, role: `resize-${dir}` },
        attrs: { 'aria-hidden': 'true' },
      });
      el.addEventListener('mousedown', (e) => e.preventDefault());
      w.root.append(el);
    }
    const bar = w.titleBar;
    bar.tabIndex = 0;
    bar.dataset.role = 'title-bar';
    bar.title = 'Drag to move, onto another window to swap. Double-click to fill the height.';
    // A focusable group, so its label and role description are valid ARIA.
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-roledescription', 'title bar');
    bar.setAttribute('aria-label', `${titles[w.name]} window. Alt and arrow keys move it, Alt Shift and arrow keys resize it, Enter fills the height`);
    bar.addEventListener('mousedown', (e) => {
      if (!(e.target as Element).closest('button')) e.preventDefault();
    });
    bar.addEventListener('dblclick', (e) => {
      if (isPhone() || (e.target as Element).closest('button')) return;
      fill(w.name, 'double-click');
    });
    bar.addEventListener('keydown', (e) => {
      if (e.target !== bar || isPhone()) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        fill(w.name, 'Enter');
        return;
      }
      const dir = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as Record<string, Dir>)[e.key];
      if (!e.altKey || !dir) return;
      e.preventDefault();
      e.stopPropagation();
      const name = w.name;
      if (e.shiftKey) {
        const next = resizeStep(layout, name, dir);
        trace(`Alt+Shift+${e.key} on ${name}: ${next ? `resized to ${fmt(next.rects[name])}` : 'clamped, no change'}`);
        if (next) {
          setLayout(next);
          announce(`${titles[name]} is ${sizeWords(next.rects[name])}.`);
        } else announce(`${titles[name]} can't be resized that way: ${sizeWords(layout.rects[name])}.`);
        return;
      }
      const r = nudge(layout, name, dir);
      trace(`Alt+${e.key} on ${name}: ${r.did}${r.with ? ` with ${r.with}` : ''} ${fmt(r.layout.rects[name])}`);
      if (r.did === 'blocked') return announce(`${titles[name]} can't move ${dir}.`);
      setLayout(r.layout);
      const at = r.layout.rects[name];
      announce(
        r.did === 'swapped'
          ? `${titles[name]} swapped places with ${titles[r.with!]}.`
          : `${titles[name]} moved to column ${at[0] + 1}, row ${at[1] + 1}.`,
      );
      bar.focus({ preventScroll: true });
    });
  }

  // ── building the desk ────────────────────────────────────────────────────
  function arrange() {
    if (op) end('the desk was rebuilt', false);
    if (isPhone()) {
      // Stacked in a fixed order; nothing is minimized or movable.
      for (const w of wins) {
        w.root.classList.remove('minimized');
        for (const p of ['left', 'top', 'width', 'height'] as const) w.root.style[p] = '';
        w.task.setAttribute('aria-pressed', 'true');
      }
      desk.replaceChildren(...WINDOWS.map((n) => winOf(n).root));
      root.classList.remove('all-minimized');
      return;
    }
    for (const w of wins) {
      const away = !isShowing(layout, w.name);
      w.root.classList.toggle('minimized', away);
      w.task.setAttribute('aria-pressed', String(!away));
      w.task.title = away ? `Restore ${titles[w.name]}` : `Minimize ${titles[w.name]}`;
    }
    desk.replaceChildren(lines, ...WINDOWS.map((n) => winOf(n).root), ghost);
    root.classList.toggle('all-minimized', layout.minimized.length === WINDOWS.length);
    place();
  }

  function setMinimized(name: WindowName, on: boolean) {
    if (isPhone() || on === !isShowing(layout, name)) return;
    const w = winOf(name);
    const hadFocus = w.root.contains(document.activeElement);
    if (on) {
      layout = minimize(layout, name);
      trace(`minimize ${name}: frees ${fmt(layout.rects[name])}`);
    } else {
      const r = restoreRect(layout, name);
      layout = r.layout;
      trace(`restore ${name}: ${r.path} → ${fmt(layout.rects[name])}`);
    }
    save();
    arrange();
    if (on && hadFocus) w.task.focus();
  }

  function onResize() {
    place();
  }
  window.addEventListener('resize', onResize);

  return {
    arrange,
    place,
    isMinimized: (n) => !isPhone() && !isShowing(layout, n),
    setMinimized,
    applyPreset(p) {
      layout = presetLayout(p);
      trace(`preset ${p}`);
      save();
      arrange();
    },
    layoutJson: () => JSON.stringify(layout),
    rectOf: (n) => [...layout.rects[n]] as Rect,
    destroy() {
      if (op) end('the desktop closed', false);
      desk.removeEventListener('pointerdown', onDown);
      desk.removeEventListener('dragstart', noDrag);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('selectstart', onSelect);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    },
  };
}
