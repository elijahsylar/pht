import { describe, expect, it } from 'vitest';
import {
  cellOf,
  defaultLayout,
  fillVertical,
  hits,
  isGridLayout,
  largestFree,
  minimize,
  moveLanding,
  nudge,
  overlaps,
  PRESETS,
  PRESET_NAMES,
  presetLayout,
  resizeLanding,
  resizeStep,
  restoreRect,
  snap,
  swap,
  toPx,
  upgradeLayout,
  withRect,
  type GridLayout,
  type Rect,
} from './grid';

const cell = cellOf(1910, 1010); // 10px gap: 158.33 × 100 px cells
// Most cases below are about three windows in three columns, with AI Wire
// and Learned minimized out of the way (their rects are kept but take no cells).
const BASE = {
  today: [0, 0, 4, 10],
  history: [4, 0, 4, 10],
  learned: [0, 7, 4, 3],
  weather: [8, 0, 4, 10],
  wire: [8, 5, 4, 5],
} satisfies Record<string, Rect>;
const L = (rects: Partial<Record<'today' | 'history' | 'learned' | 'weather' | 'wire', Rect>>, minimized: GridLayout['minimized'] = []): GridLayout => ({
  rects: { ...BASE, ...rects },
  minimized: [...new Set(['wire' as const, 'learned' as const, ...minimized])],
});

