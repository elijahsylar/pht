import type { Schedule, ScheduleSpan } from '../lib/schedule.js';
import type { Candidate } from '../lib/wire.js';

// The one interface between the routes and persistence.
//
// Everything the API reads or writes goes through a Store. `createMysqlStore`
// (mysqlStore.ts) is the real one; tests/fakeStore.ts is an in-memory one typed
// against this same interface, so a method added or changed here fails the
// test build until the fake follows. tests/storeContract.ts runs one behaviour
// suite against both.

export interface Habit {
  id: number;
  slug: string;
  label: string;
  sort: number;
  rampText: string | null;
  // Real instants. The created_at floor on checks compares the calendar date
  // of createdAt in the app timezone.
  createdAt: Date;
  retiredAt: Date | null;
  // The schedule in force now (the last span's), and every span it has had,
  // oldest first; the first span's `from` is null. Never empty.
  schedule: Schedule;
  schedules: ScheduleSpan[];
}

export interface NewHabit {
  slug: string;
  label: string;
  // Omitted = after every existing habit.
  sort?: number;
  rampText: string | null;
}

export interface HabitPatch {
  label?: string;
  sort?: number;
  rampText?: string | null;
  // true stamps retired_at (kept if already retired); false clears it.
  retired?: boolean;
}

export interface DayNote {
  date: string;
  line: string;
  updatedAt: Date;
}

// One day's "what I learned" entry.
export interface Learned {
  date: string;
  text: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LearnedQuery {
  from?: string;
  to?: string;
  // Case-insensitive substring of the text.
  q?: string;
  limit: number;
  offset: number;
}

export interface ImportReport {
  // Checks that did not exist before this call.
  inserted: number;
  // Checks the log named that were already stored — what makes a re-run a no-op.
  alreadyPresent: number;
  // Slugs in the log that match no habit, sorted. Their checks were ignored.
  unknownSlugs: string[];
}

// A gathered AI Wire story, as stored: the candidate plus when it was last
// fetched and the day it was served (null = never).
export interface StoredCandidate extends Candidate {
  fetchedAt: Date;
  servedOn: string | null;
}

// The day's AI Wire article. Every device reads the same row.
export interface DailyArticle {
  date: string;
  url: string;
  title: string;
  source: string;
  publishedAt: Date;
  excerpt: string | null;
  urlHash: string;
  titleHash: string;
  // The topic tags it matched when chosen, main one first ([] for rows from
  // before topics were recorded).
  topics: string[];
  // The config id of its source (null for rows from before it was recorded).
  sourceId: string | null;
  readAt: Date | null;
}

// An article passed over with Next: kept so the dry-run report can show which
// sources keep missing. Nothing re-weights on it.
export interface WireDud {
  date: string;
  urlHash: string;
  title: string;
  sourceId: string | null;
  source: string;
  // The main tier tag it had ("Claude Code"), if any.
  tier: string | null;
  createdAt: Date;
}

export class DuplicateSlugError extends Error {
  constructor(slug: string) {
    super(`slug already exists: ${slug}`);
    this.name = 'DuplicateSlugError';
  }
}

export interface SettingsStore {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
}

export interface Store extends SettingsStore {
  // Ordered by sort, then id.
  listHabits(opts: { includeRetired: boolean }): Promise<Habit[]>;
  getHabit(id: number): Promise<Habit | null>;
  // Throws DuplicateSlugError.
  createHabit(h: NewHabit): Promise<Habit>;
  // Null when the id does not exist.
  updateHabit(id: number, patch: HabitPatch): Promise<Habit | null>;

  // The habit follows `schedule` from `from` on; spans starting on or after
  // `from` are replaced (withSchedule). Null when the id does not exist.
  setSchedule(id: number, schedule: Schedule, from: string): Promise<Habit | null>;

  // Both idempotent. Neither checks that the habit exists or is active; the
  // routes own those rules.
  addCheck(habitId: number, date: string): Promise<void>;
  removeCheck(habitId: number, date: string): Promise<void>;
  // Every checked date per habit, ascending. A habit with none maps to [].
  checkDates(habitIds: number[]): Promise<Map<number, string[]>>;

  getNote(date: string): Promise<DayNote | null>;
  // Inclusive bounds, either optional. Ascending by date.
  listNotes(range: { from?: string; to?: string }): Promise<DayNote[]>;
  putNote(date: string, line: string): Promise<DayNote>;
  deleteNote(date: string): Promise<void>;

  getLearned(date: string): Promise<Learned | null>;
  // Newest first, one page, with the total that match.
  listLearned(query: LearnedQuery): Promise<{ entries: Learned[]; total: number }>;
  putLearned(date: string, text: string): Promise<Learned>;
  deleteLearned(date: string): Promise<void>;

  // ── AI Wire ──
  // Insert or refresh by urlHash: a known story gets the new fetchedAt, the
  // higher points and an excerpt if it had none; its title, source and
  // servedOn never change.
  upsertWireCandidates(list: Candidate[], fetchedAt: Date): Promise<void>;
  // Never-served candidates fetched at or after `since`.
  wirePool(since: Date): Promise<StoredCandidate[]>;
  // Title hashes of every candidate ever served.
  wireServedTitleHashes(): Promise<Set<string>>;
  // Stamps servedOn (kept if already set).
  markWireServed(urlHash: string, date: string): Promise<void>;
  // Drops never-served candidates fetched before `before`. Served ones are
  // kept forever: they are what stops a repeat.
  pruneWireCandidates(before: Date): Promise<void>;

  getDailyArticle(date: string): Promise<DailyArticle | null>;
  // Inclusive bounds, newest first.
  listDailyArticles(from: string, to: string): Promise<DailyArticle[]>;
  // False (and nothing written) when the day already has one.
  insertDailyArticle(a: Omit<DailyArticle, 'readAt'>): Promise<boolean>;
  // Replaces the day's article only if it is still `expectedUrlHash`; false otherwise.
  replaceDailyArticle(expectedUrlHash: string, a: Omit<DailyArticle, 'readAt'>): Promise<boolean>;
  // Stamps readAt (kept if already set). Null when the day has no article.
  markArticleRead(date: string): Promise<DailyArticle | null>;
  recordWireDud(d: Omit<WireDud, 'createdAt'>): Promise<void>;
  // Duds on or after `since`, newest first.
  listWireDuds(since: string): Promise<WireDud[]>;

  // { date: [slug, ...] } → checks, matched by slug (retired habits included),
  // in one transaction: either every known check lands or none does.
  importChecks(log: Record<string, string[]>): Promise<ImportReport>;
}
