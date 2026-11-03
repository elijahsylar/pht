import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addDays } from '../src/lib/dates.js';
import { createFakeStore } from './fakeStore.js';
import { TODAY, TOMORROW, useApp, bearer } from './helpers.js';
import { storeContract } from './storeContract.js';

storeContract('in-memory fake', async () => createFakeStore({ seed: true }));

const ctx = useApp();

const put = (path: string, body?: object) => {
  const r = request(ctx.app).put(path).set(ctx.jwt);
  return body === undefined ? r : r.send(body);
};
const del = (path: string) => request(ctx.app).delete(path).set(ctx.jwt);
const get = (path: string) => request(ctx.app).get(path).set(ctx.jwt);
const post = (path: string, body: object) => request(ctx.app).post(path).set(ctx.jwt).send(body);
const patch = (path: string, body: object) => request(ctx.app).patch(path).set(ctx.jwt).send(body);

describe('GET /api/health', () => {
  it('needs no credentials', async () => {
    const res = await request(ctx.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /api/today', () => {
  it('returns the six seeded habits, all undone', async () => {
    const res = await get(`/api/today?date=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      date: TODAY,
      doneCount: 0,
      total: 6,
      dueCount: 6,
      dueDone: 0,
      note: null,
    });
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
      done: false,
      due: true,
      schedule: { kind: 'daily' },
      streak: 0,
      best: 0,
      totalDone: 0,
      rampText: null,
      milestone: { next: 7, progress: 0 },
    });
  });

  it('reports streak, best, total and the note for the requested day', async () => {
    for (let i = 1; i <= 3; i += 1) await ctx.store.addCheck(ctx.id.stretch, addDays(TODAY, -i));
    for (let i = 10; i < 18; i += 1) await ctx.store.addCheck(ctx.id.stretch, addDays(TODAY, -i));
    await ctx.store.addCheck(ctx.id.read, TODAY);
    await ctx.store.putNote(TODAY, 'windy');

    const res = await get(`/api/today?date=${TODAY}`);
    expect(res.body).toMatchObject({ doneCount: 1, total: 6, note: 'windy' });
    const [stretch, read] = res.body.habits;
    // Not done yet today: yesterday's run of 3 still stands.
    expect(stretch).toMatchObject({ done: false, streak: 3, best: 8, totalDone: 11 });
    expect(stretch.milestone).toEqual({ next: 7, progress: 3 });
    expect(read).toMatchObject({ done: true, streak: 1, best: 1, totalDone: 1 });
  });

  it('computes against the date the client sends, not the server clock', async () => {
    await ctx.store.addCheck(ctx.id.stretch, '2026-10-10');
    const then = await get('/api/today?date=2026-10-10');
    expect(then.body.habits[0]).toMatchObject({ done: true, streak: 1 });
    const later = await get('/api/today?date=2026-10-12');
    expect(later.body.habits[0]).toMatchObject({ done: false, streak: 0, best: 1 });
  });

  it('falls back to the app timezone when no date is sent', async () => {
    expect((await get('/api/today')).body.date).toBe(TODAY);
    await ctx.store.setSetting('app_timezone', 'Pacific/Kiritimati'); // UTC+14
    expect((await get('/api/today')).body.date).toBe(TOMORROW);
  });

  it('rejects a malformed or impossible date', async () => {
    expect((await get('/api/today?date=yesterday')).status).toBe(400);
    expect((await get('/api/today?date=2026-02-31')).status).toBe(400);
  });

  it('hides a retired habit and orders by sort', async () => {
    await patch(`/api/habits/${ctx.id.stretch}`, { retired: true });
    await patch(`/api/habits/${ctx.id.tidy}`, { sort: 0 });
    const res = await get(`/api/today?date=${TODAY}`);
    expect(res.body.total).toBe(5);
    expect(res.body.habits.map((h: { slug: string }) => h.slug)).toEqual([
      'tidy',
      'read',
      'water',
      'journal',
      'plan',
    ]);
  });
});

describe('PUT/DELETE /api/checks/:habitId/:date', () => {
  it('checks idempotently', async () => {
    const url = `/api/checks/${ctx.id.stretch}/${TODAY}`;
    const first = await put(url);
    const second = await put(url);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(first.body).toEqual({ habitId: ctx.id.stretch, date: TODAY, done: true });

    const today = await get(`/api/today?date=${TODAY}`);
    expect(today.body.doneCount).toBe(1);
    expect(today.body.habits[0]).toMatchObject({ done: true, streak: 1, totalDone: 1 });
  });

  it('unchecks idempotently, including a check that never existed', async () => {
    const url = `/api/checks/${ctx.id.stretch}/${TODAY}`;
    await put(url);
    const first = await del(url);
    const second = await del(url);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ habitId: ctx.id.stretch, date: TODAY, done: false });
    expect((await get(`/api/today?date=${TODAY}`)).body.habits[0]).toMatchObject({
      done: false,
      totalDone: 0,
    });
  });

  it('404s an unknown habit and 400s a bad id or date', async () => {
    expect((await put(`/api/checks/9999/${TODAY}`)).status).toBe(404);
    expect((await del(`/api/checks/9999/${TODAY}`)).status).toBe(404);
    expect((await put(`/api/checks/abc/${TODAY}`)).status).toBe(400);
    expect((await put(`/api/checks/${ctx.id.stretch}/2026-02-30`)).status).toBe(400);
    expect((await put(`/api/checks/${ctx.id.stretch}/13-10-2026`)).status).toBe(400);
  });

  it('allows tomorrow but nothing later', async () => {
    expect((await put(`/api/checks/${ctx.id.stretch}/${TOMORROW}`)).status).toBe(200);
    const res = await put(`/api/checks/${ctx.id.stretch}/${addDays(TOMORROW, 1)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/);
    expect((await ctx.store.checkDates([ctx.id.stretch])).get(ctx.id.stretch)).toEqual([TOMORROW]);
  });

  it('measures "tomorrow" in the app timezone', async () => {
    // 20:00 UTC on the 13th is already the 14th in Kiritimati (UTC+14).
    await ctx.store.setSetting('app_timezone', 'Pacific/Kiritimati');
    expect((await put(`/api/checks/${ctx.id.stretch}/2026-10-15`)).status).toBe(200);
    expect((await put(`/api/checks/${ctx.id.stretch}/2026-10-16`)).status).toBe(400);
  });

  // TODAY is 2026-10-13 in the app zone: day 30 back is 2026-09-13, day 31 is 2026-09-12.
  it('backfills up to 30 days back; day 31 is read-only (403), both ways', async () => {
    const day30 = addDays(TODAY, -30);
    const day31 = addDays(TODAY, -31);
    expect(day30).toBe('2026-09-13');
    expect((await put(`/api/checks/${ctx.id.stretch}/${day30}`)).status).toBe(200);
    expect((await del(`/api/checks/${ctx.id.stretch}/${day30}`)).status).toBe(200);
    const res = await put(`/api/checks/${ctx.id.stretch}/${day31}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/read-only/);
    expect((await del(`/api/checks/${ctx.id.stretch}/${day31}`)).status).toBe(403);
    expect((await ctx.store.checkDates([ctx.id.stretch])).get(ctx.id.stretch)).toEqual([]);
  });

  it("ignores the habit's created_at inside the window", async () => {
    // Created today: yesterday and day 30 are still writable.
    ctx.store.setCreatedAt(ctx.id.read, new Date('2026-10-13T18:00:00Z'));
    expect((await put(`/api/checks/${ctx.id.read}/${addDays(TODAY, -1)}`)).status).toBe(200);
    expect((await put(`/api/checks/${ctx.id.read}/${addDays(TODAY, -30)}`)).status).toBe(200);
  });

  it('measures the window from today in the app timezone', async () => {
    // 20:00 UTC on the 13th is already the 14th in Kiritimati (UTC+14), so its
    // day 30 is 2026-09-14 and the default zone's day 30 (09-13) is day 31 there.
    await ctx.store.setSetting('app_timezone', 'Pacific/Kiritimati');
    expect((await put(`/api/checks/${ctx.id.stretch}/2026-09-14`)).status).toBe(200);
    expect((await put(`/api/checks/${ctx.id.stretch}/2026-09-13`)).status).toBe(403);
    // And at UTC-10 it is still the 13th, so 09-13 is day 30.
    await ctx.store.setSetting('app_timezone', 'Pacific/Tahiti');
    expect((await put(`/api/checks/${ctx.id.stretch}/2026-09-13`)).status).toBe(200);
    expect((await put(`/api/checks/${ctx.id.stretch}/2026-09-12`)).status).toBe(403);
  });

  it('recomputes streak, best and total from a backfilled check', async () => {
    for (const i of [1, 3, 4]) await put(`/api/checks/${ctx.id.stretch}/${addDays(TODAY, -i)}`);
    let stretch = (await get(`/api/today?date=${TODAY}`)).body.habits[0];
    expect(stretch).toMatchObject({ streak: 1, best: 2, totalDone: 3 });
    await put(`/api/checks/${ctx.id.stretch}/${addDays(TODAY, -2)}`); // fills the gap
    stretch = (await get(`/api/today?date=${TODAY}`)).body.habits[0];
    expect(stretch).toMatchObject({ streak: 4, best: 4, totalDone: 4 });
    await del(`/api/checks/${ctx.id.stretch}/${addDays(TODAY, -3)}`);
    stretch = (await get(`/api/today?date=${TODAY}`)).body.habits[0];
    expect(stretch).toMatchObject({ streak: 2, best: 2, totalDone: 3 });
    const hist = (await get(`/api/history?days=30&date=${TODAY}`)).body;
    // Days -4..0: done, removed, done, done, not yet.
    expect(hist.habits[0].done.slice(-5)).toEqual([true, false, true, true, false]);
  });

  it('a retired habit is still 409 inside the window', async () => {
    await patch(`/api/habits/${ctx.id.stretch}`, { retired: true });
    expect((await put(`/api/checks/${ctx.id.stretch}/${addDays(TODAY, -5)}`)).status).toBe(409);
    expect((await del(`/api/checks/${ctx.id.stretch}/${addDays(TODAY, -5)}`)).status).toBe(409);
  });

  it('an imported check older than the window is read-only; a recent one can be removed', async () => {
    await post('/api/import/mini-pht', { log: { '2026-01-05': ['stretch'], [addDays(TODAY, -3)]: ['stretch'] } });
    expect((await del(`/api/checks/${ctx.id.stretch}/2026-01-05`)).status).toBe(403);
    expect((await del(`/api/checks/${ctx.id.stretch}/${addDays(TODAY, -3)}`)).status).toBe(200);
    expect((await ctx.store.checkDates([ctx.id.stretch])).get(ctx.id.stretch)).toEqual(['2026-01-05']);
  });
});

describe('retired habits', () => {
  it('refuses check and uncheck with 409 and keeps the history', async () => {
    await put(`/api/checks/${ctx.id.stretch}/${TODAY}`);
    await patch(`/api/habits/${ctx.id.stretch}`, { retired: true });

    expect((await put(`/api/checks/${ctx.id.stretch}/${TODAY}`)).status).toBe(409);
    expect((await del(`/api/checks/${ctx.id.stretch}/${TODAY}`)).status).toBe(409);
    expect((await ctx.store.checkDates([ctx.id.stretch])).get(ctx.id.stretch)).toEqual([TODAY]);

    const hist = await get(`/api/habits/${ctx.id.stretch}/history?days=1&date=${TODAY}`);
    expect(hist.status).toBe(200);
    expect(hist.body.days).toEqual([{ date: TODAY, done: true, due: true }]);
  });

  it('comes back on unretire with the streak broken by the gap', async () => {
    for (let i = 5; i < 15; i += 1) await ctx.store.addCheck(ctx.id.stretch, addDays(TODAY, -i));
    await patch(`/api/habits/${ctx.id.stretch}`, { retired: true });
    await patch(`/api/habits/${ctx.id.stretch}`, { retired: false });

    const before = await get(`/api/today?date=${TODAY}`);
    expect(before.body.total).toBe(6);
    expect(before.body.habits[0]).toMatchObject({ slug: 'stretch', streak: 0, best: 10, totalDone: 10 });

    expect((await put(`/api/checks/${ctx.id.stretch}/${TODAY}`)).status).toBe(200);
    const after = await get(`/api/today?date=${TODAY}`);
    expect(after.body.habits[0]).toMatchObject({ streak: 1, best: 10, totalDone: 11 });
  });
});

describe('GET /api/habits/:id/history', () => {
  it('defaults to 14 days ending at the given date, oldest first', async () => {
    await ctx.store.addCheck(ctx.id.stretch, TODAY);
    await ctx.store.addCheck(ctx.id.stretch, addDays(TODAY, -13));
    await ctx.store.addCheck(ctx.id.stretch, addDays(TODAY, -14)); // outside the window
    const res = await get(`/api/habits/${ctx.id.stretch}/history?date=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.body.habitId).toBe(ctx.id.stretch);
    expect(res.body.days).toHaveLength(14);
    expect(res.body.days[0]).toEqual({ date: addDays(TODAY, -13), done: true, due: true });
    expect(res.body.days[13]).toEqual({ date: TODAY, done: true, due: true });
    expect(res.body.days.filter((d: { done: boolean }) => d.done)).toHaveLength(2);
  });

  it('clamps days to 1..366 and rejects a non-number', async () => {
    const url = `/api/habits/${ctx.id.stretch}/history?date=${TODAY}`;
    expect((await get(`${url}&days=0`)).body.days).toHaveLength(1);
    expect((await get(`${url}&days=5000`)).body.days).toHaveLength(366);
    expect((await get(`${url}&days=lots`)).status).toBe(400);
    expect((await get(`${url}&days=2.5`)).status).toBe(400);
  });

  it('404s an unknown habit', async () => {
    expect((await get('/api/habits/9999/history')).status).toBe(404);
  });
});

describe('/api/habits', () => {
  it('lists every habit, retired ones included', async () => {
    await patch(`/api/habits/${ctx.id.plan}`, { retired: true });
    const res = await get('/api/habits');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
    const call = res.body.find((h: { slug: string }) => h.slug === 'plan');
    expect(call.retiredAt).toEqual(expect.any(String));
    expect(res.body[0]).toEqual({
      id: ctx.id.stretch,
      slug: 'stretch',
      label: 'Stretch',
      sort: 1,
      rampText: null,
      createdAt: '2026-09-01T12:00:00.000Z',
      retiredAt: null,
      schedule: { kind: 'daily' },
      scheduleFrom: null,
    });
  });

  it('creates a habit, trimming label and rampText only', async () => {
    const res = await post('/api/habits', {
      slug: 'floss',
      label: '  Floss  ',
      rampText: '  5 min, Then  10  ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      slug: 'floss',
      label: 'Floss',
      sort: 7,
      rampText: '5 min, Then  10',
    });
    expect((await get(`/api/today?date=${TODAY}`)).body.total).toBe(7);
  });

  it('rejects a duplicate or malformed slug and over-long fields', async () => {
    expect((await post('/api/habits', { slug: 'stretch', label: 'Dup' })).status).toBe(409);
    expect((await post('/api/habits', { slug: 'Has Space', label: 'x' })).status).toBe(400);
    expect((await post('/api/habits', { slug: 'a'.repeat(41), label: 'x' })).status).toBe(400);
    expect((await post('/api/habits', { slug: 'ok', label: '   ' })).status).toBe(400);
    expect((await post('/api/habits', { slug: 'ok', label: 'x'.repeat(81) })).status).toBe(400);
    expect(
      (await post('/api/habits', { slug: 'ok', label: 'x', rampText: 'r'.repeat(121) })).status,
    ).toBe(400);
    expect((await post('/api/habits', { slug: 'ok', label: 'x', extra: 1 })).status).toBe(400);
    // The DB column name is not an API field: the body uses rampText.
    expect((await post('/api/habits', { slug: 'ok', label: 'x', ramp_text: 'r' })).status).toBe(400);
    expect((await patch(`/api/habits/${ctx.id.read}`, { ramp_text: 'r' })).status).toBe(400);
  });

  it('patches label, sort and rampText; blank rampText clears it', async () => {
    const a = await patch(`/api/habits/${ctx.id.read}`, {
      label: 'Read two pages',
      sort: 10,
      rampText: ' one, then two ',
    });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ label: 'Read two pages', sort: 10, rampText: 'one, then two' });
    const b = await patch(`/api/habits/${ctx.id.read}`, { rampText: '   ' });
    expect(b.body).toMatchObject({ label: 'Read two pages', rampText: null });
    const c = await patch(`/api/habits/${ctx.id.read}`, { rampText: null });
    expect(c.body.rampText).toBeNull();
  });

  it('cannot change a slug, patch nothing, or patch a missing habit', async () => {
    expect((await patch(`/api/habits/${ctx.id.read}`, { slug: 'renamed' })).status).toBe(400);
    expect((await patch(`/api/habits/${ctx.id.read}`, {})).status).toBe(400);
    expect((await patch('/api/habits/9999', { label: 'x' })).status).toBe(404);
  });

  it('has no hard delete', async () => {
    expect((await del(`/api/habits/${ctx.id.read}`)).status).toBe(404);
    expect((await get('/api/habits')).body).toHaveLength(6);
  });
});

describe('/api/notes', () => {
  it('sets, replaces and returns the note', async () => {
    const a = await put(`/api/notes/${TODAY}`, { line: '  long stretch by the river  ' });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ date: TODAY, line: 'long stretch by the river' });
    await put(`/api/notes/${TODAY}`, { line: 'short stretch' });
    expect((await get(`/api/today?date=${TODAY}`)).body.note).toBe('short stretch');
  });

  it('deletes on an empty or whitespace line, idempotently', async () => {
    await put(`/api/notes/${TODAY}`, { line: 'something' });
    const a = await put(`/api/notes/${TODAY}`, { line: '   ' });
    const b = await put(`/api/notes/${TODAY}`, { line: '' });
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ date: TODAY, line: null });
    expect(b.body).toEqual({ date: TODAY, line: null });
    expect(await ctx.store.getNote(TODAY)).toBeNull();
  });

  it('folds line breaks into one line and caps it at 280', async () => {
    const a = await put(`/api/notes/${TODAY}`, { line: 'one\r\n\n  two\nthree' });
    expect(a.body.line).toBe('one two three');
    expect((await put(`/api/notes/${TODAY}`, { line: 'x'.repeat(280) })).status).toBe(200);
    expect((await put(`/api/notes/${TODAY}`, { line: 'x'.repeat(281) })).status).toBe(400);
    expect((await put(`/api/notes/${TODAY}`, {})).status).toBe(400);
  });

  it('allows tomorrow and the last 30 days; older is read-only, later is 400', async () => {
    expect((await put(`/api/notes/${TOMORROW}`, { line: 'early' })).status).toBe(200);
    expect((await put(`/api/notes/${addDays(TODAY, -30)}`, { line: 'day 30' })).status).toBe(200);
    expect((await put(`/api/notes/${addDays(TODAY, -30)}`, { line: '' })).status).toBe(200);
    const old = await put(`/api/notes/${addDays(TODAY, -31)}`, { line: 'day 31' });
    expect(old.status).toBe(403);
    expect(old.body.error).toMatch(/read-only/);
    expect((await put(`/api/notes/${addDays(TODAY, -31)}`, { line: '' })).status).toBe(403);
    expect((await put('/api/notes/2020-01-01', { line: 'old' })).status).toBe(403);
    expect((await put(`/api/notes/${addDays(TOMORROW, 1)}`, { line: 'no' })).status).toBe(400);
    expect((await put('/api/notes/2026-02-30', { line: 'no' })).status).toBe(400);
  });

  it('lists a range inclusively, oldest first', async () => {
    await put('/api/notes/2026-10-10', { line: 'a' });
    await put('/api/notes/2026-10-11', { line: 'b' });
    await put('/api/notes/2026-10-12', { line: 'c' });
    const res = await get('/api/notes?from=2026-10-11&to=2026-10-12');
    expect(res.status).toBe(200);
    expect(res.body.map((n: { line: string }) => n.line)).toEqual(['b', 'c']);
    expect((await get('/api/notes')).body).toHaveLength(3);
    expect((await get('/api/notes?from=nope')).status).toBe(400);
  });
});

