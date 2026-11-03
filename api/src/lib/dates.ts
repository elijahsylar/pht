// Single source of date handling for the API. Pure: no DB, no imports.
//
// Ownership model: the CLIENT owns "today" — it knows the user's real local
// date — and sends an explicit YYYY-MM-DD string with every request. The
// backend treats stored dates as opaque local date strings and never calls
// new Date() to decide what today is. The only server-side clock use is the
// `app_timezone` fallback (see resolveToday in db/settings.ts) and the
// future-date guard, which allows a day of slack for exactly that reason.

export const DEFAULT_APP_TIMEZONE = 'UTC';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// True only for a real calendar day. The regex alone accepts 2026-02-31, which
// MySQL in strict mode rejects with an error the caller would see as a 500.
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

// Calendar arithmetic on date strings. Runs in UTC so no zone or DST rule can
// make a day 23 or 25 hours long and skip or repeat a date.
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Normalise a DATE column to YYYY-MM-DD.
//
// With `dateStrings: ['DATE']` on the pool, DATE columns already arrive as
// strings and this is a passthrough. The Date branch is a safety net for any
// driver/config change; it uses LOCAL getters, which are correct at any UTC
// offset — unlike toISOString(), which silently shifts a day for positive
// offsets because mysql2 materialises DATE as local midnight.
export function toIsoDate(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The calendar date of an instant in an IANA zone.
export function dateInZone(instant: Date, tz: string): string {
  const zone = isValidTimeZone(tz) ? tz : DEFAULT_APP_TIMEZONE;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

// Current calendar date in an IANA zone. Only a fallback and a sanity bound —
// never the authority on what "today" is.
export function todayInZone(tz: string): string {
  return dateInZone(new Date(), tz);
}
