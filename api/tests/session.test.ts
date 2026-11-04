import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  RENEW_HEADER,
  RENEW_WINDOW_SECONDS,
  SESSION_TTL_SECONDS,
  SESSIONS_VALID_AFTER_KEY,
} from '../src/lib/session.js';
import { ADMIN, NOW, PASSWORD, TODAY, bearer, useApp } from './helpers.js';

// Browser sessions: 30-day sliding JWTs, revoked by logout and by a password
// change. The clock is faked (Date only) by useApp, so "days later" is exact.

const ctx = useApp();
const DAY = 86_400_000;
const header = RENEW_HEADER.toLowerCase();

async function loginToken(): Promise<string> {
  const a = await request(ctx.app).post('/api/auth/login').send({ username: ADMIN, password: PASSWORD });
  const b = await request(ctx.app)
    .post('/api/auth/verify-security')
    .set(bearer(a.body.partialToken))
    .send({ answer: 'name' });
  expect(b.status).toBe(200);
  return b.body.token as string;
}

const today = (token: string) => request(ctx.app).get(`/api/today?date=${TODAY}`).set(bearer(token));
const at = (ms: number) => vi.setSystemTime(new Date(ms));
const claims = (t: string) => jwt.decode(t) as { exp: number; iat: number; iatMs: number; stage: string };

describe('session lifetime', () => {
  it('issues a 30-day full token at login', async () => {
    const t = await loginToken();
    const c = claims(t);
    expect(c.stage).toBe('full');
    expect(c.exp - c.iat).toBe(SESSION_TTL_SECONDS);
    expect(c.iatMs).toBe(NOW.getTime());
  });

  it('works until it expires, then 401s', async () => {
    const t = await loginToken();
    at(NOW.getTime() + 30 * DAY - 1000);
    expect((await today(t)).status).toBe(200);
    at(NOW.getTime() + 30 * DAY + 1000);
    const res = await today(t);
    expect(res.status).toBe(401);
    expect(res.headers[header]).toBeUndefined();
  });

  it('does not renew outside the last 7 days', async () => {
    const t = await loginToken();
    for (const days of [0, 1, 22]) {
      at(NOW.getTime() + days * DAY);
      const res = await today(t);
      expect(res.status, `day ${days}`).toBe(200);
      expect(res.headers[header], `day ${days}`).toBeUndefined();
    }
  });

  it('renews inside the last 7 days with a fresh 30-day token', async () => {
    const t = await loginToken();
    const then = NOW.getTime() + 24 * DAY; // 6 days left
    at(then);
    const res = await today(t);
    expect(res.status).toBe(200);
    const fresh = res.headers[header] as string;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(t);
    expect(res.headers['cache-control']).toBe('no-store');
    const c = claims(fresh);
    expect(c.stage).toBe('full');
    expect(c.iatMs).toBe(then);
    expect(c.exp * 1000).toBe(then + SESSION_TTL_SECONDS * 1000);

    // The new token outlives the old one.
    at(NOW.getTime() + 40 * DAY);
    expect((await today(t)).status).toBe(401);
    expect((await today(fresh)).status).toBe(200);
  });

  it('renews from exactly 7 days left', async () => {
    const t = await loginToken();
    at(NOW.getTime() + (SESSION_TTL_SECONDS - RENEW_WINDOW_SECONDS) * 1000);
    expect((await today(t)).headers[header]).toBeTruthy();
  });

  it('renews on JWT-only routes too, and never for the API token', async () => {
    const t = await loginToken();
    const api = await ctx.issueApiToken();
    at(NOW.getTime() + 25 * DAY);
    const tz = await request(ctx.app).get('/api/settings/timezone').set(bearer(t));
    expect(tz.status).toBe(200);
    expect(tz.headers[header]).toBeTruthy();
    const viaToken = await today(api);
    expect(viaToken.status).toBe(200);
    expect(viaToken.headers[header]).toBeUndefined();
  });

  it('upgrades a legacy 24h token (no iatMs) by renewing it', async () => {
    const legacy = jwt.sign({ username: ADMIN, stage: 'full' }, process.env.JWT_SECRET as string, {
      expiresIn: '24h',
    });
    const res = await today(legacy);
    expect(res.status).toBe(200);
    expect(claims(res.headers[header] as string).exp - NOW.getTime() / 1000).toBe(SESSION_TTL_SECONDS);
  });
});

