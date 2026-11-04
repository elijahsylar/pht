import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addDays } from '../src/lib/dates.js';
import {
  DAILY,
  dayDiff,
  dueOn,
  isDue,
  scheduleAt,
  scheduleFromColumns,
  scheduleToColumns,
  weekday,
  withSchedule,
  type Schedule,
  type ScheduleSpan,
} from '../src/lib/schedule.js';
import { bestStreak, currentStreak, dueFlags, historyStats, summarize } from '../src/lib/streak.js';
import { TODAY, useApp } from './helpers.js';

// Dates used below: 2026-10-13 is a Tuesday (weekday 2).
const MWF: Schedule = { kind: 'weekdays', days: [1, 3, 5] };
const always = (s: Schedule): ScheduleSpan[] => [{ from: null, schedule: s }];
const set = (...d: string[]) => new Set(d);

describe('schedule model', () => {
  it('knows the weekday and the distance between days', () => {
    expect(weekday('2026-10-13')).toBe(2);
    expect(weekday('2026-10-18')).toBe(0);
    expect(dayDiff('2026-10-30', '2026-11-02')).toBe(3);
    expect(dayDiff('2026-11-02', '2026-10-30')).toBe(-3);
  });

  it('daily is due every day', () => {
    for (let i = 0; i < 10; i += 1) expect(isDue(DAILY, addDays(TODAY, i))).toBe(true);
  });

  it('every other day is due on the anchor and every second day, both directions', () => {
    const s: Schedule = { kind: 'every_other_day', anchor: '2026-10-13' };
    expect(isDue(s, '2026-10-13')).toBe(true);
    expect(isDue(s, '2026-10-14')).toBe(false);
    expect(isDue(s, '2026-10-15')).toBe(true);
    expect(isDue(s, '2026-10-12')).toBe(false);
    expect(isDue(s, '2026-10-11')).toBe(true);
  });

  it('every other day keeps its rhythm across month and year ends', () => {
    // Oct has 31 days: the 31st and Nov 2nd are due, Nov 1st is not.
    const oct: Schedule = { kind: 'every_other_day', anchor: '2026-10-29' };
    expect(['2026-10-31', '2026-11-01', '2026-11-02'].map((d) => isDue(oct, d))).toEqual([true, false, true]);
    const dec: Schedule = { kind: 'every_other_day', anchor: '2026-12-30' };
    expect(['2027-01-01', '2027-01-02'].map((d) => isDue(dec, d))).toEqual([true, false]);
    // A leap February: 2028-02-29 exists.
    const feb: Schedule = { kind: 'every_other_day', anchor: '2028-02-27' };
    expect(['2028-02-29', '2028-03-01', '2028-03-02'].map((d) => isDue(feb, d))).toEqual([true, false, true]);
  });

  it('weekdays are due on the listed days only', () => {
    // Mon 10-12 … Sun 10-18
    const week = Array.from({ length: 7 }, (_, i) => isDue(MWF, addDays('2026-10-12', i)));
    expect(week).toEqual([true, false, true, false, true, false, false]);
  });

  it('a schedule change applies from its day on, earlier days keep the old one', () => {
    const spans = withSchedule(always(DAILY), MWF, '2026-10-12');
    expect(spans).toEqual([
      { from: null, schedule: DAILY },
      { from: '2026-10-12', schedule: MWF },
    ]);
    expect(scheduleAt(spans, '2026-10-11')).toEqual(DAILY);
    expect(dueOn(spans, '2026-10-11')).toBe(true); // a Sunday, but daily then
    expect(dueOn(spans, '2026-10-18')).toBe(false); // a Sunday under MWF
    // Changing again on the same day replaces that day's change.
    const again = withSchedule(spans, { kind: 'weekdays', days: [0] }, '2026-10-12');
    expect(again).toHaveLength(2);
    expect(again[1].schedule).toEqual({ kind: 'weekdays', days: [0] });
    // Changing from an earlier day drops the later span.
    expect(withSchedule(spans, DAILY, '2026-10-01')).toEqual([
      { from: null, schedule: DAILY },
      { from: '2026-10-01', schedule: DAILY },
    ]);
  });

  it('round-trips through the DB columns, reading nonsense as daily', () => {
    for (const s of [DAILY, MWF, { kind: 'every_other_day', anchor: '2026-10-13' } as Schedule]) {
      expect(scheduleFromColumns(scheduleToColumns(s))).toEqual(s);
    }
    expect(scheduleToColumns({ kind: 'weekdays', days: [5, 1, 1] }).days).toBe('1,5');
    expect(scheduleFromColumns({ kind: 'weekdays', days: '', anchor: null })).toEqual(DAILY);
    expect(scheduleFromColumns({ kind: 'weekdays', days: '9,x', anchor: null })).toEqual(DAILY);
    expect(scheduleFromColumns({ kind: 'every_other_day', days: null, anchor: null })).toEqual(DAILY);
    expect(scheduleFromColumns({ kind: 'monthly', days: null, anchor: null })).toEqual(DAILY);
  });
});

