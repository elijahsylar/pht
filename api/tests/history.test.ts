import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addDays } from '../src/lib/dates.js';
import { historyStats } from '../src/lib/streak.js';
import { TODAY, useApp } from './helpers.js';

const ctx = useApp();
const get = (path: string) => request(ctx.app).get(path).set(ctx.jwt);

describe('historyStats', () => {
  it('is all zeros with no habits', () => {
    expect(historyStats([], [])).toEqual({ completionPct: 0, bestLiveStreak: 0, allDoneDays: 0 });
  });

  it('counts checked cells, the best live streak and the all-done days', () => {
    const rows = [
      [true, true, false, true],
      [true, false, false, true],
      [true, true, true, true],
    ];
    // 9 of 12 cells; days 0 and 3 have every habit.
    expect(historyStats(rows, [2, 1, 9])).toEqual({ completionPct: 75, bestLiveStreak: 9, allDoneDays: 2 });
  });

  it('rounds the percent', () => {
    expect(historyStats([[true, false, false]], [0]).completionPct).toBe(33);
    expect(historyStats([[true, true, false]], [0]).completionPct).toBe(67);
  });
});

describe('GET /api/history', () => {
  it('returns 30 days ending at the date, one row per active habit, in order', async () => {
    const res = await get(`/api/history?date=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.body.start).toBe(addDays(TODAY, -29));
    expect(res.body.end).toBe(TODAY);
    expect(res.body.dates).toHaveLength(30);
    expect(res.body.dates[29]).toBe(TODAY);
    expect(res.body.habits.map((h: { slug: string }) => h.slug)).toEqual([
      'stretch',
      'read',
      'water',
      'journal',
      'plan',
      'tidy',
    ]);
    expect(res.body.habits[0]).toEqual({
      id: ctx.id.stretch,
      slug: 'stretch',
      label: 'Stretch',
      done: Array(30).fill(false),
      due: Array(30).fill(true),
      streak: 0,
    });
    expect(res.body.stats).toEqual({ completionPct: 0, bestLiveStreak: 0, allDoneDays: 0 });
  });

  it('flags each checked day and computes the stats over the range', async () => {
    // stretch: the last 3 days ending today; tidy: 5 days ending yesterday.
    for (let i = 0; i < 3; i += 1) await ctx.store.addCheck(ctx.id.stretch, addDays(TODAY, -i));
    for (let i = 1; i <= 5; i += 1) await ctx.store.addCheck(ctx.id.tidy, addDays(TODAY, -i));
    // Every habit on one day two days ago.
    for (const id of Object.values(ctx.id)) await ctx.store.addCheck(id, addDays(TODAY, -2));
    // Outside the range: no effect on the flags or the stats.
    await ctx.store.addCheck(ctx.id.read, addDays(TODAY, -40));
    // After the end: ignored too.
    await ctx.store.addCheck(ctx.id.read, addDays(TODAY, 1));

    const res = await get(`/api/history?days=7&date=${TODAY}`);
    expect(res.status).toBe(200);
    const stretch = res.body.habits[0];
    const tidy = res.body.habits[5];
    const read = res.body.habits[1];
    expect(stretch.done).toEqual([false, false, false, false, true, true, true]);
    expect(stretch.streak).toBe(3);
    expect(tidy.done).toEqual([false, true, true, true, true, true, false]);
    // Not done yet today never breaks it.
    expect(tidy.streak).toBe(5);
    expect(read.done).toEqual([false, false, false, false, true, false, false]);
    // stretch 3 + tidy 5 + read, water, journal, plan 1 each = 12 of 42.
    expect(res.body.stats).toEqual({ completionPct: 29, bestLiveStreak: 5, allDoneDays: 1 });
  });

  it('computes the stats over the last statsDays only, and clamps it to the range', async () => {
    // Every habit done on day -7 (inside days=8, outside statsDays=7), stretch also today.
    for (const id of Object.values(ctx.id)) await ctx.store.addCheck(id, addDays(TODAY, -7));
    await ctx.store.addCheck(ctx.id.stretch, TODAY);
    const res = await get(`/api/history?days=8&statsDays=7&date=${TODAY}`);
    expect(res.body.dates).toHaveLength(8);
    expect(res.body.habits[0].done).toEqual([true, false, false, false, false, false, false, true]);
    // 1 of 42 cells; the all-done day is outside the stats.
    expect(res.body.stats).toEqual({ completionPct: 2, bestLiveStreak: 1, allDoneDays: 0 });
    const all = await get(`/api/history?days=8&statsDays=99&date=${TODAY}`);
    expect(all.body.stats.allDoneDays).toBe(1);
    expect((await get(`/api/history?days=8&statsDays=x&date=${TODAY}`)).status).toBe(400);
  });

  it('leaves retired habits out', async () => {
    await ctx.store.updateHabit(ctx.id.plan, { retired: true });
    const res = await get(`/api/history?date=${TODAY}`);
    expect(res.body.habits.map((h: { slug: string }) => h.slug)).not.toContain('plan');
    expect(res.body.habits).toHaveLength(5);
  });

  it('clamps days to 1..90 and refuses a fraction or a bad date', async () => {
    expect((await get(`/api/history?days=0&date=${TODAY}`)).body.dates).toEqual([TODAY]);
    expect((await get(`/api/history?days=500&date=${TODAY}`)).body.dates).toHaveLength(90);
    expect((await get(`/api/history?days=2.5&date=${TODAY}`)).status).toBe(400);
    expect((await get('/api/history?date=2026-02-31')).status).toBe(400);
  });

  it('falls back to the app timezone when no date is sent', async () => {
    expect((await get('/api/history')).body.end).toBe(TODAY);
  });

  it('needs a login or the API token', async () => {
    expect((await request(ctx.app).get(`/api/history?date=${TODAY}`)).status).toBe(401);
    const token = await ctx.issueApiToken();
    const res = await request(ctx.app)
      .get(`/api/history?date=${TODAY}`)
      .set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
  });
});
