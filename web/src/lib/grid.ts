// The snap-grid layout: the desk above the taskbar is a 12 × 10 grid with
// 10px gaps, and each window owns a rect of whole cells, [x, y, w, h], at
// least 3 × 3. Showing windows never overlap. Pure: no DOM, so every rule is
// unit-tested. Stored per device in `pht:grid`.
//
// A minimized window keeps its rect but frees its cells; restoring it puts it
// back there if the cells are still free (see `restoreRect`).

import { WINDOWS, type WindowName } from './layout';

export const COLS = 12;
export const ROWS = 10;
export const GAP = 10;
export const MIN_W = 3;
export const MIN_H = 3;

export type Rect = [number, number, number, number];
export type Rects = Record<WindowName, Rect>;

export interface GridLayout {
  rects: Rects;
  minimized: WindowName[];
}

// The prototype's rects, with AI Wire taking part of Weather's space (the
// right-hand column under Weather, part of the bottom strip) and Learned
// under Today, beside the SIDE B it collects (in the strip for the last two).
export const PRESETS = {
  thirds: { today: [0, 0, 4, 7], learned: [0, 7, 4, 3], history: [4, 0, 4, 10], weather: [8, 0, 4, 5], wire: [8, 5, 4, 5] },
  wide: { today: [0, 0, 3, 7], learned: [0, 7, 3, 3], history: [3, 0, 6, 10], weather: [9, 0, 3, 5], wire: [9, 5, 3, 5] },
  stack: { today: [0, 0, 4, 7], history: [4, 0, 8, 7], weather: [0, 7, 4, 3], wire: [4, 7, 4, 3], learned: [8, 7, 4, 3] },
  quad: { today: [0, 0, 5, 6], history: [5, 0, 7, 6], weather: [0, 6, 4, 4], wire: [4, 6, 4, 4], learned: [8, 6, 4, 4] },
} satisfies Record<string, Rects>;
export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];
export const PRESET_LABELS: Record<PresetName, string> = {
  thirds: 'Three columns',
  wide: 'History wide',
  stack: 'Today + History with Weather strip',
  quad: 'Corners',
};

const copyRects = (r: Rects): Rects =>
  Object.fromEntries(WINDOWS.map((n) => [n, [...r[n]] as Rect])) as Rects;

// A preset with every window showing.
export function presetLayout(p: PresetName): GridLayout {
  return { rects: copyRects(PRESETS[p]), minimized: [] };
}
export const defaultLayout = () => presetLayout('thirds');

export function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}
export const area = (r: Rect) => r[2] * r[3];
const fits = (r: Rect) =>
  r.every((v) => Number.isInteger(v)) && r[0] >= 0 && r[1] >= 0 && r[2] >= MIN_W && r[3] >= MIN_H && r[0] + r[2] <= COLS && r[1] + r[3] <= ROWS;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const same = (a: Rect, b: Rect) => a.every((v, i) => v === b[i]);
export const fmt = (r: Rect | null) => (r ? `[${r.join(',')}]` : 'none');

export const isShowing = (l: GridLayout, n: WindowName) => !l.minimized.includes(n);
export const showing = (l: GridLayout) => WINDOWS.filter((n) => isShowing(l, n));
// The showing windows other than `id` whose cells `r` would take.
export const hits = (l: GridLayout, id: WindowName, r: Rect) => showing(l).filter((n) => n !== id && overlaps(r, l.rects[n]));
const freeFor = (l: GridLayout, id: WindowName, r: Rect) => fits(r) && hits(l, id, r).length === 0;

// Every rect in the grid at least 3 × 3, every showing window clear of the others.
export function isGridLayout(v: unknown): v is GridLayout {
  if (!v || typeof v !== 'object') return false;
  const { rects, minimized } = v as GridLayout;
  if (!rects || typeof rects !== 'object' || !Array.isArray(minimized)) return false;
  if (!minimized.every((n) => (WINDOWS as readonly unknown[]).includes(n))) return false;
  for (const n of WINDOWS) {
    const r = rects[n];
    if (!Array.isArray(r) || r.length !== 4 || !fits(r as Rect)) return false;
  }
  const l = v as GridLayout;
  return showing(l).every((n) => hits(l, n, l.rects[n]).length === 0);
}

// A stored layout from before a window existed (the three-window grid,
// before AI Wire): the windows it has keep their rects and state, and each
// missing one goes to the largest free rect; with no room, it is the default
// preset. Anything else that is not a layout is null.
export function upgradeLayout(v: unknown): GridLayout | null {
  if (isGridLayout(v)) return v;
  if (!v || typeof v !== 'object') return null;
  const { rects, minimized } = v as { rects?: Record<string, unknown>; minimized?: unknown };
  if (!rects || typeof rects !== 'object' || !Array.isArray(minimized)) return null;
  const missing = WINDOWS.filter((n) => !(n in rects));
  if (!missing.length || missing.length === WINDOWS.length) return null;
  // Every missing window starts minimized, so the check below is over the rest.
  const base = { rects: { ...rects }, minimized: [...minimized, ...missing] } as GridLayout;
  for (const n of missing) base.rects[n] = [...PRESETS.thirds[n]];
  if (!isGridLayout(base)) return null;
  let l = base;
  for (const n of missing) {
    const r = largestFree(l, n);
    if (!r) return defaultLayout();
    l = { rects: { ...l.rects, [n]: r }, minimized: l.minimized.filter((m) => m !== n) };
  }
  return l;
}