describe('streaks across rest days', () => {
  it('daily: unchanged — a missed day breaks it', () => {
    const d = set('2026-10-13', '2026-10-12', '2026-10-10');
    expect(currentStreak(d, '2026-10-13', always(DAILY))).toBe(2);
    expect(currentStreak(d, '2026-10-13')).toBe(2);
    expect(bestStreak(d, always(DAILY))).toBe(2);
    // A last date whose next day no longer sorts after it (year 10000) must
    // end the walk, not throw from addDays.
    expect(bestStreak(new Set(['9999-12-30', '9999-12-31']), always(DAILY))).toBe(2);
  });

  it('every other day: rest days neither break nor extend it', () => {
    const eod = always({ kind: 'every_other_day', anchor: '2026-10-01' });
    // Due: 10-01, 03, 05, 07, 09, 11, 13. Checked on every due day from the 7th.
    const d = set('2026-10-07', '2026-10-09', '2026-10-11', '2026-10-13');
    expect(currentStreak(d, '2026-10-13', eod)).toBe(4);
    // A check on a rest day (the 12th) changes nothing.
    expect(currentStreak(new Set([...d, '2026-10-12']), '2026-10-13', eod)).toBe(4);
    expect(bestStreak(new Set([...d, '2026-10-12', '2026-10-10']), eod)).toBe(4);
    // Today (the 14th) is a rest day: the streak still stands at 4.
    expect(currentStreak(d, '2026-10-14', eod)).toBe(4);
    // The 15th is due and not done yet: still 4. The 16th: the 15th was missed.
    expect(currentStreak(d, '2026-10-15', eod)).toBe(4);
    expect(currentStreak(d, '2026-10-16', eod)).toBe(0);
    // Missing the 9th breaks it.
    const gap = set('2026-10-07', '2026-10-11', '2026-10-13');
    expect(currentStreak(gap, '2026-10-13', eod)).toBe(2);
    expect(bestStreak(gap, eod)).toBe(2);
  });

  it('weekdays: a weekend off never breaks a Mon/Wed/Fri run', () => {
    const spans = always(MWF);
    // Fri 10-02, Mon 10-05, Wed 10-07, Fri 10-09, Mon 10-12
    const d = set('2026-10-02', '2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12');
    expect(currentStreak(d, '2026-10-13', spans)).toBe(5); // Tue: rest
    expect(currentStreak(d, '2026-10-14', spans)).toBe(5); // Wed: due, not yet
    expect(currentStreak(d, '2026-10-15', spans)).toBe(0); // Wed was missed
    expect(currentStreak(new Set([...d, '2026-10-14']), '2026-10-14', spans)).toBe(6);
    // A Saturday check is recorded but counts for nothing.
    const sat = new Set([...d, '2026-10-10']);
    expect(currentStreak(sat, '2026-10-12', spans)).toBe(5);
    expect(summarize(sat, '2026-10-13', spans)).toMatchObject({ streak: 5, best: 5, totalDone: 6, due: false });
  });

  it('a rest-day check alone makes no streak', () => {
    expect(currentStreak(set('2026-10-13'), '2026-10-13', always(MWF))).toBe(0);
    expect(bestStreak(set('2026-10-13', '2026-10-10'), always(MWF))).toBe(0);
  });

  it('a schedule change mid-history: old days judged by the old schedule', () => {
    // Daily until Sun 10-11, MWF from Mon 10-12.
    const spans = withSchedule(always(DAILY), MWF, '2026-10-12');
    // Daily run Thu 10-08 … Sun 10-11 (4 days), then Mon 10-12, Wed 10-14.
    const d = set('2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-14');
    expect(currentStreak(d, '2026-10-14', spans)).toBe(6);
    expect(bestStreak(d, spans)).toBe(6);
    // Under daily the Saturday was due: without it the run before the change breaks.
    const noSat = set('2026-10-08', '2026-10-09', '2026-10-11', '2026-10-12', '2026-10-14');
    expect(currentStreak(noSat, '2026-10-14', spans)).toBe(3);
    // Had MWF applied all along, the missing Saturday would not matter: with
    // Wed 10-07 too, the run is Wed 07, Fri 09, Mon 12, Wed 14.
    const withWed = new Set([...noSat, '2026-10-07']);
    expect(currentStreak(withWed, '2026-10-14', always(MWF))).toBe(4);
    expect(currentStreak(withWed, '2026-10-14', spans)).toBe(3);
  });

  it('crosses a month boundary', () => {
    const eod = always({ kind: 'every_other_day', anchor: '2026-10-27' });
    const d = set('2026-10-27', '2026-10-29', '2026-10-31', '2026-11-02');
    expect(currentStreak(d, '2026-11-02', eod)).toBe(4);
    expect(currentStreak(d, '2026-11-03', eod)).toBe(4); // rest day
    const wk = always({ kind: 'weekdays', days: [6] }); // Saturdays
    expect(currentStreak(set('2026-10-24', '2026-10-31', '2026-11-07'), '2026-11-08', wk)).toBe(3);
  });
});

