import { describe, expect, it, vi } from 'vitest';
import type { Api, HistoryMatrix, Today } from '../lib/api';
import { createDeskStore, type Change } from './store';

const DATE = '2026-10-14';

function todayData(done: Record<number, boolean>, streaks: Record<number, number>, date = DATE): Today {
  const habits = [1, 2].map((id) => ({
    id,
    slug: `h${id}`,
    label: `Habit ${id}`,
    done: !!done[id],
    due: true,
    schedule: { kind: 'daily' as const },
    streak: streaks[id] ?? 0,
    best: 0,
    totalDone: 0,
    rampText: null,
    milestone: { next: 7, progress: 0 },
  }));
  const doneCount = habits.filter((h) => h.done).length;
  return { date, doneCount, total: 2, dueCount: 2, dueDone: doneCount, note: null, learned: null, habits };
}

function matrix(done: Record<number, boolean>): HistoryMatrix {
  return {
    start: '2026-10-12',
    end: DATE,
    dates: ['2026-10-12', '2026-10-13', DATE],
    habits: [1, 2].map((id) => ({ id, slug: `h${id}`, label: `Habit ${id}`, done: [true, true, !!done[id]], due: [true, true, true], streak: 0 })),
    stats: { completionPct: 0, bestLiveStreak: 0, allDoneDays: 0 },
  };
}

