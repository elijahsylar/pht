import { addDays } from './dates.js';

// Which days a habit is due. Pure: no DB, no clock.
//
// - daily: every day (every habit before schedules existed).
// - every_other_day: the anchor date and every second day from it, in both
//   directions.
// - weekdays: the days of the week in `days`, 0 = Sunday … 6 = Saturday.
//
// A habit's schedule can change. Each change takes effect on a day and lasts
// until the next one, so the days before it keep the schedule they had: a
// ScheduleSpan list (oldest first; the first span's `from` is null, meaning
// "since the beginning") answers which schedule held on any day.

export type Schedule =
  | { kind: 'daily' }
  | { kind: 'every_other_day'; anchor: string }
  | { kind: 'weekdays'; days: number[] };

export type ScheduleKind = Schedule['kind'];

export const DAILY: Schedule = { kind: 'daily' };

export interface ScheduleSpan {
  // First day this schedule applies; null = every day before the next span.
  from: string | null;
  schedule: Schedule;
}

// Whole days from a to b (b - a), on calendar dates.
export function dayDiff(a: string, b: string): number {
  const ms = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

// 0 = Sunday … 6 = Saturday, from the date string alone.
export function weekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isDue(s: Schedule, date: string): boolean {
  switch (s.kind) {
    case 'daily':
      return true;
    case 'every_other_day':
      return dayDiff(s.anchor, date) % 2 === 0;
    case 'weekdays':
      return s.days.includes(weekday(date));
  }
}

// The schedule that held on `date`. No spans = daily.
export function scheduleAt(spans: readonly ScheduleSpan[], date: string): Schedule {
  let found: Schedule = DAILY;
  for (const span of spans) {
    if (span.from === null || span.from <= date) found = span.schedule;
    else break;
  }
  return found;
}

export function dueOn(spans: readonly ScheduleSpan[], date: string): boolean {
  return isDue(scheduleAt(spans, date), date);
}

// Spans after setting `schedule` from `from` on: every span starting on or
// after `from` is replaced (the new schedule wins that day), earlier ones stay.
export function withSchedule(
  spans: readonly ScheduleSpan[],
  schedule: Schedule,
  from: string,
): ScheduleSpan[] {
  const kept = spans.filter((s) => s.from === null || s.from < from);
  return [...kept, { from, schedule }];
}

// Canonical form: weekdays sorted and unique, so equal schedules compare equal.
export function normalizeSchedule<S extends Schedule>(s: S): S {
  if (s.kind === 'weekdays') return { kind: 'weekdays', days: [...new Set(s.days)].sort((a, b) => a - b) } as S;
  return s;
}

// The DB's three columns (schedule, schedule_anchor, schedule_days) ⇄ a
// Schedule. A row that does not make sense reads as daily rather than failing
// every request that touches the habit.
export interface ScheduleColumns {
  kind: string;
  anchor: string | null;
  days: string | null;
}

export function scheduleFromColumns(c: ScheduleColumns): Schedule {
  if (c.kind === 'every_other_day' && c.anchor) return { kind: 'every_other_day', anchor: c.anchor };
  if (c.kind === 'weekdays' && c.days) {
    const days = c.days
      .split(',')
      .map(Number)
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length) return normalizeSchedule({ kind: 'weekdays', days });
  }
  return DAILY;
}

export function scheduleToColumns(s: Schedule): ScheduleColumns {
  if (s.kind === 'every_other_day') return { kind: s.kind, anchor: s.anchor, days: null };
  if (s.kind === 'weekdays') return { kind: s.kind, anchor: null, days: normalizeSchedule(s).days.join(',') };
  return { kind: 'daily', anchor: null, days: null };
}
