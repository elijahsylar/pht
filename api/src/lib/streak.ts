import { addDays } from './dates.js';
import { dueOn, type ScheduleSpan } from './schedule.js';

// All streak arithmetic for the API. Pure: takes the dates a habit was checked,
// its schedule spans and the client's "today", returns numbers. No DB, no clock.
//
// The rule, in one sentence: not having done it YET today never breaks a
// streak; a full missed DUE day does. Days the schedule leaves out (rest days)
// are skipped: they never break a streak and never extend one, even when
// checked. No spans = daily, the behaviour before schedules existed.

export const MILESTONES = [7, 30, 60, 100] as const;

export interface Milestone {
  // The next streak length worth celebrating — always strictly above the
  // current streak, so reaching 7 immediately points at 30.
  next: number;
  // Days already banked toward it: the current streak.
  progress: number;
}

export interface HabitSummary {
  done: boolean;
  // Whether `today` is a due day under the schedule that holds on it.
  due: boolean;
  streak: number;
  best: number;
  totalDone: number;
  milestone: Milestone;
}

// Past the fixed list the target is the next multiple of 100, so a long streak
// always has something ahead of it.
export function nextMilestone(streak: number): number {
  for (const m of MILESTONES) {
    if (streak < m) return m;
  }
  return (Math.floor(streak / 100) + 1) * 100;
}

// Consecutive checked due days ending today if today is due and checked,
// otherwise ending at the last due day before it. Dates after `today` are
// ignored: they cannot be part of a run that ends today, and counting them
// would let a stray future check inflate it.
export function currentStreak(
  dates: ReadonlySet<string>,
  today: string,
  spans: readonly ScheduleSpan[] = [],
): number {
  if (!dates.size) return 0;
  const first = [...dates].reduce((m, d) => (d < m ? d : m));
  let day = dueOn(spans, today) && dates.has(today) ? today : addDays(today, -1);
  let n = 0;
  // Every due day before the first check is a miss, so the walk stops there.
  while (day >= first) {
    if (dueOn(spans, day)) {
      if (!dates.has(day)) break;
      n += 1;
    }
    day = addDays(day, -1);
  }
  return n;
}

// Longest run of consecutive checked due days anywhere in the history.
export function bestStreak(dates: ReadonlySet<string>, spans: readonly ScheduleSpan[] = []): number {
  if (!dates.size) return 0;
  const sorted = [...dates].sort();
  const last = sorted[sorted.length - 1];
  let best = 0;
  let run = 0;
  // One pass over the calendar from the first check to the last, so rest
  // days in between can be skipped rather than breaking the run.
  for (let day = sorted[0]; day <= last; ) {
    const next = day < last ? addDays(day, 1) : null;
    if (dueOn(spans, day)) {
      if (dates.has(day)) {
        run += 1;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    // Stop at the last check without stepping past it (past 9999-12-31 the
    // next date no longer sorts after it and addDays throws).
    if (next === null || next <= day) break;
    day = next;
  }
  return best;
}

export function summarize(
  checked: Iterable<string>,
  today: string,
  spans: readonly ScheduleSpan[] = [],
): HabitSummary {
  const dates = new Set(checked);
  const streak = currentStreak(dates, today, spans);
  return {
    done: dates.has(today),
    due: dueOn(spans, today),
    streak,
    best: bestStreak(dates, spans),
    totalDone: dates.size,
    milestone: { next: nextMilestone(streak), progress: streak },
  };
}

// `days` consecutive days ending at `end`, oldest first.
export function historyFlags(
  checked: Iterable<string>,
  end: string,
  days: number,
): { date: string; done: boolean }[] {
  const dates = new Set(checked);
  const out: { date: string; done: boolean }[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = addDays(end, -i);
    out.push({ date, done: dates.has(date) });
  }
  return out;
}

// Whether each of `days` consecutive days ending at `end` is due, oldest first.
export function dueFlags(spans: readonly ScheduleSpan[], end: string, days: number): boolean[] {
  const out: boolean[] = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(dueOn(spans, addDays(end, -i)));
  return out;
}

export interface HistoryStats {
  // Checked due cells over due cells (habits × days), as a whole percent.
  // 0 with no due cells.
  completionPct: number;
  // The longest current streak among the habits, as of the last day.
  bestLiveStreak: number;
  // Days in the range with at least one habit due on which every due habit
  // was checked. 0 with no habits.
  allDoneDays: number;
}

// The three numbers under the desktop's History matrix. `rows` are per-habit
// day flags over the same range (historyFlags), `streaks` their current
// streaks, `due` the matching due flags (omitted = every day due). Rest days
// count for nothing, checked or not.
export function historyStats(
  rows: readonly (readonly boolean[])[],
  streaks: readonly number[],
  due?: readonly (readonly boolean[])[],
): HistoryStats {
  const days = rows[0]?.length ?? 0;
  const isDue = (h: number, i: number) => (due ? due[h][i] : true);
  let cells = 0;
  let checked = 0;
  let allDoneDays = 0;
  for (let i = 0; i < days; i += 1) {
    let dueToday = 0;
    let doneToday = 0;
    rows.forEach((r, h) => {
      if (!isDue(h, i)) return;
      dueToday += 1;
      if (r[i]) doneToday += 1;
    });
    cells += dueToday;
    checked += doneToday;
    if (dueToday > 0 && doneToday === dueToday) allDoneDays += 1;
  }
  return {
    completionPct: cells ? Math.round((checked / cells) * 100) : 0,
    bestLiveStreak: streaks.reduce((m, s) => Math.max(m, s), 0),
    allDoneDays,
  };
}