describe('/api/learned', () => {
  it('sets, replaces, returns it on /today, and deletes on empty', async () => {
    const a = await put(`/api/learned/${TODAY}`, { text: '  CSS container queries\n  respect padding  ' });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ date: TODAY, text: 'CSS container queries respect padding' });
    await put(`/api/learned/${TODAY}`, { text: 'Octopuses have three hearts' });
    expect((await get(`/api/today?date=${TODAY}`)).body.learned).toBe('Octopuses have three hearts');
    expect((await get(`/api/today?date=${addDays(TODAY, -1)}`)).body.learned).toBeNull();
    const d = await put(`/api/learned/${TODAY}`, { text: '   ' });
    expect(d.body).toEqual({ date: TODAY, text: null });
    expect(await ctx.store.getLearned(TODAY)).toBeNull();
    expect((await put(`/api/learned/${TODAY}`, { text: '' })).status).toBe(200);
  });

  it('caps the text at 500 and refuses a bad body', async () => {
    expect((await put(`/api/learned/${TODAY}`, { text: 'x'.repeat(500) })).status).toBe(200);
    expect((await put(`/api/learned/${TODAY}`, { text: 'x'.repeat(501) })).status).toBe(400);
    expect((await put(`/api/learned/${TODAY}`, {})).status).toBe(400);
    expect((await put(`/api/learned/${TODAY}`, { text: 'a', extra: 1 })).status).toBe(400);
  });

  it('has the notes window: tomorrow and the last 30 days; older 403, later 400', async () => {
    expect((await put(`/api/learned/${TOMORROW}`, { text: 'early' })).status).toBe(200);
    expect((await put(`/api/learned/${addDays(TODAY, -30)}`, { text: 'day 30' })).status).toBe(200);
    const old = await put(`/api/learned/${addDays(TODAY, -31)}`, { text: 'day 31' });
    expect(old.status).toBe(403);
    expect(old.body.error).toMatch(/read-only/);
    expect((await put(`/api/learned/${addDays(TODAY, -31)}`, { text: '' })).status).toBe(403);
    expect((await put(`/api/learned/${addDays(TOMORROW, 1)}`, { text: 'no' })).status).toBe(400);
    expect((await put('/api/learned/2026-02-30', { text: 'no' })).status).toBe(400);
  });

  it('lists newest first, searches case-insensitively, and pages', async () => {
    const texts = ['Rust borrows', 'Octopus have three hearts', 'rust never sleeps', 'Tea is a camellia', '100% literal_match'];
    for (let i = 0; i < texts.length; i += 1) await put(`/api/learned/${addDays(TODAY, -i)}`, { text: texts[i] });
    const all = await get('/api/learned');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 5, limit: 50, offset: 0 });
    expect(all.body.entries.map((e: { date: string }) => e.date)).toEqual([0, 1, 2, 3, 4].map((i) => addDays(TODAY, -i)));
    expect(all.body.entries[0]).toEqual({ date: TODAY, text: 'Rust borrows', updatedAt: expect.any(String) });

    const rust = await get('/api/learned?q=RUST');
    expect(rust.body.total).toBe(2);
    expect(rust.body.entries.map((e: { text: string }) => e.text)).toEqual(['Rust borrows', 'rust never sleeps']);
    // % and _ are literal, not wildcards.
    expect((await get('/api/learned?q=%25')).body.total).toBe(1);
    expect((await get('/api/learned?q=l_t')).body.total).toBe(0);
    expect((await get('/api/learned?q=')).body.total).toBe(5);

    const p1 = await get('/api/learned?limit=2');
    const p2 = await get('/api/learned?limit=2&offset=2');
    const p3 = await get('/api/learned?limit=2&offset=4');
    expect([p1, p2, p3].map((r) => r.body.entries.length)).toEqual([2, 2, 1]);
    expect(p2.body.entries[0].text).toBe('rust never sleeps');
    expect(p3.body.total).toBe(5);

    const range = await get(`/api/learned?from=${addDays(TODAY, -3)}&to=${addDays(TODAY, -1)}`);
    expect(range.body.entries.map((e: { text: string }) => e.text)).toEqual([texts[1], texts[2], texts[3]]);

    for (const bad of ['limit=0', 'limit=201', 'offset=-1', 'from=nope', 'x=1', `q=${'a'.repeat(101)}`]) {
      expect((await get(`/api/learned?${bad}`)).status).toBe(400);
    }
  });

  it('is open to the API token and closed without credentials', async () => {
    const token = await ctx.issueApiToken();
    expect((await request(ctx.app).get('/api/learned').set(bearer(token))).status).toBe(200);
    expect((await request(ctx.app).put(`/api/learned/${TODAY}`).set(bearer(token)).send({ text: 'via token' })).status).toBe(200);
    expect((await request(ctx.app).get('/api/learned')).status).toBe(401);
    expect((await request(ctx.app).put(`/api/learned/${TODAY}`).send({ text: 'x' })).status).toBe(401);
  });
});