// ── pointer drags ──────────────────────────────────────────────────────────

// What a drag does: move the window (title bar) or move one or two of its
// edges (n, s, e, w, ne, nw, se, sw).
export type Mode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const MODES: readonly Mode[] = ['move', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export interface Cell {
  cw: number;
  ch: number;
}
export interface PxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// The size of one cell for a desk of `width` × `height` px.
export function cellOf(width: number, height: number): Cell {
  return { cw: (width - GAP) / COLS, ch: (height - GAP) / ROWS };
}
export function toPx([x, y, w, h]: Rect, { cw, ch }: Cell): PxRect {
  return { left: GAP + x * cw, top: GAP + y * ch, width: w * cw - GAP, height: h * ch - GAP };
}

// The grid rect nearest to where the window is on screen (`px`, relative to
// the desk) during a drag from `cur`. A move keeps it inside the grid; a
// resize keeps every edge it is not moving where it was.
export function snap(mode: Mode, cur: Rect, px: PxRect, { cw, ch }: Cell): Rect {
  let gx = Math.round((px.left - GAP) / cw);
  let gy = Math.round((px.top - GAP) / ch);
  let gw = clamp(Math.round((px.width + GAP) / cw), MIN_W, COLS);
  let gh = clamp(Math.round((px.height + GAP) / ch), MIN_H, ROWS);
  if (mode === 'move') return [clamp(gx, 0, COLS - gw), clamp(gy, 0, ROWS - gh), gw, gh];
  if (mode.includes('w')) {
    const right = cur[0] + cur[2];
    gx = clamp(gx, 0, right - MIN_W);
    gw = right - gx;
  } else gx = cur[0];
  if (mode.includes('n')) {
    const bottom = cur[1] + cur[3];
    gy = clamp(gy, 0, bottom - MIN_H);
    gh = bottom - gy;
  } else gy = cur[1];
  return [gx, gy, clamp(gw, MIN_W, COLS - gx), clamp(gh, MIN_H, ROWS - gy)];
}

export type Landing =
  | { kind: 'free'; rect: Rect }
  | { kind: 'swap'; with: WindowName; rect: Rect }
  // The spot is taken and the pointer is not over a window: release reverts.
  | { kind: 'bad'; rect: Rect; by: WindowName[] };

// Where a moved window lands for the snapped rect `target`. If it would take
// another window's cells and the pointer is over one of those windows, the
// two swap; taken cells with the pointer elsewhere are a bad drop.
export function moveLanding(l: GridLayout, id: WindowName, target: Rect, pointerOver: (n: WindowName) => boolean): Landing {
  const by = hits(l, id, target);
  if (!by.length) return { kind: 'free', rect: target };
  const under = by.find(pointerOver);
  if (under) return { kind: 'swap', with: under, rect: [...l.rects[under]] };
  return { kind: 'bad', rect: target, by };
}

// A resize never overlaps: pull the moving edges back toward where they
// started until the rect is clear. `clampedBy` names what stopped it.
export function resizeLanding(l: GridLayout, id: WindowName, mode: Mode, target: Rect): { rect: Rect; clampedBy: WindowName[] } {
  const o = l.rects[id];
  const t: Rect = [...target];
  const clampedBy = hits(l, id, t);
  for (let i = 0; i < COLS + ROWS && hits(l, id, t).length; i += 1) {
    if (mode.includes('e') && t[2] > o[2]) t[2] -= 1;
    if (mode.includes('s') && t[3] > o[3]) t[3] -= 1;
    if (mode.includes('w') && t[0] < o[0]) {
      t[0] += 1;
      t[2] -= 1;
    }
    if (mode.includes('n') && t[1] < o[1]) {
      t[1] += 1;
      t[3] -= 1;
    }
  }
  // Already as small as it started and still clear of nothing: stay put.
  return hits(l, id, t).length ? { rect: [...o], clampedBy } : { rect: t, clampedBy };
}

export function withRect(l: GridLayout, id: WindowName, r: Rect): GridLayout {
  const rects = copyRects(l.rects);
  rects[id] = [...r];
  return { rects, minimized: [...l.minimized] };
}

export function swap(l: GridLayout, a: WindowName, b: WindowName): GridLayout {
  const rects = copyRects(l.rects);
  rects[a] = [...l.rects[b]];
  rects[b] = [...l.rects[a]];
  return { rects, minimized: [...l.minimized] };
}

// Double-click a title bar (or Enter on it): grow up while the row above is
// free, then down while the row below is.
export function fillVertical(l: GridLayout, id: WindowName): Rect {
  const g: Rect = [...l.rects[id]];
  const clash = (t: Rect) => hits(l, id, t).length > 0;
  while (g[1] > 0 && !clash([g[0], g[1] - 1, g[2], g[3] + 1])) {
    g[1] -= 1;
    g[3] += 1;
  }
  while (g[1] + g[3] < ROWS && !clash([g[0], g[1], g[2], g[3] + 1])) g[3] += 1;
  return g;
}

// ── keyboard ───────────────────────────────────────────────────────────────

export type Dir = 'left' | 'right' | 'up' | 'down';
const STEP: Record<Dir, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

// Alt+arrow: one cell that way. Bumping into a window swaps with it (the one
// it would cover most); the edge of the grid stops it.
export function nudge(l: GridLayout, id: WindowName, dir: Dir): { layout: GridLayout; did: 'moved' | 'swapped' | 'blocked'; with?: WindowName } {
  const r = l.rects[id];
  const [dx, dy] = STEP[dir];
  const t: Rect = [r[0] + dx, r[1] + dy, r[2], r[3]];
  if (!fits(t)) return { layout: l, did: 'blocked' };
  const by = hits(l, id, t);
  if (!by.length) return { layout: withRect(l, id, t), did: 'moved' };
  const cover = (n: WindowName) => {
    const o = l.rects[n];
    const w = Math.min(t[0] + t[2], o[0] + o[2]) - Math.max(t[0], o[0]);
    const h = Math.min(t[1] + t[3], o[1] + o[3]) - Math.max(t[1], o[1]);
    return w * h;
  };
  const other = by.reduce((best, n) => (cover(n) > cover(best) ? n : best));
  return { layout: swap(l, id, other), did: 'swapped', with: other };
}

// Alt+Shift+arrow: Right and Down move the right or bottom edge out one cell,
// Left and Up move it in; never past the grid, a neighbor or the minimum.
export function resizeStep(l: GridLayout, id: WindowName, dir: Dir): GridLayout | null {
  const r = l.rects[id];
  const t: Rect = [...r];
  if (dir === 'right') t[2] += 1;
  else if (dir === 'left') t[2] -= 1;
  else if (dir === 'down') t[3] += 1;
  else t[3] -= 1;
  return freeFor(l, id, t) ? withRect(l, id, t) : null;
}

// ── minimize and restore ───────────────────────────────────────────────────

export function minimize(l: GridLayout, id: WindowName): GridLayout {
  if (!isShowing(l, id)) return l;
  return { rects: copyRects(l.rects), minimized: [...l.minimized, id] };
}

// Every free rect of size w × h, top-left to bottom-right (row by row).
function firstFree(l: GridLayout, id: WindowName, w: number, h: number): Rect | null {
  for (let y = 0; y + h <= ROWS; y += 1) {
    for (let x = 0; x + w <= COLS; x += 1) {
      const t: Rect = [x, y, w, h];
      if (freeFor(l, id, t)) return t;
    }
  }
  return null;
}

// The largest free rect at least 3 × 3 (the first found, scanning top-left
// to bottom-right, among equals).
export function largestFree(l: GridLayout, id: WindowName): Rect | null {
  let best: Rect | null = null;
  for (let y = 0; y + MIN_H <= ROWS; y += 1) {
    for (let x = 0; x + MIN_W <= COLS; x += 1) {
      for (let w = MIN_W; x + w <= COLS; w += 1) {
        for (let h = MIN_H; y + h <= ROWS; h += 1) {
          const t: Rect = [x, y, w, h];
          if (freeFor(l, id, t) && (!best || area(t) > area(best))) best = t;
        }
      }
    }
  }
  return best;
}

export type RestorePath = 'saved' | 'same-size' | 'largest' | 'reset';

// Restore a minimized window: 1. its saved rect if that is free; 2. else the
// first free spot of the same size; 3. else the largest free rect ≥ 3 × 3;
// 4. else Three columns (any other minimized window stays minimized).
export function restoreRect(l: GridLayout, id: WindowName): { layout: GridLayout; path: RestorePath } {
  const minimized = l.minimized.filter((n) => n !== id);
  const open: GridLayout = { rects: copyRects(l.rects), minimized };
  const saved = l.rects[id];
  if (freeFor(open, id, saved)) return { layout: open, path: 'saved' };
  const same = firstFree(open, id, saved[2], saved[3]);
  if (same) return { layout: withRect(open, id, same), path: 'same-size' };
  const big = largestFree(open, id);
  if (big) return { layout: withRect(open, id, big), path: 'largest' };
  return { layout: { rects: copyRects(PRESETS.thirds), minimized }, path: 'reset' };
}