describe('logout', () => {
  it('ends every browser session issued before it, on every device', async () => {
    const phone = await loginToken();
    at(NOW.getTime() + 60_000);
    const laptop = await loginToken();
    at(NOW.getTime() + 120_000);

    const out = await request(ctx.app).post('/api/auth/logout').set(bearer(laptop));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect(await ctx.store.getSetting(SESSIONS_VALID_AFTER_KEY)).toBe(String(NOW.getTime() + 120_000));

    for (const t of [phone, laptop]) {
      const res = await today(t);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('session ended');
    }
    expect((await request(ctx.app).get('/api/settings/timezone').set(bearer(phone))).status).toBe(401);
    expect((await request(ctx.app).get('/api/auth/verify').set(bearer(laptop))).status).toBe(401);
  });

  it('also ends an unused partial (password-only) token', async () => {
    const step1 = () => request(ctx.app).post('/api/auth/login').send({ username: ADMIN, password: PASSWORD });
    const step2 = (partial: string) =>
      request(ctx.app).post('/api/auth/verify-security').set(bearer(partial)).send({ answer: 'name' });
    const before = (await step1()).body.partialToken as string;
    const full = await loginToken();
    at(NOW.getTime() + 1000);
    await request(ctx.app).post('/api/auth/logout').set(bearer(full));
    const res = await step2(before);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('session ended');
    at(NOW.getTime() + 1001); // a millisecond later, same second
    expect((await step2((await step1()).body.partialToken)).status).toBe(200);
  });

  it('lets a new login in straight after', async () => {
    const old = await loginToken();
    await request(ctx.app).post('/api/auth/logout').set(bearer(old));
    at(NOW.getTime() + 1); // a millisecond later
    const fresh = await loginToken();
    expect((await today(fresh)).status).toBe(200);
    expect((await today(old)).status).toBe(401);
  });

  it('does not affect the API token', async () => {
    const api = await ctx.issueApiToken();
    const t = await loginToken();
    await request(ctx.app).post('/api/auth/logout').set(bearer(t));
    expect((await today(api)).status).toBe(200);
    expect((await request(ctx.app).put(`/api/checks/${ctx.id.stretch}/${TODAY}`).set(bearer(api))).status).toBe(200);
  });

  it('cannot be called with the API token or a partial token, and they end nothing', async () => {
    const t = await loginToken();
    const api = await ctx.issueApiToken();
    expect((await request(ctx.app).post('/api/auth/logout').set(bearer(api))).status).toBe(401);
    const partial = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: ADMIN, password: PASSWORD });
    expect(
      (await request(ctx.app).post('/api/auth/logout').set(bearer(partial.body.partialToken))).status,
    ).toBe(401);
    expect(await ctx.store.getSetting(SESSIONS_VALID_AFTER_KEY)).toBeNull();
    expect((await today(t)).status).toBe(200);
  });

  it('kills a renewal token handed out before it', async () => {
    const t = await loginToken();
    at(NOW.getTime() + 25 * DAY);
    const renewed = (await today(t)).headers[header] as string;
    at(NOW.getTime() + 25 * DAY + 1000);
    const out = await request(ctx.app).post('/api/auth/logout').set(bearer(renewed));
    expect(out.status).toBe(200);
    expect(out.headers[header]).toBeUndefined();
    expect((await today(renewed)).status).toBe(401);
  });

  it('also revokes a legacy token without iatMs', async () => {
    const legacy = jwt.sign({ username: ADMIN, stage: 'full' }, process.env.JWT_SECRET as string, {
      expiresIn: '24h',
    });
    at(NOW.getTime() + 5_000);
    const t = await loginToken();
    await request(ctx.app).post('/api/auth/logout').set(bearer(t));
    expect((await today(legacy)).status).toBe(401);
  });
});

describe('password change', () => {
  it('ends every browser session, including the one that changed it', async () => {
    const other = await loginToken();
    const t = await loginToken();
    const api = await ctx.issueApiToken();
    at(NOW.getTime() + 1000);
    const res = await request(ctx.app)
      .put('/api/settings/password')
      .set(bearer(t))
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(200);
    expect(res.headers[header]).toBeUndefined();
    expect((await today(t)).status).toBe(401);
    expect((await today(other)).status).toBe(401);
    expect((await today(api)).status).toBe(200);

    at(NOW.getTime() + 2000);
    const relog = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: ADMIN, password: 'a-brand-new-password' });
    expect(relog.status).toBe(200);
  });

  it('a wrong current password ends nothing', async () => {
    const t = await loginToken();
    const res = await request(ctx.app)
      .put('/api/settings/password')
      .set(bearer(t))
      .send({ currentPassword: 'wrong-password', newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(401);
    expect((await today(t)).status).toBe(200);
  });
});

describe('the renewal header is same-origin only', () => {
  it('is sent with no CORS headers at all, so no other origin can read it', async () => {
    const t = await loginToken();
    at(NOW.getTime() + 25 * DAY);
    const res = await today(t).set('Origin', 'https://evil.example');
    expect(res.headers[header]).toBeTruthy();
    for (const h of Object.keys(res.headers)) expect(h.startsWith('access-control-')).toBe(false);

    const preflight = await request(ctx.app)
      .options('/api/today')
      .set({ Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' });
    for (const h of Object.keys(preflight.headers)) expect(h.startsWith('access-control-')).toBe(false);
  });
});
