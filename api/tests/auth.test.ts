import jwt, { type Algorithm } from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  API_TOKEN_HASH_KEY,
  apiTokenMatches,
  generateApiToken,
  hashApiToken,
} from '../src/lib/apiToken.js';
import { issueSessionToken } from '../src/lib/session.js';
import { ADMIN, PASSWORD, TODAY, bearer, partialJwt, useApp } from './helpers.js';

const ctx = useApp();

type Method = 'get' | 'put' | 'post' | 'patch' | 'delete';

function call(method: Method, path: string, headers: Record<string, string>, body?: object) {
  const r = request(ctx.app)[method](path).set(headers);
  return body === undefined ? r : r.send(body);
}

// Every route the API token is allowed to use, with a body that succeeds.
const tokenRoutes = (): [Method, string, object?][] => [
  ['get', `/api/today?date=${TODAY}`],
  ['put', `/api/checks/${ctx.id.stretch}/${TODAY}`],
  ['delete', `/api/checks/${ctx.id.stretch}/${TODAY}`],
  ['get', '/api/habits'],
  ['get', `/api/habits/${ctx.id.stretch}/history?date=${TODAY}`],
  ['get', `/api/history?date=${TODAY}`],
  ['get', '/api/weather'],
  ['get', '/api/notes'],
  ['put', `/api/notes/${TODAY}`, { line: 'from the widget' }],
];

// Every route it must not reach, with the status that proves the refusal.
const jwtOnlyRoutes = (): [Method, string, object | undefined, number][] => [
  ['get', '/api/settings/timezone', undefined, 401],
  ['put', '/api/settings/timezone', { timezone: 'Pacific/Tahiti' }, 401],
  ['put', '/api/settings/password', { currentPassword: PASSWORD, newPassword: 'new-password-1' }, 401],
  ['put', '/api/settings/security-answer', { currentAnswer: 'name', newAnswer: 'x' }, 401],
  ['get', '/api/auth/verify', undefined, 401],
  ['post', '/api/auth/logout', undefined, 401],
  ['post', '/api/auth/verify-security', { answer: 'name' }, 401],
  ['post', '/api/import/mini-pht', { log: { [TODAY]: ['stretch'] } }, 401],
  ['post', '/api/habits', { slug: 'sneaky', label: 'Sneaky' }, 403],
  ['patch', `/api/habits/${ctx.id.stretch}`, { retired: true }, 403],
];