describe('POST /api/import/mini-pht', () => {
  const log = {
    '2026-07-01': ['stretch', 'read'],
    '2026-07-02': ['stretch', 'meditate'],
    '2026-07-03': ['stretch', 'water', 'nap'],
  };

  it('imports by slug and reports what it ignored', async () => {
    const res = await post('/api/import/mini-pht', { log });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      days: 3,
      inserted: 5,
      alreadyPresent: 0,
      unknownSlugs: ['meditate', 'nap'],
    });
    const stretch = await get(`/api/habits/${ctx.id.stretch}/history?days=3&date=2026-07-03`);
    expect(stretch.body.days.every((d: { done: boolean }) => d.done)).toBe(true);
  });

  it('is idempotent', async () => {
    await post('/api/import/mini-pht', { log });
    const again = await post('/api/import/mini-pht', { log });
    expect(again.body).toMatchObject({ inserted: 0, alreadyPresent: 5 });
    const total = (await get(`/api/today?date=${TODAY}`)).body.habits.reduce(
      (n: number, h: { totalDone: number }) => n + h.totalDone,
      0,
    );
    expect(total).toBe(5);
  });

  it('writes history from before the habit existed', async () => {
    const res = await post('/api/import/mini-pht', { log: { '2025-01-01': ['stretch'] } });
    expect(res.body.inserted).toBe(1);
  });

  it('never removes a check that the log omits', async () => {
    await put(`/api/checks/${ctx.id.plan}/${TODAY}`);
    await post('/api/import/mini-pht', { log });
    expect((await ctx.store.checkDates([ctx.id.plan])).get(ctx.id.plan)).toEqual([TODAY]);
  });

  it('rejects a malformed body without importing anything', async () => {
    expect((await post('/api/import/mini-pht', {})).status).toBe(400);
    expect((await post('/api/import/mini-pht', { log: { '07/01/2026': ['stretch'] } })).status).toBe(
      400,
    );
    expect((await post('/api/import/mini-pht', { log: { '2026-07-01': 'stretch' } })).status).toBe(
      400,
    );
    const bad = await post('/api/import/mini-pht', {
      log: { '2026-07-01': ['stretch'], '2026-02-31': ['read'] },
    });
    expect(bad.status).toBe(400);
    expect((await ctx.store.checkDates([ctx.id.stretch])).get(ctx.id.stretch)).toEqual([]);
  });
});

describe('removed routes and bad input', () => {
  it('404s every legacy route', async () => {
    for (const path of [
      '/api/protocols',
      '/api/entries',
      '/api/journal',
      '/api/gratitude',
      '/api/coach/status',
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
    // The old bulk import lived at POST /api/import itself.
    expect((await post('/api/import', { protocols: [], entries: [] })).status).toBe(404);
  });

  it('answers malformed JSON with 400, not 500', async () => {
    const res = await request(ctx.app)
      .put(`/api/notes/${TODAY}`)
      .set(ctx.jwt)
      .set('Content-Type', 'application/json')
      .send('{"line": ');
    expect(res.status).toBe(400);
  });
});
