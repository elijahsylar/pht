import {
  DuplicateSlugError,
  type DailyArticle,
  type DayNote,
  type Learned,
  type WireDud,
  type Habit,
  type Store,
  type StoredCandidate,
} from '../src/db/store.js';
import { SEED_HABITS } from '../src/db/schema.js';
import { DAILY, withSchedule } from '../src/lib/schedule.js';

// In-memory Store for the route tests. Typed as Store, so a method added to
// or changed in src/db/store.ts stops `npm test` at the tsc step until this
// file follows. Its behaviour is held to the real one by tests/storeContract.ts.

export interface FakeStore extends Store {
  // Test-only: place a habit's creation at a chosen instant.
  setCreatedAt(id: number, at: Date): void;
}

export function createFakeStore(opts: { seed?: boolean } = {}): FakeStore {
  const settings = new Map<string, string>();
  const habits: Habit[] = [];
  const checks = new Map<number, Set<string>>();
  const notes = new Map<string, DayNote>();
  const learned = new Map<string, Learned>();
  const duds: WireDud[] = [];
  const wire = new Map<string, StoredCandidate>();
  const articles = new Map<string, DailyArticle>();
  let nextId = 1;

  const clone = (h: Habit): Habit => ({
    ...h,
    schedules: h.schedules.map((s) => ({ ...s })),
  });
  const find = (id: number) => habits.find((h) => h.id === id) ?? null;

  function insert(slug: string, label: string, sort: number | undefined, rampText: string | null) {
    if (habits.some((h) => h.slug === slug)) throw new DuplicateSlugError(slug);
    const habit: Habit = {
      id: nextId++,
      slug,
      label,
      sort: sort ?? habits.reduce((m, h) => Math.max(m, h.sort), 0) + 1,
      rampText,
      createdAt: new Date(),
      retiredAt: null,
      schedule: DAILY,
      schedules: [{ from: null, schedule: DAILY }],
    };
    habits.push(habit);
    checks.set(habit.id, new Set());
    return habit;
  }

  if (opts.seed) SEED_HABITS.forEach((h, i) => insert(h.slug, h.label, i + 1, null));

  return {
    setCreatedAt(id, at) {
      const h = find(id);
      if (h) h.createdAt = at;
    },

    async getSetting(key) {
      return settings.get(key) ?? null;
    },
    async setSetting(key, value) {
      settings.set(key, value);
    },
    async deleteSetting(key) {
      settings.delete(key);
    },

    async listHabits({ includeRetired }) {
      return habits
        .filter((h) => includeRetired || !h.retiredAt)
        .sort((a, b) => a.sort - b.sort || a.id - b.id)
        .map(clone);
    },
    async getHabit(id) {
      const h = find(id);
      return h ? clone(h) : null;
    },
    async createHabit(h) {
      return clone(insert(h.slug, h.label, h.sort, h.rampText));
    },
    async updateHabit(id, patch) {
      const h = find(id);
      if (!h) return null;
      if (patch.label !== undefined) h.label = patch.label;
      if (patch.sort !== undefined) h.sort = patch.sort;
      if (patch.rampText !== undefined) h.rampText = patch.rampText;
      if (patch.retired === true) h.retiredAt ??= new Date();
      if (patch.retired === false) h.retiredAt = null;
      return clone(h);
    },

    async setSchedule(id, schedule, from) {
      const h = find(id);
      if (!h) return null;
      const spans = withSchedule(h.schedules, schedule, from);
      spans[0] = { ...spans[0], from: null };
      h.schedules = spans;
      h.schedule = spans[spans.length - 1].schedule;
      return clone(h);
    },

    async addCheck(habitId, date) {
      checks.get(habitId)?.add(date);
    },
    async removeCheck(habitId, date) {
      checks.get(habitId)?.delete(date);
    },
    async checkDates(habitIds) {
      return new Map(habitIds.map((id) => [id, [...(checks.get(id) ?? [])].sort()]));
    },

    async getNote(date) {
      const n = notes.get(date);
      return n ? { ...n } : null;
    },
    async listNotes({ from, to }) {
      return [...notes.values()]
        .filter((n) => (!from || n.date >= from) && (!to || n.date <= to))
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((n) => ({ ...n }));
    },
    async putNote(date, line) {
      const note = { date, line, updatedAt: new Date() };
      notes.set(date, note);
      return { ...note };
    },
    async deleteNote(date) {
      notes.delete(date);
    },

    async getLearned(date) {
      const l = learned.get(date);
      return l ? { ...l } : null;
    },
    async listLearned({ from, to, q, limit, offset }) {
      const needle = q?.toLowerCase();
      const all = [...learned.values()]
        .filter((l) => (!from || l.date >= from) && (!to || l.date <= to) && (!needle || l.text.toLowerCase().includes(needle)))
        .sort((a, b) => b.date.localeCompare(a.date));
      return { entries: all.slice(offset, offset + limit).map((l) => ({ ...l })), total: all.length };
    },
    async putLearned(date, text) {
      const now = new Date();
      const l = { date, text, createdAt: learned.get(date)?.createdAt ?? now, updatedAt: now };
      learned.set(date, l);
      return { ...l };
    },
    async deleteLearned(date) {
      learned.delete(date);
    },

    async upsertWireCandidates(list, fetchedAt) {
      for (const c of list) {
        const old = wire.get(c.urlHash);
        if (!old) {
          wire.set(c.urlHash, { ...c, fetchedAt, servedOn: null });
          continue;
        }
        old.fetchedAt = new Date(Math.max(old.fetchedAt.getTime(), fetchedAt.getTime()));
        if (c.points !== null) old.points = old.points === null ? c.points : Math.max(old.points, c.points);
        old.excerpt ??= c.excerpt;
      }
    },
    async wirePool(since) {
      return [...wire.values()]
        .filter((c) => c.servedOn === null && c.fetchedAt >= since)
        .map((c) => ({ ...c }));
    },
    async wireServedTitleHashes() {
      return new Set([...wire.values()].filter((c) => c.servedOn).map((c) => c.titleHash));
    },
    async markWireServed(urlHash, date) {
      const c = wire.get(urlHash);
      if (c) c.servedOn ??= date;
    },
    async pruneWireCandidates(before) {
      for (const [k, c] of wire) if (c.servedOn === null && c.fetchedAt < before) wire.delete(k);
    },
    async getDailyArticle(date) {
      const a = articles.get(date);
      return a ? { ...a } : null;
    },
    async listDailyArticles(from, to) {
      return [...articles.values()]
        .filter((a) => a.date >= from && a.date <= to)
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((a) => ({ ...a }));
    },
    async insertDailyArticle(a) {
      if (articles.has(a.date)) return false;
      articles.set(a.date, { ...a, topics: [...a.topics], readAt: null });
      return true;
    },
    async replaceDailyArticle(expected, a) {
      if (articles.get(a.date)?.urlHash !== expected) return false;
      articles.set(a.date, { ...a, topics: [...a.topics], readAt: null });
      return true;
    },
    async markArticleRead(date) {
      const a = articles.get(date);
      if (!a) return null;
      a.readAt ??= new Date();
      return { ...a };
    },

    async recordWireDud(d) {
      duds.push({ ...d, createdAt: new Date() });
    },
    async listWireDuds(since) {
      return duds.filter((d) => d.date >= since).reverse().map((d) => ({ ...d }));
    },

    async importChecks(log) {
      const idBySlug = new Map(habits.map((h) => [h.slug, h.id]));
      const unknown = new Set<string>();
      const pairs = new Map<string, [number, string]>();
      for (const [date, slugs] of Object.entries(log)) {
        for (const slug of slugs) {
          const id = idBySlug.get(slug);
          if (id === undefined) unknown.add(slug);
          else pairs.set(`${id}|${date}`, [id, date]);
        }
      }
      let inserted = 0;
      for (const [id, date] of pairs.values()) {
        const set = checks.get(id) as Set<string>;
        if (!set.has(date)) {
          set.add(date);
          inserted += 1;
        }
      }
      return {
        inserted,
        alreadyPresent: pairs.size - inserted,
        unknownSlugs: [...unknown].sort(),
      };
    },
  };
}
