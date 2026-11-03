import type { Api, HistoryMatrix, Note, Today } from '../lib/api';
import { addDays } from '../lib/dates';
import { isMilestone } from '../lib/keys';

// The one client-side copy of the desk, shared by every window: the History
// matrix and its notes (always ending at today), and the Today deck for the
// day it is showing — today, or a past day being backfilled. Windows
// subscribe and redraw from it, so a check shows in Today and History at the
// same moment, and a rollback undoes both.
//
// Checking is optimistic: the state changes on click, the request goes out,
// and a failure puts it back and reports through `guard`. When the last
// request of a burst lands, the deck and the matrix are refetched once so the
// streaks and stats are the server's, not a guess.

// Stats are over 30 days; the matrix draws one more column than the 30 days a
// check can be backfilled for, so the read-only day 31 shows.
export const HISTORY_DAYS = 30;
export const BACKFILL_DAYS = 30;
export const MATRIX_DAYS = BACKFILL_DAYS + 2;

export interface DeskState {
  // Today in the app timezone when loaded: where History ends.
  date: string;
  // The day the Today deck shows and edits: `date`, or up to 30 days before.
  view: string;
  // The deck's data, for `view`.
  today: Today | null;
  history: HistoryMatrix | null;
  // Notes in the History range, oldest first.
  notes: Note[];
}

export interface Milestone {
  habitId: number;
  label: string;
  streak: number;
}

export type Change =
  | { kind: 'load' }
  // The deck moved to another day (`state.view`); History is unchanged.
  | { kind: 'view' }
  | { kind: 'toggle'; habitId: number; date: string; done: boolean }
  | { kind: 'rollback'; habitId: number; date: string; done: boolean }
  // The server accepted a check or uncheck.
  | { kind: 'confirmed'; habitId: number; date: string; done: boolean }
  // Server numbers after a burst of checks, and any streak that just reached
  // a milestone through a check made today, for today.
  | { kind: 'synced'; milestones: Milestone[] }
  | { kind: 'notes' }
  // A "learned" entry was saved (SIDE B) for `date`.
  | { kind: 'learned'; date: string };

type Guard = <T>(fn: () => Promise<T>, failTitle?: string) => Promise<T | undefined>;

export interface DeskStore {
  readonly state: DeskState;
  subscribe(fn: (change: Change) => void): () => void;
  // Fetch everything with History ending at `date` and the deck on `view`
  // (default `date`). Resolves false when it did not succeed.
  load(date: string, view?: string): Promise<boolean>;
  // Move the deck to another day in the window. Resolves false on failure.
  setView(view: string): Promise<boolean>;
  // The earliest day that can still be changed.
  earliest(): string;
  // Flip one habit on one day (default: the deck's day).
  toggle(habitId: number, date?: string): void;
  // Whether `habitId` is done on `date`, from the deck or the matrix.
  isDone(habitId: number, date: string): boolean | null;
  pending(): number;
  // A note changed (saved through the API by the Today window).
  noteSaved(date: string, line: string | null): void;
  // A "learned" entry changed (saved by the Today window's SIDE B).
  learnedSaved(date: string, text: string | null): void;
}