describe('no credentials', () => {
  it('401s every route except health', async () => {
    for (const [method, path, body] of [...tokenRoutes(), ...jwtOnlyRoutes()]) {
      if (path === '/api/auth/verify-security') continue; // covered below
      const res = await call(method, path, {}, body);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect((await call('post', '/api/auth/verify-security', {}, { answer: 'x' })).status).toBe(401);
  });

  it('401s a malformed Authorization header', async () => {
    const url = `/api/today?date=${TODAY}`;
    expect((await call('get', url, { Authorization: 'pht_whatever' })).status).toBe(401);
    expect((await call('get', url, { Authorization: 'Basic abc' })).status).toBe(401);
    expect((await call('get', url, bearer(''))).status).toBe(401);
    expect((await call('get', url, bearer('not.a.jwt'))).status).toBe(401);
  });
});

describe('API token', () => {
  it('reaches exactly the day-to-day routes', async () => {
    const auth = bearer(await ctx.issueApiToken());
    for (const [method, path, body] of tokenRoutes()) {
      const res = await call(method, path, auth, body);
      expect(res.status, `${method} ${path}`).toBe(200);
    }
  });

  it('is rejected on /settings, /auth, /import and habit management', async () => {
    const auth = bearer(await ctx.issueApiToken());
    for (const [method, path, body, status] of jwtOnlyRoutes()) {
      const res = await call(method, path, auth, body);
      expect(res.status, `${method} ${path}`).toBe(status);
    }
    // And nothing it was refused actually happened.
    expect(await ctx.store.getSetting('app_timezone')).toBeNull();
    expect(await ctx.store.getSetting('admin_password_hash')).toBeNull();
    const habits = await ctx.store.listHabits({ includeRetired: true });
    expect(habits).toHaveLength(6);
    expect(habits.every((h) => h.retiredAt === null)).toBe(true);
    expect((await ctx.store.checkDates([ctx.id.stretch])).get(ctx.id.stretch)).toEqual([]);
  });

  it('rejects a wrong token, and any token before one is issued', async () => {
    const url = `/api/today?date=${TODAY}`;
    expect((await call('get', url, bearer(generateApiToken()))).status).toBe(401);
    await ctx.issueApiToken();
    expect((await call('get', url, bearer(generateApiToken()))).status).toBe(401);
    expect((await call('get', url, bearer('pht_'))).status).toBe(401);
    expect((await call('get', url, bearer('pht_short'))).status).toBe(401);
  });

  it('is revoked by rotation', async () => {
    const url = `/api/today?date=${TODAY}`;
    const old = await ctx.issueApiToken();
    expect((await call('get', url, bearer(old))).status).toBe(200);
    const fresh = await ctx.issueApiToken();
    expect((await call('get', url, bearer(old))).status).toBe(401);
    expect((await call('get', url, bearer(fresh))).status).toBe(200);
  });

  it('is stored only as a sha256 hash', async () => {
    const token = await ctx.issueApiToken();
    const stored = await ctx.store.getSetting(API_TOKEN_HASH_KEY);
    expect(token).toMatch(/^pht_[A-Za-z0-9_-]{43}$/);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).toBe(hashApiToken(token));
    expect(stored).not.toContain(token.slice(4));
  });

  it('cannot be satisfied by the hash itself, or by a corrupt stored value', async () => {
    const token = await ctx.issueApiToken();
    const stored = (await ctx.store.getSetting(API_TOKEN_HASH_KEY)) as string;
    const url = `/api/today?date=${TODAY}`;
    // Knowing the database row is not enough to authenticate.
    expect((await call('get', url, bearer(stored))).status).toBe(401);
    expect((await call('get', url, bearer(`pht_${stored}`))).status).toBe(401);

    expect(apiTokenMatches(token, stored)).toBe(true);
    expect(apiTokenMatches(token, null)).toBe(false);
    expect(apiTokenMatches(token, '')).toBe(false);
    expect(apiTokenMatches(token, 'zz')).toBe(false);
    expect(apiTokenMatches(token, stored.toUpperCase())).toBe(false);
    expect(apiTokenMatches(`${token}x`, stored)).toBe(false);
  });
});