function setup() {
  let server = {
    done: {} as Record<number, boolean>,
    streaks: { 1: 6, 2: 2 } as Record<number, number>,
    past: { 1: true, 2: true } as Record<number, boolean>,
  };
  let fail = false;
  let release: (() => void) | null = null;
  const api = {
    // A past day is served from `past` (done flags for 2026-10-13).
    today: vi.fn(async (date: string) =>
      date === DATE ? todayData(server.done, server.streaks) : todayData(server.past, {}, date),
    ),
    historyMatrix: vi.fn(async () => matrix(server.done)),
    notes: vi.fn(async () => []),
    check: vi.fn(async (id: number) => {
      if (release === null) await new Promise<void>((r) => (release = r));
      if (fail) throw new Error('forced');
      server.done[id] = true;
      server.streaks[id] += 1;
      return { done: true };
    }),
    uncheck: vi.fn(async (id: number) => {
      server.done[id] = false;
      return { done: false };
    }),
  } as unknown as Api;
  const errors: string[] = [];
  const guard = async <T,>(fn: () => Promise<T>, title = 'PHT') => {
    try {
      return await fn();
    } catch {
      errors.push(title);
      return undefined;
    }
  };
  const store = createDeskStore({ api, guard });
  const changes: Change[] = [];
  store.subscribe((c) => changes.push(c));
  return {
    store,
    api,
    changes,
    errors,
    go: () => {
      const r = release;
      release = () => undefined;
      r?.();
    },
    failNext: () => {
      fail = true;
    },
    reset: (s: typeof server) => {
      server = s;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('desk store', () => {
  it('loads Today, the matrix and the notes for one date', async () => {
    const t = setup();
    expect(await t.store.load(DATE)).toBe(true);
    expect(t.store.state.date).toBe(DATE);
    expect(t.store.state.today?.total).toBe(2);
    expect(t.store.state.view).toBe(DATE);
    expect(t.api.historyMatrix).toHaveBeenCalledWith(32, DATE, 30);
    expect(t.api.notes).toHaveBeenCalledWith('2026-10-12', DATE);
  });

  it('checks optimistically in Today and the matrix together, then syncs once', async () => {
    const t = setup();
    await t.store.load(DATE);
    t.store.toggle(1);
    const s = t.store.state;
    expect(s.today?.habits[0].done).toBe(true);
    expect(s.today?.doneCount).toBe(1);
    expect(s.history?.habits[0].done[2]).toBe(true);
    expect(t.store.pending()).toBe(1);
    // A second press on the same habit while its request is out is ignored.
    t.store.toggle(1);
    expect(s.today?.habits[0].done).toBe(true);
    t.go();
    await vi.waitFor(() => expect(t.changes.some((c) => c.kind === 'synced')).toBe(true));
    expect(t.changes.map((c) => c.kind)).toEqual(['load', 'toggle', 'confirmed', 'synced']);
    // 6 → 7 through this check: a milestone.
    expect(t.changes.at(-1)).toEqual({ kind: 'synced', milestones: [{ habitId: 1, label: 'Habit 1', streak: 7 }] });
    expect(t.store.state.today?.habits[0].streak).toBe(7);
  });

  it('rolls both back and reports when the request fails', async () => {
    const t = setup();
    await t.store.load(DATE);
    t.failNext();
    t.store.toggle(2);
    t.go();
    await vi.waitFor(() => expect(t.errors).toEqual(["Couldn't check that"]));
    const s = t.store.state;
    expect(s.today?.habits[1].done).toBe(false);
    expect(s.today?.doneCount).toBe(0);
    expect(s.history?.habits[1].done[2]).toBe(false);
    expect(t.changes.map((c) => c.kind)).toContain('rollback');
    await flush();
    expect(t.changes.filter((c) => c.kind === 'synced')).toHaveLength(1);
    expect(t.changes.find((c) => c.kind === 'synced')).toEqual({ kind: 'synced', milestones: [] });
  });

  it('reports no milestone when unchecking', async () => {
    const t = setup();
    t.reset({ done: { 1: true }, streaks: { 1: 7, 2: 0 }, past: {} });
    await t.store.load(DATE);
    t.store.toggle(1);
    await vi.waitFor(() => expect(t.changes.some((c) => c.kind === 'synced')).toBe(true));
    expect(t.changes.at(-1)).toEqual({ kind: 'synced', milestones: [] });
  });

  it("keeps History's notes in step with Today's note", async () => {
    const t = setup();
    await t.store.load(DATE);
    t.store.noteSaved(DATE, 'a line');
    expect(t.store.state.notes.map((n) => n.line)).toEqual(['a line']);
    expect(t.store.state.today?.note).toBe('a line');
    t.store.noteSaved(DATE, null);
    expect(t.store.state.notes).toEqual([]);
  });

  it('backfills a past day from History: optimistic, and never a milestone', async () => {
    const t = setup();
    await t.store.load(DATE);
    // 2026-10-13 is lit in the matrix; uncheck it from its cell.
    expect(t.store.isDone(1, '2026-10-13')).toBe(true);
    t.store.toggle(1, '2026-10-13');
    expect(t.store.state.history?.habits[0].done[1]).toBe(false);
    // The deck (today) is untouched.
    expect(t.store.state.today?.doneCount).toBe(0);
    await vi.waitFor(() => expect(t.changes.some((c) => c.kind === 'synced')).toBe(true));
    expect(t.api.uncheck).toHaveBeenCalledWith(1, '2026-10-13');
    expect(t.changes.find((c) => c.kind === 'toggle')).toEqual({ kind: 'toggle', habitId: 1, date: '2026-10-13', done: false });
    expect(t.changes.at(-1)).toEqual({ kind: 'synced', milestones: [] });
  });

  it('refuses days outside the window', async () => {
    const t = setup();
    await t.store.load(DATE);
    expect(t.store.earliest()).toBe('2026-09-14');
    t.store.toggle(1, '2026-10-15');
    t.store.toggle(1, '2026-09-13');
    expect(t.api.check).not.toHaveBeenCalled();
    expect(t.api.uncheck).not.toHaveBeenCalled();
    expect(await t.store.setView('2026-09-13')).toBe(false);
    expect(await t.store.setView('2026-10-15')).toBe(false);
    expect(t.store.state.view).toBe(DATE);
  });

  it('moves the deck to a past day, where keys edit that day and celebrate nothing', async () => {
    const t = setup();
    await t.store.load(DATE);
    expect(await t.store.setView('2026-10-13')).toBe(true);
    expect(t.store.state.view).toBe('2026-10-13');
    expect(t.store.state.date).toBe(DATE);
    expect(t.store.state.today?.date).toBe('2026-10-13');
    expect(t.store.state.today?.doneCount).toBe(2);
    t.store.toggle(2);
    // Deck and matrix both follow, on the viewed day.
    expect(t.store.state.today?.doneCount).toBe(1);
    expect(t.store.state.history?.habits[1].done[1]).toBe(false);
    await vi.waitFor(() => expect(t.changes.some((c) => c.kind === 'synced')).toBe(true));
    expect(t.api.uncheck).toHaveBeenCalledWith(2, '2026-10-13');
    expect(t.api.today).toHaveBeenLastCalledWith('2026-10-13');
    expect(t.changes.at(-1)).toEqual({ kind: 'synced', milestones: [] });
  });

  it("keeps a past day's note in step on the deck", async () => {
    const t = setup();
    await t.store.load(DATE, '2026-10-13');
    t.store.noteSaved('2026-10-13', 'late line');
    expect(t.store.state.today?.note).toBe('late line');
    t.store.noteSaved(DATE, 'today line');
    expect(t.store.state.today?.note).toBe('late line');
    expect(t.store.state.notes.map((n) => n.date)).toEqual(['2026-10-13', DATE]);
  });

  it("keeps SIDE B (learned) in step on the deck and tells the Learned window", async () => {
    const t = setup();
    await t.store.load(DATE, '2026-10-13');
    t.store.learnedSaved('2026-10-13', 'bread rising');
    expect(t.store.state.today?.learned).toBe('bread rising');
    // Another day's entry leaves the deck alone, but is still announced.
    t.store.learnedSaved(DATE, 'other day');
    expect(t.store.state.today?.learned).toBe('bread rising');
    expect(t.changes.filter((c) => c.kind === 'learned')).toEqual([
      { kind: 'learned', date: '2026-10-13' },
      { kind: 'learned', date: DATE },
    ]);
    t.store.learnedSaved('2026-10-13', null);
    expect(t.store.state.today?.learned).toBeNull();
  });
});
