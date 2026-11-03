import type { Schedule } from './api';

// Schedules on the page: which days a habit is due, and how to say it. The
// API decides the streaks; this only draws the picker and its summary.

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};
export const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

export function isDue(s: Schedule, date: string): boolean {
  if (s.kind === 'every_other_day') return Math.abs(dayNumber(date) - dayNumber(s.anchor)) % 2 === 0;
  if (s.kind === 'weekdays') return s.days.includes(weekday(date));
  return true;
}

// "Daily", "Every other day", "Weekdays", "Weekends", "Mon, Wed, Fri".
export function describeSchedule(s: Schedule): string {
  if (s.kind === 'daily') return 'Daily';
  if (s.kind === 'every_other_day') return 'Every other day';
  const days = [...new Set(s.days)].sort((a, b) => a - b);
  if (days.length === 7) return 'Every day of the week';
  if (days.join() === '1,2,3,4,5') return 'Weekdays';
  if (days.join() === '0,6') return 'Weekends';
  // Monday first, the way a week reads.
  return [...days.filter((d) => d > 0), ...days.filter((d) => d === 0)].map((d) => WEEKDAY_SHORT[d]).join(', ');
}

export function sameSchedule(a: Schedule, b: Schedule): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'every_other_day' && b.kind === 'every_other_day') return a.anchor === b.anchor;
  if (a.kind === 'weekdays' && b.kind === 'weekdays') {
    const x = [...new Set(a.days)].sort().join();
    return x === [...new Set(b.days)].sort().join();
  }
  return true;
}