describe('JWT', () => {
  it('still reaches every route', async () => {
    for (const [method, path, body] of tokenRoutes()) {
      const res = await call(method, path, ctx.jwt, body);
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    expect((await call('get', '/api/auth/verify', ctx.jwt)).status).toBe(200);
    expect((await call('get', '/api/settings/timezone', ctx.jwt)).body).toEqual({
      timezone: null,
      serverToday: null,
    });
    const tz = await call('put', '/api/settings/timezone', ctx.jwt, {
      timezone: 'Pacific/Tahiti',
    });
    expect(tz.body).toEqual({ ok: true, timezone: 'Pacific/Tahiti', serverToday: TODAY });
    expect(
      (await call('put', '/api/settings/timezone', ctx.jwt, { timezone: 'Mars/Olympus' })).status,
    ).toBe(400);
    expect(
      (await call('post', '/api/habits', ctx.jwt, { slug: 'floss', label: 'Floss' })).status,
    ).toBe(201);
    expect(
      (await call('patch', `/api/habits/${ctx.id.stretch}`, ctx.jwt, { label: 'Walk' })).status,
    ).toBe(200);
    expect(
      (await call('post', '/api/import/mini-pht', ctx.jwt, { log: { [TODAY]: ['stretch'] } })).status,
    ).toBe(200);
  });

  it('rejects a partial (password-only) token everywhere but verify-security', async () => {
    const partial = bearer(partialJwt());
    expect((await call('get', `/api/today?date=${TODAY}`, partial)).status).toBe(401);
    expect((await call('get', '/api/habits', partial)).status).toBe(401);
    expect((await call('get', '/api/settings/timezone', partial)).status).toBe(401);
    expect((await call('get', '/api/auth/verify', partial)).status).toBe(401);
  });

  it('completes the unchanged two-step browser login', async () => {
    const bad = await call('post', '/api/auth/login', {}, { username: ADMIN, password: 'nope' });
    expect(bad.status).toBe(401);

    const login = await call('post', '/api/auth/login', {}, { username: ADMIN, password: PASSWORD });
    expect(login.status).toBe(200);
    const partial = bearer(login.body.partialToken);
    expect((await call('get', `/api/today?date=${TODAY}`, partial)).status).toBe(401);

    const wrong = await call('post', '/api/auth/verify-security', partial, { answer: 'wrong' });
    expect(wrong.status).toBe(401);
    // No answer was ever set, so the documented default applies.
    const ok = await call('post', '/api/auth/verify-security', partial, { answer: ' Name ' });
    expect(ok.status).toBe(200);

    const full = bearer(ok.body.token);
    expect((await call('get', '/api/auth/verify', full)).status).toBe(200);
    expect((await call('get', `/api/today?date=${TODAY}`, full)).status).toBe(200);
  });
});

describe('JWT algorithm', () => {
  const secret = () => process.env.JWT_SECRET as string;
  const signed = (stage: 'full' | 'partial', algorithm: Algorithm) =>
    bearer(jwt.sign({ username: ADMIN, stage, iatMs: Date.now() }, secret(), { algorithm, expiresIn: '5m' }));
  // An unsigned token, built by hand: header says alg none, empty signature.
  const unsigned = (stage: 'full' | 'partial') => {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const body = { username: ADMIN, stage, iatMs: Date.now(), iat: now, exp: now + 300 };
    return bearer(`${part({ alg: 'none', typ: 'JWT' })}.${part(body)}.`);
  };
  const header = (token: string) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  const fullRoute = (h: Record<string, string>) => call('get', '/api/auth/verify', h);
  const partialRoute = (h: Record<string, string>) =>
    call('post', '/api/auth/verify-security', h, { answer: 'name' });

  it('accepts HS256 tokens at both login stages', async () => {
    expect((await fullRoute(signed('full', 'HS256'))).status).toBe(200);
    expect((await partialRoute(signed('partial', 'HS256'))).status).toBe(200);
  });

  it('refuses a full token signed with another HMAC algorithm and the same secret', async () => {
    for (const alg of ['HS384', 'HS512'] as const) {
      const res = await fullRoute(signed('full', alg));
      expect(res.status, alg).toBe(401);
      expect(res.body, alg).toEqual({ error: 'invalid token' });
      expect((await call('get', '/api/habits', signed('full', alg))).status, alg).toBe(401);
    }
  });

  it('refuses a partial token signed with another HMAC algorithm and the same secret', async () => {
    for (const alg of ['HS384', 'HS512'] as const) {
      const res = await partialRoute(signed('partial', alg));
      expect(res.status, alg).toBe(401);
      expect(res.body, alg).toEqual({ error: 'invalid token' });
    }
  });

  it('refuses an unsigned alg none token at both stages', async () => {
    expect((await fullRoute(unsigned('full'))).status).toBe(401);
    expect((await call('get', '/api/habits', unsigned('full'))).status).toBe(401);
    expect((await partialRoute(unsigned('partial'))).status).toBe(401);
  });

  it('signs the partial, full and renewed tokens with HS256', async () => {
    const login = await call('post', '/api/auth/login', {}, { username: ADMIN, password: PASSWORD });
    expect(header(login.body.partialToken)).toMatchObject({ alg: 'HS256' });
    const ok = await call('post', '/api/auth/verify-security', bearer(login.body.partialToken), {
      answer: 'name',
    });
    expect(header(ok.body.token)).toMatchObject({ alg: 'HS256' });
    expect(header(issueSessionToken(ADMIN))).toMatchObject({ alg: 'HS256' });
  });
});

describe('CORS', () => {
  it('sends no CORS headers and answers no preflight', async () => {
    const origin = { Origin: 'https://evil.example' };
    const res = await call('get', `/api/today?date=${TODAY}`, { ...ctx.jwt, ...origin });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await request(ctx.app)
      .options('/api/checks/1/2026-10-13')
      .set({ ...origin, 'Access-Control-Request-Method': 'PUT' });
    expect(preflight.status).toBe(401);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-methods']).toBeUndefined();
  });
});
