import { describe, expect, it } from 'vitest';
import { addDays, dateInZone, isIsoDate } from '../src/lib/dates.js';
import {
  bestStreak,
  currentStreak,
  historyFlags,
  nextMilestone,
  summarize,
} from '../src/lib/streak.js';

// `n` consecutive days ending at `end`.
function run(end: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(end, -i));
}

describe('dates', () => {
  it('accepts only real calendar days', () => {
    expect(isIsoDate('2026-10-13')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-02-31')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-1-1')).toBe(false);
    expect(isIsoDate('2026-10-13T00:00:00Z')).toBe(false);
    expect(isIsoDate(20261013)).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });

  it('steps across month, year and leap-day boundaries', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-10-13', 0)).toBe('2026-10-13');
  });

  it('does not skip or repeat a day across a DST change', () => {
    // US DST ended 2026-11-01 and starts 2027-03-14.
    expect(addDays('2026-11-02', -1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(addDays('2027-03-14', 1)).toBe('2027-03-15');
  });

  it('reads the calendar date of an instant in a zone', () => {
    const instant = new Date('2026-10-14T05:00:00Z');
    expect(dateInZone(instant, 'Pacific/Tahiti')).toBe('2026-10-13');
    expect(dateInZone(instant, 'UTC')).toBe('2026-10-14');
    expect(dateInZone(instant, 'Not/AZone')).toBe('2026-10-14'); // UTC fallback
  });
});

describe('currentStreak', () => {
  const today = '2026-10-13';

  it('is 0 with no history', () => {
    expect(currentStreak(new Set(), today)).toBe(0);
  });

  it('counts through today when today is checked', () => {
    expect(currentStreak(new Set(run(today, 5)), today)).toBe(5);
  });

  it('keeps the streak when today is not checked yet', () => {
    expect(currentStreak(new Set(run('2026-10-12', 5)), today)).toBe(5);
  });

  it('breaks after one full missed day', () => {
    // Last check was the day before yesterday.
    expect(currentStreak(new Set(run('2026-10-11', 5)), today)).toBe(0);
  });

  it('counts only the run after a gap', () => {
    const dates = new Set([...run(today, 3), ...run('2026-10-09', 10)]);
    expect(currentStreak(dates, today)).toBe(3);
  });

  it('is 1 for today alone and 1 for yesterday alone', () => {
    expect(currentStreak(new Set([today]), today)).toBe(1);
    expect(currentStreak(new Set(['2026-10-12']), today)).toBe(1);
  });

  it('ignores a check dated after today', () => {
    expect(currentStreak(new Set(['2026-10-14']), today)).toBe(0);
    expect(currentStreak(new Set(['2026-10-14', ...run(today, 2)]), today)).toBe(2);
  });

  it('runs across a month boundary', () => {
    expect(currentStreak(new Set(run('2026-11-02', 5)), '2026-11-02')).toBe(5);
  });

  it('runs across a year boundary', () => {
    expect(currentStreak(new Set(run('2027-01-02', 10)), '2027-01-02')).toBe(10);
  });

  it('runs across a leap day', () => {
    expect(currentStreak(new Set(run('2028-03-01', 3)), '2028-03-01')).toBe(3);
  });

  it('breaks on Feb 29 when the leap day itself was missed', () => {
    const dates = new Set(['2028-03-01', '2028-02-28', '2028-02-27']);
    expect(currentStreak(dates, '2028-03-01')).toBe(1);
  });

  // A habit retired on the 5th and unretired today has no checks in between,
  // so the gap breaks the streak with no special case.
  it('restarts at 0 for a habit unretired after a gap', () => {
    const dates = new Set(run('2026-10-05', 20));
    expect(currentStreak(dates, today)).toBe(0);
    dates.add(today);
    expect(currentStreak(dates, today)).toBe(1);
  });
});

describe('bestStreak', () => {
  it('is 0 with no history', () => {
    expect(bestStreak(new Set())).toBe(0);
  });

  it('finds the longest run, not the latest', () => {
    const dates = new Set([...run('2026-10-13', 2), ...run('2026-09-20', 9), '2026-08-01']);
    expect(bestStreak(dates)).toBe(9);
  });

  it('counts a run spanning a year boundary as one run', () => {
    expect(bestStreak(new Set(run('2027-01-05', 12)))).toBe(12);
  });

  it('does not join runs separated by a single missed day', () => {
    const dates = new Set([...run('2026-10-13', 3), ...run('2026-10-09', 3)]);
    expect(bestStreak(dates)).toBe(3);
  });
});

describe('nextMilestone', () => {
  it('walks the fixed list, always strictly above the streak', () => {
    expect(nextMilestone(0)).toBe(7);
    expect(nextMilestone(6)).toBe(7);
    expect(nextMilestone(7)).toBe(30);
    expect(nextMilestone(29)).toBe(30);
    expect(nextMilestone(30)).toBe(60);
    expect(nextMilestone(60)).toBe(100);
    expect(nextMilestone(99)).toBe(100);
  });

  it('moves to the next multiple of 100 past the list', () => {
    expect(nextMilestone(100)).toBe(200);
    expect(nextMilestone(101)).toBe(200);
    expect(nextMilestone(199)).toBe(200);
    expect(nextMilestone(200)).toBe(300);
    expect(nextMilestone(1234)).toBe(1300);
  });
});

describe('summarize', () => {
  const today = '2026-10-13';

  it('reports an empty history', () => {
    expect(summarize([], today)).toEqual({
      done: false,
      due: true,
      streak: 0,
      best: 0,
      totalDone: 0,
      milestone: { next: 7, progress: 0 },
    });
  });

  it('separates current, best and total', () => {
    const s = summarize([...run('2026-10-12', 4), ...run('2026-09-01', 8)], today);
    expect(s).toEqual({
      done: false,
      due: true,
      streak: 4,
      best: 8,
      totalDone: 12,
      milestone: { next: 7, progress: 4 },
    });
  });

  it('never reports a best below the current streak', () => {
    const s = summarize(run(today, 40), today);
    expect(s.streak).toBe(40);
    expect(s.best).toBe(40);
    expect(s.done).toBe(true);
    expect(s.milestone).toEqual({ next: 60, progress: 40 });
  });

  it('counts duplicate dates once', () => {
    expect(summarize([today, today, '2026-10-12'], today).totalDone).toBe(2);
  });

  it('keeps total and best after the streak is broken', () => {
    const s = summarize(run('2026-10-01', 30), today);
    expect(s.streak).toBe(0);
    expect(s.best).toBe(30);
    expect(s.totalDone).toBe(30);
    expect(s.milestone).toEqual({ next: 7, progress: 0 });
  });
});

describe('historyFlags', () => {
  it('returns the window oldest first, ending at the given day', () => {
    expect(historyFlags(['2026-10-13', '2026-10-11'], '2026-10-13', 4)).toEqual([
      { date: '2026-10-10', done: false },
      { date: '2026-10-11', done: true },
      { date: '2026-10-12', done: false },
      { date: '2026-10-13', done: true },
    ]);
  });

  it('spans a year boundary', () => {
    const flags = historyFlags(['2026-12-31'], '2027-01-01', 3);
    expect(flags.map((f) => f.date)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
    expect(flags.map((f) => f.done)).toEqual([false, true, false]);
  });
});
