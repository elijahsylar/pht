import bcrypt from 'bcrypt';
import {
  DEFAULT_APP_TIMEZONE,
  addDays,
  isIsoDate,
  isValidTimeZone,
  todayInZone,
} from '../lib/dates.js';
import type { SettingsStore } from './store.js';

// Everything the app keeps in the key/value `settings` table (see schema.ts),
// expressed over a SettingsStore so it runs unchanged against MySQL or a fake.

// Cost factor for every credential hash we write (password + security answer).
export const BCRYPT_ROUNDS = 12;

// Legacy plaintext key, kept only so a pre-hash row can be migrated and removed.
export const SECURITY_ANSWER_KEY = 'security_answer';
export const SECURITY_ANSWER_HASH_KEY = 'security_answer_hash';
export const DEFAULT_SECURITY_ANSWER = 'name';

// The answer has always been compared case-insensitively after trimming. Hashing
// destroys the ability to normalize at compare time, so normalization has to
// happen identically before hashing AND before comparing — this one function is
// the only place it is defined.
export function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase();
}

export async function setSecurityAnswer(store: SettingsStore, answer: string): Promise<void> {
  const hash = await bcrypt.hash(normalizeAnswer(answer), BCRYPT_ROUNDS);
  await store.setSetting(SECURITY_ANSWER_HASH_KEY, hash);
  // A rewritten answer must not leave the old plaintext row behind.
  await store.deleteSetting(SECURITY_ANSWER_KEY);
}

// Returns the stored bcrypt hash, migrating a legacy plaintext row on the way
// past. schema.ts does this too; doing it here as well means verification is
// correct even if the app starts before the migration is run.
async function getSecurityAnswerHash(store: SettingsStore): Promise<string> {
  const stored = await store.getSetting(SECURITY_ANSWER_HASH_KEY);
  if (stored && stored.trim()) return stored.trim();
  const legacy = await store.getSetting(SECURITY_ANSWER_KEY);
  const plaintext = legacy && legacy.trim() ? legacy : DEFAULT_SECURITY_ANSWER;
  const hash = await bcrypt.hash(normalizeAnswer(plaintext), BCRYPT_ROUNDS);
  await store.setSetting(SECURITY_ANSWER_HASH_KEY, hash);
  await store.deleteSetting(SECURITY_ANSWER_KEY);
  return hash;
}

export async function verifySecurityAnswer(store: SettingsStore, answer: string): Promise<boolean> {
  return bcrypt.compare(normalizeAnswer(answer), await getSecurityAnswerHash(store));
}

// The admin password hash lives in `settings` so it can be changed from the UI
// without editing .env and restarting. ADMIN_PASSWORD_HASH stays as the
// fallback: it is what a fresh install authenticates against until the password
// is changed once. Only ever the bcrypt hash is stored — never the plaintext.
export const ADMIN_PASSWORD_HASH_KEY = 'admin_password_hash';

export async function getAdminPasswordHash(store: SettingsStore): Promise<string | null> {
  const stored = await store.getSetting(ADMIN_PASSWORD_HASH_KEY);
  if (stored && stored.trim()) return stored.trim();
  const fromEnv = process.env.ADMIN_PASSWORD_HASH;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null;
}

// IANA zone that defines the user's day boundary. The client defaults this to
// the browser's zone on first load; the backend uses it only as a fallback when
// a request didn't carry an explicit date, and as the reference for the
// future-date guard. UTC is the fallback if it was never written.
export const APP_TIMEZONE_KEY = 'app_timezone';

export async function getAppTimeZone(store: SettingsStore): Promise<string> {
  const tz = await store.getSetting(APP_TIMEZONE_KEY);
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_APP_TIMEZONE;
}

// Resolve "today": prefer the client's explicit date, else derive it from the
// configured app timezone. Never uses the server's own timezone.
export async function resolveToday(store: SettingsStore, explicit?: unknown): Promise<string> {
  if (isIsoDate(explicit)) return explicit;
  return todayInZone(await getAppTimeZone(store));
}

// The latest date a check or note may be written for: tomorrow in the app
// timezone. The client owns "today", so the server cannot know it exactly; one
// day of slack covers a client that is briefly ahead of the configured zone
// (travel, a zone not yet updated) while still refusing a typo'd far-future date
// that would otherwise sit in the history waiting to become a streak.
export async function latestWritableDate(store: SettingsStore): Promise<string> {
  return addDays(todayInZone(await getAppTimeZone(store)), 1);
}

// How far back a check or note may still be written or removed: 30 days
// before today in the app timezone, inclusive. Older days are read-only (403).
export const BACKFILL_DAYS = 30;
export async function earliestWritableDate(store: SettingsStore): Promise<string> {
  return addDays(todayInZone(await getAppTimeZone(store)), -BACKFILL_DAYS);
}

// The write window for a day: null when `date` may be written, else the
// status and error to answer with. Future (past tomorrow) is a 400 as before;
// older than the backfill window is 403 "read-only".
export async function writableDay(
  store: SettingsStore,
  date: string,
): Promise<{ status: 400 | 403; error: string } | null> {
  const latest = await latestWritableDate(store);
  if (date > latest) return { status: 400, error: `date is in the future (latest allowed ${latest})` };
  const earliest = await earliestWritableDate(store);
  if (date < earliest) return { status: 403, error: `read-only: days before ${earliest} cannot be changed` };
  return null;
}
