import { describe, expect, it } from 'vitest';
import { describeSchedule, isDue, sameSchedule, weekday } from './schedule';

describe('schedule', () => {
  it('knows the weekday from the date string alone', () => {
    expect(weekday('2026-10-15')).toBe(4);
    expect(weekday('2026-10-18')).toBe(0);
  });

  it('every other day counts from the anchor in both directions, across months', () => {
    const s = { kind: 'every_other_day' as const, anchor: '2026-10-30' };
    expect(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'].map((d) => isDue(s, d))).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it('weekdays and daily', () => {
    const mwf = { kind: 'weekdays' as const, days: [1, 3, 5] };
    expect(isDue(mwf, '2026-10-14')).toBe(true);
    expect(isDue(mwf, '2026-10-15')).toBe(false);
    expect(isDue({ kind: 'daily' }, '2026-10-15')).toBe(true);
  });

  it('says it plainly', () => {
    expect(describeSchedule({ kind: 'daily' })).toBe('Daily');
    expect(describeSchedule({ kind: 'every_other_day', anchor: '2026-10-15' })).toBe('Every other day');
    expect(describeSchedule({ kind: 'weekdays', days: [5, 1, 3] })).toBe('Mon, Wed, Fri');
    expect(describeSchedule({ kind: 'weekdays', days: [0, 1] })).toBe('Mon, Sun');
    expect(describeSchedule({ kind: 'weekdays', days: [1, 2, 3, 4, 5] })).toBe('Weekdays');
    expect(describeSchedule({ kind: 'weekdays', days: [6, 0] })).toBe('Weekends');
  });

  it('compares schedules by meaning', () => {
    expect(sameSchedule({ kind: 'weekdays', days: [3, 1] }, { kind: 'weekdays', days: [1, 3, 3] })).toBe(true);
    expect(sameSchedule({ kind: 'daily' }, { kind: 'weekdays', days: [0, 1, 2, 3, 4, 5, 6] })).toBe(false);
    expect(sameSchedule({ kind: 'every_other_day', anchor: '2026-10-15' }, { kind: 'every_other_day', anchor: '2026-10-16' })).toBe(false);
  });
});