describe('grid', () => {
  it('has the prototype presets with AI Wire and Learned in each, every one valid and filling the grid', () => {
    expect(defaultLayout().rects).toEqual({
      today: [0, 0, 4, 7],
      learned: [0, 7, 4, 3],
      history: [4, 0, 4, 10],
      weather: [8, 0, 4, 5],
      wire: [8, 5, 4, 5],
    });
    expect(PRESETS.wide).toEqual({ today: [0, 0, 3, 7], learned: [0, 7, 3, 3], history: [3, 0, 6, 10], weather: [9, 0, 3, 5], wire: [9, 5, 3, 5] });
    expect(PRESETS.stack).toEqual({ today: [0, 0, 4, 7], history: [4, 0, 8, 7], weather: [0, 7, 4, 3], wire: [4, 7, 4, 3], learned: [8, 7, 4, 3] });
    expect(PRESETS.quad).toEqual({ today: [0, 0, 5, 6], history: [5, 0, 7, 6], weather: [0, 6, 4, 4], wire: [4, 6, 4, 4], learned: [8, 6, 4, 4] });
    for (const p of PRESET_NAMES) {
      const l = presetLayout(p);
      expect(isGridLayout(l)).toBe(true);
      expect(l.minimized).toEqual([]);
      expect(Object.values(l.rects).reduce((n, r) => n + r[2] * r[3], 0)).toBe(120);
    }
  });

  it('upgrades a layout saved before Learned (or AI Wire) existed', () => {
    // The four-window default before Learned fills the grid: no room, so the new default.
    const four = {
      rects: { today: [0, 0, 4, 10], history: [4, 0, 4, 10], weather: [8, 0, 4, 5], wire: [8, 5, 4, 5] },
      minimized: [],
    };
    expect(isGridLayout(four)).toBe(false);
    expect(upgradeLayout(four)).toEqual(defaultLayout());
    // Room left: the old windows keep their rects, Learned takes the largest free rect.
    const roomy = {
      rects: { today: [0, 0, 4, 10], history: [4, 0, 4, 10], weather: [8, 0, 4, 4], wire: [8, 4, 4, 3] },
      minimized: [],
    };
    expect(upgradeLayout(roomy)).toEqual({ rects: { ...roomy.rects, learned: [8, 7, 4, 3] }, minimized: [] });
    // A minimized window stays minimized and frees its cells.
    const min = { rects: four.rects, minimized: ['wire'] };
    expect(upgradeLayout(min)).toEqual({ rects: { ...four.rects, learned: [8, 5, 4, 5] }, minimized: ['wire'] });
    // From before AI Wire too: each missing window in turn takes the largest
    // free rect; when one finds no room, the default.
    const three = { rects: { today: [0, 0, 4, 10], history: [4, 0, 4, 10], weather: [8, 0, 4, 4] }, minimized: [] };
    // Learned (first in WINDOWS) takes the one free rect; Wire then has none.
    expect(upgradeLayout(three)).toEqual(defaultLayout());
    const threeFull = { rects: { today: [0, 0, 4, 10], history: [4, 0, 4, 10], weather: [8, 0, 4, 10] }, minimized: [] };
    expect(upgradeLayout(threeFull)).toEqual(defaultLayout());
    // Current layouts pass through; junk and overlapping layouts do not.
    expect(upgradeLayout(defaultLayout())).toEqual(defaultLayout());
    expect(upgradeLayout({ rects: { today: [0, 0, 6, 10], history: [4, 0, 4, 10], weather: [8, 0, 4, 5] }, minimized: [] })).toBeNull();
    expect(upgradeLayout({ cols: [] })).toBeNull();
    expect(upgradeLayout(null)).toBeNull();
    expect(upgradeLayout({ rects: {}, minimized: [] })).toBeNull();
  });

  it('validates stored layouts: bounds, the 3 × 3 minimum, no overlap among showing windows', () => {
    expect(isGridLayout(L({}))).toBe(true);
    expect(isGridLayout(L({ today: [0, 0, 5, 10] }))).toBe(false); // overlaps History
    expect(isGridLayout(L({ today: [0, 0, 5, 10] }, ['history']))).toBe(true); // History is minimized
    expect(isGridLayout(L({ today: [0, 0, 2, 10] }))).toBe(false);
    expect(isGridLayout(L({ weather: [10, 0, 4, 10] }))).toBe(false);
    expect(isGridLayout(L({ today: [0, 0, 3.5, 10] }))).toBe(false);
    expect(isGridLayout({ cols: [] })).toBe(false);
    expect(isGridLayout(L({}, ['clock' as never]))).toBe(false);
  });

  it('maps cells to pixels and back', () => {
    const px = toPx([4, 0, 4, 10], cell);
    expect(px.left).toBeCloseTo(10 + 4 * cell.cw);
    expect(px.width).toBeCloseTo(4 * cell.cw - 10);
    expect(snap('move', [4, 0, 4, 10], px, cell)).toEqual([4, 0, 4, 10]);
    // A move keeps the window inside the grid.
    expect(snap('move', [4, 0, 4, 10], { ...px, left: 5000 }, cell)).toEqual([8, 0, 4, 10]);
    // A resize from the west keeps the east edge, never below 3 wide.
    expect(snap('w', [4, 0, 4, 10], { ...px, left: px.left + 3 * cell.cw, width: px.width - 3 * cell.cw }, cell)).toEqual([5, 0, 3, 10]);
    expect(snap('n', [0, 0, 4, 10], { left: 10, top: 10 + 2 * cell.ch, width: 4 * cell.cw - 10, height: 8 * cell.ch - 10 }, cell)).toEqual([0, 2, 4, 8]);
  });

  it('a move lands free, swaps when the pointer is over the window it would cover, else is a bad drop', () => {
    const l = L({ weather: [8, 0, 4, 5] }); // empty cells under Weather
    expect(moveLanding(l, 'today', [8, 5, 4, 5], () => false)).toEqual({ kind: 'free', rect: [8, 5, 4, 5] });
    expect(moveLanding(l, 'today', [4, 0, 4, 10], (n) => n === 'history')).toEqual({ kind: 'swap', with: 'history', rect: [4, 0, 4, 10] });
    expect(moveLanding(l, 'today', [6, 3, 4, 7], () => false)).toEqual({ kind: 'bad', rect: [6, 3, 4, 7], by: ['history', 'weather'] });
  });

  it('a resize stops at a neighbor and never overlaps', () => {
    const l = L({ today: [0, 0, 3, 10] });
    // East edge of Today pulled into History: stops at History's west edge.
    expect(resizeLanding(l, 'today', 'e', [0, 0, 6, 10])).toEqual({ rect: [0, 0, 4, 10], clampedBy: ['history'] });
    // Into free cells: no clamp.
    const m = L({ weather: [8, 0, 4, 5] });
    expect(resizeLanding(m, 'weather', 's', [8, 0, 4, 8])).toEqual({ rect: [8, 0, 4, 8], clampedBy: [] });
    // Corner: both edges pulled back.
    const n = L({ today: [0, 0, 3, 6] }, []);
    const r = resizeLanding({ ...n, rects: { ...n.rects, history: [4, 0, 4, 10], weather: [0, 7, 4, 3] } }, 'today', 'se', [0, 0, 6, 9]);
    expect(r.rect).toEqual([0, 0, 4, 7]);
  });

  it('swaps exchange rects', () => {
    const s = swap(L({}), 'today', 'weather');
    expect(s.rects.today).toEqual([8, 0, 4, 10]);
    expect(s.rects.weather).toEqual([0, 0, 4, 10]);
  });

  it('double-click fills up, then down, through free rows only', () => {
    const l = L({ today: [0, 3, 4, 3], weather: [8, 0, 4, 5] });
    expect(fillVertical(l, 'today')).toEqual([0, 0, 4, 10]);
    const m: GridLayout = {
      rects: { today: [0, 4, 4, 3], history: [0, 0, 6, 2], weather: [0, 8, 12, 2], wire: [8, 0, 4, 5], learned: [8, 5, 4, 3] },
      minimized: ['wire', 'learned'],
    };
    expect(fillVertical(m, 'today')).toEqual([0, 2, 4, 6]);
  });

  it('Alt+arrows move one cell, swap on a bump, stop at the edge', () => {
    const l = L({ weather: [8, 0, 4, 5] });
    expect(nudge(l, 'weather', 'down').layout.rects.weather).toEqual([8, 1, 4, 5]);
    const sw = nudge(L({}), 'today', 'right');
    expect(sw.did).toBe('swapped');
    expect(sw.with).toBe('history');
    expect(sw.layout.rects.today).toEqual([4, 0, 4, 10]);
    expect(nudge(L({}), 'today', 'left').did).toBe('blocked');
    expect(nudge(L({}), 'today', 'up').did).toBe('blocked');
  });

  it('Alt+Shift+arrows resize one cell, clamped', () => {
    const l = L({ weather: [8, 0, 4, 5] });
    expect(resizeStep(l, 'weather', 'down')?.rects.weather).toEqual([8, 0, 4, 6]);
    expect(resizeStep(l, 'weather', 'right')).toBeNull(); // the grid's edge
    expect(resizeStep(l, 'today', 'right')).toBeNull(); // History
    expect(resizeStep(L({}), 'today', 'left')?.rects.today).toEqual([0, 0, 3, 10]);
    expect(resizeStep(L({ today: [0, 0, 3, 10] }), 'today', 'left')).toBeNull(); // the minimum
  });

  it('restores along the four paths', () => {
    const base = minimize(L({}), 'weather');
    expect(hits(base, 'today', [8, 0, 4, 10])).toEqual([]);
    // 1. saved rect still free.
    expect(restoreRect(base, 'weather')).toMatchObject({
      path: 'saved',
      layout: { rects: { weather: [8, 0, 4, 10] }, minimized: ['wire', 'learned'] },
    });
    // 2. taken: the first free spot of the same size.
    const two = withRect(withRect(base, 'history', [4, 0, 8, 5]), 'today', [0, 0, 4, 10]);
    const r2 = restoreRect({ ...two, rects: { ...two.rects, weather: [8, 0, 4, 5] } }, 'weather');
    expect(r2.path).toBe('same-size');
    expect(r2.layout.rects.weather).toEqual([4, 5, 4, 5]);
    // 3. no spot that size: the largest free rect ≥ 3 × 3.
    const three = withRect(withRect(base, 'today', [0, 0, 8, 10]), 'history', [8, 0, 4, 6]);
    const r3 = restoreRect(three, 'weather');
    expect(r3.path).toBe('largest');
    expect(r3.layout.rects.weather).toEqual([8, 6, 4, 4]);
    // 4. nothing ≥ 3 × 3: Three columns, other minimized windows stay so.
    const four = minimize(withRect(withRect(base, 'today', [0, 0, 10, 10]), 'history', [10, 0, 2, 10] as Rect), 'history');
    const full = withRect(four, 'today', [0, 0, 12, 10]);
    const r4 = restoreRect(full, 'weather');
    expect(r4.path).toBe('reset');
    expect(r4.layout.rects).toEqual(PRESETS.thirds);
    expect(r4.layout.minimized).toEqual(['wire', 'learned', 'history']);
  });

  it('finds the largest free rect, first among equals', () => {
    const l = L({ today: [0, 0, 6, 10], history: [6, 0, 6, 4] }, ['weather']);
    expect(largestFree(l, 'weather')).toEqual([6, 4, 6, 6]);
    expect(overlaps([0, 0, 3, 3], [3, 0, 3, 3])).toBe(false);
  });
});