describe('due flags and the 30-day stats', () => {
  it('flags due days oldest first', () => {
    expect(dueFlags(always(MWF), '2026-10-14', 3)).toEqual([true, false, true]);
  });

  it('count only due cells, and all-done days need something due', () => {
    // Two habits over Mon–Wed; B rests on Tuesday.
    const rows = [
      [true, true, false],
      [true, true, true],
    ];
    const due = [
      [true, true, true],
      [true, false, true],
    ];
    // Due cells: 5; checked due cells: A Mon, A Tue, B Mon, B Wed = 4 → 80%.
    // All done: Mon (both), Tue (A, the only one due); Wed A missed.
    expect(historyStats(rows, [0, 1], due)).toEqual({ completionPct: 80, bestLiveStreak: 1, allDoneDays: 2 });
    // A day where nothing is due is not an all-done day.
    expect(historyStats([[false]], [0], [[false]])).toEqual({ completionPct: 0, bestLiveStreak: 0, allDoneDays: 0 });
  });
});

describe('schedules over the API', () => {
  const ctx = useApp();
  const patch = (path: string, body: object) => request(ctx.app).patch(path).set(ctx.jwt).send(body);
  const get = (path: string) => request(ctx.app).get(path).set(ctx.jwt);
  const put = (path: string) => request(ctx.app).put(path).set(ctx.jwt);

  it('every existing habit is daily', async () => {
    const res = await get('/api/habits');
    expect(res.body.every((h: { schedule: Schedule }) => h.schedule.kind === 'daily')).toBe(true);
  });

  it('sets a schedule from the client day, and /today marks rest days', async () => {
    const res = await patch(`/api/habits/${ctx.id.stretch}`, { schedule: MWF, scheduleFrom: '2026-10-01' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schedule: MWF, scheduleFrom: '2026-10-01' });

    const today = await get(`/api/today?date=${TODAY}`); // Tuesday
    const stretch = today.body.habits.find((h: { slug: string }) => h.slug === 'stretch');
    expect(stretch).toMatchObject({ due: false, schedule: MWF });
    expect(today.body).toMatchObject({ total: 6, dueCount: 5, dueDone: 0 });

    const wed = await get('/api/today?date=2026-10-14');
    expect(wed.body.habits[0]).toMatchObject({ slug: 'stretch', due: true });
  });

  it('a check on a rest day is recorded but leaves the streak alone', async () => {
    await patch(`/api/habits/${ctx.id.stretch}`, { schedule: MWF, scheduleFrom: '2026-10-01' });
    await put(`/api/checks/${ctx.id.stretch}/2026-10-12`); // Mon
    const rest = await put(`/api/checks/${ctx.id.stretch}/${TODAY}`); // Tue
    expect(rest.status).toBe(200);
    const res = await get(`/api/today?date=${TODAY}`);
    expect(res.body.habits[0]).toMatchObject({ done: true, due: false, streak: 1, totalDone: 2 });
    expect(res.body).toMatchObject({ doneCount: 1, dueDone: 0 });
  });

  it('backfilling a missed due day bridges the streak; a rest day does not', async () => {
    await patch(`/api/habits/${ctx.id.stretch}`, { schedule: MWF, scheduleFrom: '2026-09-01' });
    // Fri 10-02, (Mon 10-05 missed), Wed 10-07, Fri 10-09, Mon 10-12
    for (const d of ['2026-10-02', '2026-10-07', '2026-10-09', '2026-10-12']) await put(`/api/checks/${ctx.id.stretch}/${d}`);
    const streakOf = async () => (await get(`/api/today?date=${TODAY}`)).body.habits[0].streak;
    expect(await streakOf()).toBe(3);
    await put(`/api/checks/${ctx.id.stretch}/2026-10-03`); // a Saturday: rest
    expect(await streakOf()).toBe(3);
    await put(`/api/checks/${ctx.id.stretch}/2026-10-05`); // the missed Monday
    expect(await streakOf()).toBe(5);
    expect((await get(`/api/today?date=${TODAY}`)).body.habits[0].best).toBe(5);
  });

  it('History carries due flags and counts only due days', async () => {
    await patch(`/api/habits/${ctx.id.stretch}`, { schedule: MWF, scheduleFrom: '2026-09-01' });
    const res = await get(`/api/history?date=${TODAY}&days=7`);
    // 10-07 Wed … 10-13 Tue
    expect(res.body.habits[0].due).toEqual([true, false, true, false, false, true, false]);
    expect(res.body.habits[1].due).toEqual(Array(7).fill(true));
    // Only stretch checks, on its due days: 3 of 3 + 5×7 = 38 due cells → 8%.
    for (const d of ['2026-10-07', '2026-10-09', '2026-10-12']) await ctx.store.addCheck(ctx.id.stretch, d);
    // A rest-day check is not counted.
    await ctx.store.addCheck(ctx.id.stretch, '2026-10-10');
    const again = await get(`/api/history?date=${TODAY}&days=7`);
    expect(again.body.stats.completionPct).toBe(Math.round((3 / 38) * 100));
    expect(again.body.habits[0].streak).toBe(3);
  });

  it('a mid-history change keeps old days on the old schedule', async () => {
    // Daily until 10-11; from Mon 10-12 every other day anchored there.
    for (const d of ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']) await ctx.store.addCheck(ctx.id.read, d);
    await patch(`/api/habits/${ctx.id.read}`, {
      schedule: { kind: 'every_other_day', anchor: '2026-10-12' },
      scheduleFrom: '2026-10-12',
    });
    const res = await get(`/api/today?date=${TODAY}`);
    const read = res.body.habits.find((h: { slug: string }) => h.slug === 'read');
    // 10-13 is a rest day; the run is 09, 10, 11 (daily) + 12 (due) = 4.
    expect(read).toMatchObject({ due: false, streak: 4, best: 4 });
    const habit = (await get('/api/habits')).body.find((h: { slug: string }) => h.slug === 'read');
    expect(habit.scheduleFrom).toBe('2026-10-12');
  });

  it('defaults scheduleFrom to today in the app timezone', async () => {
    const res = await patch(`/api/habits/${ctx.id.stretch}`, { schedule: MWF });
    expect(res.body.scheduleFrom).toBe(TODAY);
  });

  it('rejects a bad schedule', async () => {
    const bad = [
      { schedule: { kind: 'weekdays', days: [] } },
      { schedule: { kind: 'weekdays', days: [7] } },
      { schedule: { kind: 'every_other_day' } },
      { schedule: { kind: 'every_other_day', anchor: '2026-02-31' } },
      { schedule: { kind: 'monthly' } },
      { schedule: { kind: 'daily', extra: 1 } },
      { scheduleFrom: TODAY },
    ];
    for (const body of bad) expect((await patch(`/api/habits/${ctx.id.stretch}`, body)).status).toBe(400);
    expect((await patch('/api/habits/9999', { schedule: MWF })).status).toBe(404);
  });

  it('is JWT-only, like every habit write', async () => {
    const token = await ctx.issueApiToken();
    const res = await request(ctx.app)
      .patch(`/api/habits/${ctx.id.stretch}`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ schedule: MWF });
    expect(res.status).toBe(403);
  });
});
