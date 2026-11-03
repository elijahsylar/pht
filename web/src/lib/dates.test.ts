import { describe, expect, it } from 'vitest';
import {
  addDays,
  dateInZone,
  dayOfMonth,
  isIsoDate,
  isValidZone,
  lastNDays,
  dayLabel,
  longDate,
  resolveZone,
  shortDate,
  todayIn,
  weekdayLetter,
} from './dates';

describe('todayIn: the date comes from the zone, never the machine', () => {
  // 2026-10-14 05:00 UTC: still the 13th in Tahiti and Boise, the 14th in
  // London and Tokyo.
  const instant = new Date('2026-10-14T05:00:00Z');

  it('reads the calendar day in the given zone', () => {
    expect(todayIn('Pacific/Tahiti', instant)).toBe('2026-10-13');
    expect(todayIn('America/Boise', instant)).toBe('2026-10-13');
    expect(todayIn('Europe/London', instant)).toBe('2026-10-14');
    expect(todayIn('Asia/Tokyo', instant)).toBe('2026-10-14');
    expect(todayIn('UTC', instant)).toBe('2026-10-14');
  });

  it('flips at local midnight, not UTC midnight', () => {
    // Midnight in Tahiti is 10:00 UTC.
    expect(todayIn('Pacific/Tahiti', new Date('2026-10-14T09:59:59Z'))).toBe('2026-10-13');
    expect(todayIn('Pacific/Tahiti', new Date('2026-10-14T10:00:00Z'))).toBe('2026-10-14');
  });

  it('follows a zone across the dateline', () => {
    const t = new Date('2026-10-13T11:00:00Z');
    expect(todayIn('Pacific/Kiritimati', t)).toBe('2026-10-14'); // UTC+14
    expect(todayIn('Pacific/Pago_Pago', t)).toBe('2026-10-13'); // UTC-11
  });

  it('handles the US DST change days', () => {
    // 2026-11-01 is the fall-back day in Boise (US Mountain time).
    expect(todayIn('America/Boise', new Date('2026-11-01T06:30:00Z'))).toBe('2026-11-01');
    expect(todayIn('America/Boise', new Date('2026-11-02T06:30:00Z'))).toBe('2026-11-01');
    expect(dateInZone(new Date('2026-11-02T07:00:00Z'), 'America/Boise')).toBe('2026-11-02');
  });
});

describe('resolveZone', () => {
  it('uses the server zone when valid, else the browser zone', () => {
    expect(resolveZone('Pacific/Tahiti')).toBe('Pacific/Tahiti');
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveZone(null)).toBe(browser);
    expect(resolveZone(undefined)).toBe(browser);
    expect(resolveZone('')).toBe(browser);
    expect(resolveZone('Mars/Olympus_Mons')).toBe(browser);
  });

  it('validates zones', () => {
    expect(isValidZone('America/Boise')).toBe(true);
    expect(isValidZone('Not/A_Zone')).toBe(false);
  });
});

describe('date arithmetic and labels', () => {
  it('validates real calendar days only', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-10-13T00:00')).toBe(false);
  });

  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('lists the last n days oldest first, ending at the given day', () => {
    const days = lastNDays('2027-01-03', 14);
    expect(days).toHaveLength(14);
    expect(days[0]).toBe('2026-12-21');
    expect(days[13]).toBe('2027-01-03');
    expect(new Set(days).size).toBe(14);
  });

  it('formats the date itself, whatever the machine zone', () => {
    // Formatting runs in UTC on purpose; these hold in any TZ the tests run in.
    expect(longDate('2026-10-13')).toBe('Tuesday, October 13');
    expect(dayLabel('2026-10-13')).toBe('Tue Oct 13');
    expect(shortDate('2027-01-01')).toBe('Jan 1');
    expect(weekdayLetter('2026-10-13')).toBe('T');
    expect(weekdayLetter('2026-10-18')).toBe('S');
    expect(dayOfMonth('2026-10-09')).toBe(9);
  });
});
