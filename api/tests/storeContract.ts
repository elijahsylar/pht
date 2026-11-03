import { beforeEach, describe, expect, it } from 'vitest';
import { DuplicateSlugError, type Store } from '../src/db/store.js';

// One behaviour suite for the Store interface, run against the in-memory fake
// (always) and against MySQL (opt-in, tests/integration). The route tests only
// ever see the fake, so this is what makes passing them mean something about
// the real SQL: both implementations have to satisfy the same assertions.
//
// `makeStore` must return a store with the six seeded habits and nothing else.
export function storeContract(name: string, makeStore: () => Promise<Store>): void {
  describe(`Store contract: ${name}`, () => {
    let store: Store;
    let stretch: number;
    let read: number;

    beforeEach(async () => {
      store = await makeStore();
      const habits = await store.listHabits({ includeRetired: true });
      stretch = habits.find((h) => h.slug === 'stretch')!.id;
      read = habits.find((h) => h.slug === 'read')!.id;
    });

    it('lists the seeded habits in order', async () => {
      const habits = await store.listHabits({ includeRetired: false });
      expect(habits.map((h) => h.slug)).toEqual([
        'stretch',
        'read',
        'water',
        'journal',
        'plan',
        'tidy',
      ]);
      expect(habits.map((h) => h.label)).toEqual([
        'Stretch',
        'Read 20 minutes',
        'Drink water',
        'Journal',
        'Plan tomorrow',
        'Tidy up',
      ]);
      expect(habits.map((h) => h.sort)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(habits.every((h) => h.rampText === null && h.retiredAt === null)).toBe(true);
      // A real, recent instant — not a zone-shifted one.
      expect(Math.abs(habits[0].createdAt.getTime() - Date.now())).toBeLessThan(120_000);
    });

    it('creates a habit after the existing ones and rejects a duplicate slug', async () => {
      const made = await store.createHabit({ slug: 'yoga', label: 'Yoga', rampText: null });
      expect(made).toMatchObject({ slug: 'yoga', label: 'Yoga', sort: 7, rampText: null });
      expect(await store.getHabit(made.id)).toMatchObject({ slug: 'yoga' });

      const placed = await store.createHabit({
        slug: 'floss',
        label: 'Floss',
        sort: 0,
        rampText: '  kept as given ',
      });
      expect(placed.sort).toBe(0);
      expect(placed.rampText).toBe('  kept as given ');
      expect((await store.listHabits({ includeRetired: false }))[0].slug).toBe('floss');

      await expect(
        store.createHabit({ slug: 'stretch', label: 'Again', rampText: null }),
      ).rejects.toBeInstanceOf(DuplicateSlugError);
    });

    it('updates fields, and leaves the ones not named alone', async () => {
      const a = await store.updateHabit(stretch, { label: 'Stretch 10 min', rampText: 'then 15' });
      expect(a).toMatchObject({ label: 'Stretch 10 min', rampText: 'then 15', sort: 1 });
      const b = await store.updateHabit(stretch, { sort: 9 });
      expect(b).toMatchObject({ label: 'Stretch 10 min', rampText: 'then 15', sort: 9 });
      const c = await store.updateHabit(stretch, { rampText: null });
      expect(c?.rampText).toBeNull();
      expect(await store.updateHabit(999_999, { label: 'x' })).toBeNull();
      expect(await store.getHabit(999_999)).toBeNull();
    });

    it('retires and unretires, keeping the first retired_at', async () => {
      const first = await store.updateHabit(stretch, { retired: true });
      expect(first?.retiredAt).toBeInstanceOf(Date);
      const again = await store.updateHabit(stretch, { retired: true });
      expect(again?.retiredAt?.getTime()).toBe(first?.retiredAt?.getTime());

      expect((await store.listHabits({ includeRetired: false })).map((h) => h.slug)).not.toContain(
        'stretch',
      );
      expect((await store.listHabits({ includeRetired: true })).map((h) => h.slug)).toContain(
        'stretch',
      );

      const back = await store.updateHabit(stretch, { retired: false });
      expect(back?.retiredAt).toBeNull();
    });

    it('starts every habit daily and keeps a schedule timeline', async () => {
      const fresh = await store.getHabit(stretch);
      expect(fresh?.schedule).toEqual({ kind: 'daily' });
      expect(fresh?.schedules).toEqual([{ from: null, schedule: { kind: 'daily' } }]);

      const mwf = { kind: 'weekdays' as const, days: [1, 3, 5] };
      const eod = { kind: 'every_other_day' as const, anchor: '2026-10-12' };
      await store.setSchedule(stretch, mwf, '2026-10-01');
      const after = await store.setSchedule(stretch, eod, '2026-10-12');
      expect(after?.schedule).toEqual(eod);
      expect(after?.schedules).toEqual([
        { from: null, schedule: { kind: 'daily' } },
        { from: '2026-10-01', schedule: mwf },
        { from: '2026-10-12', schedule: eod },
      ]);
      // Same day again replaces that day's change; an earlier day drops later ones.
      await store.setSchedule(stretch, { kind: 'daily' }, '2026-10-12');
      const back = await store.setSchedule(stretch, { kind: 'weekdays', days: [0, 6] }, '2026-10-05');
      expect(back?.schedules).toEqual([
        { from: null, schedule: { kind: 'daily' } },
        { from: '2026-10-01', schedule: mwf },
        { from: '2026-10-05', schedule: { kind: 'weekdays', days: [0, 6] } },
      ]);
      // Other fields untouched, listHabits agrees, other habits unaffected.
      expect(back).toMatchObject({ slug: 'stretch', label: 'Stretch', sort: 1 });
      const listed = await store.listHabits({ includeRetired: false });
      expect(listed[0].schedules).toEqual(back?.schedules);
      expect(listed[1].schedule).toEqual({ kind: 'daily' });
      expect(await store.setSchedule(999_999, mwf, '2026-10-01')).toBeNull();
    });

    it('checks and unchecks idempotently', async () => {
      await store.addCheck(stretch, '2026-10-13');
      await store.addCheck(stretch, '2026-10-13');
      await store.addCheck(stretch, '2026-10-11');
      await store.addCheck(read, '2026-10-12');
      const dates = await store.checkDates([stretch, read]);
      expect(dates.get(stretch)).toEqual(['2026-10-11', '2026-10-13']);
      expect(dates.get(read)).toEqual(['2026-10-12']);

      await store.removeCheck(stretch, '2026-10-13');
      await store.removeCheck(stretch, '2026-10-13');
      await store.removeCheck(stretch, '2020-01-01');
      expect((await store.checkDates([stretch])).get(stretch)).toEqual(['2026-10-11']);
    });

    it('returns an empty list for a habit with no checks, and for no habits', async () => {
      expect((await store.checkDates([stretch])).get(stretch)).toEqual([]);
      expect((await store.checkDates([])).size).toBe(0);
    });

    it('stores one note per day and lists a range inclusively', async () => {
      expect(await store.getNote('2026-10-13')).toBeNull();
      await store.putNote('2026-10-11', 'first');
      await store.putNote('2026-10-12', 'second');
      const put = await store.putNote('2026-10-13', 'third — ünïcödé 🌊');
      expect(put).toMatchObject({ date: '2026-10-13', line: 'third — ünïcödé 🌊' });
      expect(put.updatedAt).toBeInstanceOf(Date);

      await store.putNote('2026-10-12', 'second, edited');
      expect((await store.getNote('2026-10-12'))?.line).toBe('second, edited');

      const all = await store.listNotes({});
      expect(all.map((n) => n.date)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13']);
      const mid = await store.listNotes({ from: '2026-10-12', to: '2026-10-12' });
      expect(mid.map((n) => n.line)).toEqual(['second, edited']);
      expect((await store.listNotes({ from: '2026-10-12' })).length).toBe(2);
      expect((await store.listNotes({ to: '2026-10-11' })).length).toBe(1);

      await store.deleteNote('2026-10-12');
      await store.deleteNote('2026-10-12');
      expect(await store.getNote('2026-10-12')).toBeNull();
    });

    it('imports by slug, reports unknown slugs, and is idempotent', async () => {
      await store.addCheck(stretch, '2026-09-01');
      const log = {
        '2026-09-01': ['stretch', 'read', 'nope'],
        '2026-09-02': ['stretch', 'stretch', 'also-nope'],
        '2026-09-03': [],
      };
      expect(await store.importChecks(log)).toEqual({
        inserted: 2,
        alreadyPresent: 1,
        unknownSlugs: ['also-nope', 'nope'],
      });
      expect(await store.importChecks(log)).toEqual({
        inserted: 0,
        alreadyPresent: 3,
        unknownSlugs: ['also-nope', 'nope'],
      });
      const dates = await store.checkDates([stretch, read]);
      expect(dates.get(stretch)).toEqual(['2026-09-01', '2026-09-02']);
      expect(dates.get(read)).toEqual(['2026-09-01']);
    });

    it('imports into a retired habit and handles an empty log', async () => {
      await store.updateHabit(stretch, { retired: true });
      expect(await store.importChecks({ '2026-08-01': ['stretch'] })).toEqual({
        inserted: 1,
        alreadyPresent: 0,
        unknownSlugs: [],
      });
      expect(await store.importChecks({})).toEqual({
        inserted: 0,
        alreadyPresent: 0,
        unknownSlugs: [],
      });
    });

    it('keeps AI Wire candidates: upsert merges, served ones leave the pool, prune spares them', async () => {
      const t0 = new Date('2026-10-13T10:00:00Z');
      const t1 = new Date('2026-10-14T10:00:00Z');
      const cand = (n: number, points: number | null, excerpt: string | null) => ({
        url: `https://lab.test/${n}`,
        canonicalUrl: `https://lab.test/${n}`,
        urlHash: `${'a'.repeat(63)}${n}`,
        title: `Story ${n} — ünïcödé`,
        titleHash: `${'b'.repeat(63)}${n}`,
        source: 'Test Lab',
        sourceId: 'lab',
        publishedAt: new Date('2026-10-12T08:30:00Z'),
        excerpt,
        points,
      });
      await store.upsertWireCandidates([cand(1, 100, null), cand(2, null, 'two')], t0);
      await store.upsertWireCandidates([cand(1, 80, 'one'), cand(2, 5, 'other')], t1);
      const pool = (await store.wirePool(t0)).sort((a, b) => a.urlHash.localeCompare(b.urlHash));
      expect(pool.map((c) => [c.points, c.excerpt, c.fetchedAt.toISOString()])).toEqual([
        [100, 'one', t1.toISOString()],
        [5, 'two', t1.toISOString()],
      ]);
      expect(pool[0]).toMatchObject({ title: 'Story 1 — ünïcödé', sourceId: 'lab', servedOn: null });
      expect(pool[0].publishedAt.toISOString()).toBe('2026-10-12T08:30:00.000Z');
      expect(await store.wirePool(new Date('2026-10-15T00:00:00Z'))).toEqual([]);

      await store.markWireServed(cand(1, 0, null).urlHash, '2026-10-14');
      await store.markWireServed(cand(1, 0, null).urlHash, '2026-10-15');
      expect((await store.wirePool(t0)).map((c) => c.urlHash)).toEqual([cand(2, 0, null).urlHash]);
      expect([...(await store.wireServedTitleHashes())]).toEqual([cand(1, 0, null).titleHash]);
      await store.pruneWireCandidates(new Date('2026-10-20T00:00:00Z'));
      expect(await store.wirePool(t0)).toEqual([]);
      // The served one survives the prune.
      expect([...(await store.wireServedTitleHashes())]).toEqual([cand(1, 0, null).titleHash]);
    });

    it('keeps one AI Wire article per day', async () => {
      const art = (n: number, date: string) => ({
        date,
        url: `https://lab.test/${n}`,
        title: `Story ${n}`,
        source: 'Test Lab',
        publishedAt: new Date('2026-10-12T08:30:00Z'),
        excerpt: n === 1 ? null : 'An excerpt.',
        urlHash: `u${n}`,
        titleHash: `t${n}`,
        topics: n === 3 ? ['Anthropic', 'AI engineering'] : ['Claude Code'],
        sourceId: n === 3 ? null : 'lab',
      });
      expect(await store.getDailyArticle('2026-10-13')).toBeNull();
      expect(await store.insertDailyArticle(art(1, '2026-10-13'))).toBe(true);
      expect(await store.insertDailyArticle(art(2, '2026-10-13'))).toBe(false);
      expect(await store.getDailyArticle('2026-10-13')).toMatchObject({ title: 'Story 1', readAt: null, topics: ['Claude Code'], sourceId: 'lab' });

      const read = await store.markArticleRead('2026-10-13');
      expect(read?.readAt).toBeInstanceOf(Date);
      expect(await store.markArticleRead('2026-01-01')).toBeNull();
      // Replace only over the expected one; a replacement is unread.
      expect(await store.replaceDailyArticle('nope', art(3, '2026-10-13'))).toBe(false);
      expect(await store.replaceDailyArticle('u1', art(3, '2026-10-13'))).toBe(true);
      expect(await store.getDailyArticle('2026-10-13')).toMatchObject({
        title: 'Story 3',
        readAt: null,
        excerpt: 'An excerpt.',
        topics: ['Anthropic', 'AI engineering'],
        sourceId: null,
      });

      await store.insertDailyArticle(art(4, '2026-10-11'));
      await store.insertDailyArticle(art(5, '2026-10-01'));
      expect((await store.listDailyArticles('2026-10-05', '2026-10-13')).map((a) => a.date)).toEqual([
        '2026-10-13',
        '2026-10-11',
      ]);
    });

    it('keeps one learned entry per day, lists newest first, searches and pages', async () => {
      expect(await store.getLearned('2026-10-13')).toBeNull();
      const a = await store.putLearned('2026-10-13', 'Rust borrows');
      expect(a).toMatchObject({ date: '2026-10-13', text: 'Rust borrows' });
      expect(a.createdAt).toBeInstanceOf(Date);
      await store.putLearned('2026-10-13', 'Rust lends');
      await store.putLearned('2026-10-12', 'Octopus: three hearts');
      await store.putLearned('2026-10-11', '50% off_peak');
      expect((await store.getLearned('2026-10-13'))?.text).toBe('Rust lends');
      const all = await store.listLearned({ limit: 50, offset: 0 });
      expect(all.total).toBe(3);
      expect(all.entries.map((e) => e.date)).toEqual(['2026-10-13', '2026-10-12', '2026-10-11']);
      expect((await store.listLearned({ q: 'RUST', limit: 50, offset: 0 })).entries.map((e) => e.text)).toEqual(['Rust lends']);
      expect((await store.listLearned({ q: '%', limit: 50, offset: 0 })).total).toBe(1);
      // _ is literal: "f_p" is in "off_peak", "o_f" (a wildcard would match "off") is not.
      expect((await store.listLearned({ q: 'f_p', limit: 50, offset: 0 })).total).toBe(1);
      expect((await store.listLearned({ q: 'o_f', limit: 50, offset: 0 })).total).toBe(0);
      const page = await store.listLearned({ limit: 1, offset: 1 });
      expect(page).toMatchObject({ total: 3, entries: [{ date: '2026-10-12' }] });
      expect((await store.listLearned({ from: '2026-10-12', to: '2026-10-12', limit: 50, offset: 0 })).total).toBe(1);
      await store.deleteLearned('2026-10-13');
      await store.deleteLearned('2026-10-13');
      expect(await store.getLearned('2026-10-13')).toBeNull();
    });

    it('records AI Wire duds and lists them newest first from a date', async () => {
      const dud = (n: number, date: string) => ({
        date,
        urlHash: `u${n}`,
        title: `Story ${n}`,
        sourceId: n === 2 ? null : 'lab',
        source: 'Test Lab',
        tier: n === 3 ? null : 'Claude Code',
      });
      await store.recordWireDud(dud(1, '2026-10-01'));
      await store.recordWireDud(dud(2, '2026-10-10'));
      await store.recordWireDud(dud(3, '2026-10-10'));
      const list = await store.listWireDuds('2026-10-05');
      expect(list.map((d) => [d.title, d.sourceId, d.tier])).toEqual([
        ['Story 3', 'lab', null],
        ['Story 2', null, 'Claude Code'],
      ]);
      expect(list[0].createdAt).toBeInstanceOf(Date);
      expect(await store.listWireDuds('2026-01-01')).toHaveLength(3);
    });

    it('reads and writes settings', async () => {
      expect(await store.getSetting('contract_probe')).toBeNull();
      await store.setSetting('contract_probe', 'a');
      await store.setSetting('contract_probe', 'b');
      expect(await store.getSetting('contract_probe')).toBe('b');
      await store.deleteSetting('contract_probe');
      expect(await store.getSetting('contract_probe')).toBeNull();
    });
  });
}