export function createDeskStore(deps: { api: Api; guard: Guard }): DeskStore {
  const { api, guard } = deps;
  const state: DeskState = { date: '', view: '', today: null, history: null, notes: [] };
  const subs = new Set<(c: Change) => void>();
  const inFlight = new Set<string>();
  const flightKey = (habitId: number, date: string) => `${habitId}@${date}`;
  // Today's streak before the burst, per habit checked for today from a deck
  // showing today: the only checks that can be a milestone.
  let burst = new Map<number, number>();
  let touched = false;
  let loadSeq = 0;

  const emit = (c: Change) => {
    for (const fn of [...subs]) fn(c);
  };
  const matrix = (date: string) => api.historyMatrix(MATRIX_DAYS, date, HISTORY_DAYS);
  const earliest = () => addDays(state.date, -BACKFILL_DAYS);

  async function fetchAll(date: string, view: string) {
    const [today, history] = await Promise.all([api.today(view), matrix(date)]);
    const notes = await api.notes(history.start, date);
    return { today, history, notes };
  }

  function isDone(habitId: number, date: string): boolean | null {
    if (date === state.view) {
      const h = state.today?.habits.find((x) => x.id === habitId);
      if (h) return h.done;
    }
    const hist = state.history;
    const i = hist ? hist.dates.indexOf(date) : -1;
    const row = hist?.habits.find((x) => x.id === habitId);
    return row && i >= 0 ? row.done[i] : null;
  }

  // Set one habit's flag for one day, in the deck (if it shows that day) and
  // in the matrix (if it has that day).
  function apply(habitId: number, date: string, done: boolean) {
    const t = state.today;
    const habit = t?.habits.find((x) => x.id === habitId);
    if (t && habit && date === state.view && habit.done !== done) {
      habit.done = done;
      t.doneCount += done ? 1 : -1;
      if (habit.due) t.dueDone += done ? 1 : -1;
    }
    const hist = state.history;
    const i = hist ? hist.dates.indexOf(date) : -1;
    const row = hist?.habits.find((x) => x.id === habitId);
    if (row && i >= 0) row.done[i] = done;
  }

  async function sync() {
    const { date, view } = state;
    const before = burst;
    burst = new Map();
    touched = false;
    const seq = loadSeq;
    const fresh = await guard(() => Promise.all([api.today(view), matrix(date)]));
    // A newer load, another burst, or a new day has taken over: drop this.
    if (!fresh || seq !== loadSeq || inFlight.size > 0 || date !== state.date || view !== state.view) return;
    [state.today, state.history] = fresh;
    const milestones: Milestone[] = [];
    if (view === date) {
      for (const [habitId, was] of before) {
        const h = fresh[0].habits.find((x) => x.id === habitId);
        if (h && h.done && h.streak > was && isMilestone(h.streak)) {
          milestones.push({ habitId, label: h.label, streak: h.streak });
        }
      }
    }
    emit({ kind: 'synced', milestones });
  }

  return {
    state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },

    async load(date, view = date) {
      const seq = ++loadSeq;
      const loaded = await guard(() => fetchAll(date, view));
      if (!loaded || seq !== loadSeq) return false;
      state.date = date;
      state.view = view;
      state.today = loaded.today;
      state.history = loaded.history;
      state.notes = loaded.notes;
      emit({ kind: 'load' });
      return true;
    },

    async setView(view) {
      if (!state.date || view > state.date || view < earliest()) return false;
      const seq = ++loadSeq;
      const today = await guard(() => api.today(view));
      if (!today || seq !== loadSeq) return false;
      state.view = view;
      state.today = today;
      emit({ kind: 'view' });
      return true;
    },

    earliest,
    isDone,
    pending: () => inFlight.size,

    toggle(habitId, date = state.view) {
      const was = isDone(habitId, date);
      const key = flightKey(habitId, date);
      // Only days in the window, and one request per habit and day at a time.
      if (was === null || inFlight.has(key) || date > state.date || date < earliest()) return;
      const want = !was;
      if (date === state.date && state.view === state.date && !burst.has(habitId)) {
        const h = state.today?.habits.find((x) => x.id === habitId);
        if (h) burst.set(habitId, h.streak);
      }
      touched = true;
      apply(habitId, date, want);
      inFlight.add(key);
      emit({ kind: 'toggle', habitId, date, done: want });

      const anchor = state.date;
      void (async () => {
        try {
          if (want) await api.check(habitId, date);
          else await api.uncheck(habitId, date);
        } catch (err) {
          inFlight.delete(key);
          if (anchor === state.date) {
            apply(habitId, date, !want);
            emit({ kind: 'rollback', habitId, date, done: !want });
          }
          await guard(() => Promise.reject(err), want ? "Couldn't check that" : "Couldn't uncheck that");
          if (inFlight.size === 0 && touched) void sync();
          return;
        }
        inFlight.delete(key);
        if (anchor === state.date) emit({ kind: 'confirmed', habitId, date, done: want });
        if (inFlight.size === 0) await sync();
      })();
    },

    noteSaved(date, line) {
      const rest = state.notes.filter((n) => n.date !== date);
      if (line) rest.push({ date, line, updatedAt: new Date().toISOString() });
      rest.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      state.notes = rest;
      if (state.today && date === state.view) state.today.note = line;
      emit({ kind: 'notes' });
    },

    learnedSaved(date, text) {
      if (state.today && date === state.view) state.today.learned = text;
      emit({ kind: 'learned', date });
    },
  };
}
