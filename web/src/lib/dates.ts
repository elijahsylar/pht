// Calendar dates for the page. The page owns "today": it is computed here, in
// the app timezone the server stores (GET /settings/timezone), and sent with
// every request. Nothing here hardcodes a zone or a date.
//
// Dates are YYYY-MM-DD strings throughout. Arithmetic runs in UTC so a DST
// change can never make a day 23 or 25 hours long.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// The zone the page computes "today" in: the server's app_timezone when it is
// set and valid, otherwise the browser's own.
export function resolveZone(serverZone: string | null | undefined): string {
  return serverZone && isValidZone(serverZone) ? serverZone : browserZone();
}

// The calendar date of an instant in a zone.
export function dateInZone(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function todayIn(tz: string, now: Date = new Date()): string {
  return dateInZone(now, tz);
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// `n` consecutive dates ending at `end`, oldest first.
export function lastNDays(end: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(end, i - (n - 1)));
}

// Formatting reads the date as a UTC calendar day, so the label is the date
// itself and never shifted by the browser's zone.
function utcDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// "Tuesday, October 13"
export function longDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(utcDate(iso));
}

// "Oct 13"
export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(
    utcDate(iso),
  );
}

// "T" for Tuesday — the single-letter column header in the 14-day grids.
export function weekdayLetter(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'narrow' }).format(
    utcDate(iso),
  );
}

export function dayOfMonth(iso: string): number {
  return Number(iso.slice(8, 10));
}

// "Tue Oct 13": a day in a label short enough for every LED cell.
export function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
    .format(utcDate(iso))
    .replace(',', '');
}
