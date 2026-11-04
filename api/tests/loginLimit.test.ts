import bcrypt from 'bcrypt';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { clientKey, createAttemptLimiter } from '../src/lib/attemptLimiter.js';
import { ADMIN, NOW, PASSWORD, bearer, useApp } from './helpers.js';

// Attempt limits on both login steps (lib/attemptLimiter.ts). supertest
// connects over loopback, which app.ts trusts as the proxy, so
// X-Forwarded-For picks the client IP the way nginx's header does.

const ctx = useApp();

const from = (ip: string) => ({ 'X-Forwarded-For': ip });
const login = (ip: string, password: string, username = ADMIN) =>
  request(ctx.app).post('/api/auth/login').set(from(ip)).send({ username, password });
const answer = (ip: string, partialToken: string, a: string) =>
  request(ctx.app)
    .post('/api/auth/verify-security')
    .set({ ...from(ip), ...bearer(partialToken) })
    .send({ answer: a });
const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

async function partialFor(ip: string): Promise<string> {
  const r = await login(ip, PASSWORD);
  expect(r.status).toBe(200);
  return r.body.partialToken as string;
}

describe('password step', () => {
  it('locks an IP after five failures, refuses even the right password, then recovers', async () => {
    for (let i = 0; i < 5; i++) expect((await login('203.0.113.1', 'wrong')).status).toBe(401);

    const locked = await login('203.0.113.1', PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBe('60');
    expect(locked.body.error).toBe('Too many attempts. Try again in 1 minute.');

    // Another address is unaffected (the account has room for ten).
    expect((await login('203.0.113.2', PASSWORD)).status).toBe(200);

    advance(60_001);
    expect((await login('203.0.113.1', PASSWORD)).status).toBe(200);
    // A success forgets the failures: five more wrong tries before a lock.
    for (let i = 0; i < 5; i++) expect((await login('203.0.113.1', 'wrong')).status).toBe(401);
    expect((await login('203.0.113.1', 'wrong')).status).toBe(429);
  });

  it('doubles the lock with each failure after it, up to an hour', async () => {
    for (let i = 0; i < 5; i++) await login('203.0.113.1', 'wrong', 'nobody');
    const waits: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await login('203.0.113.1', 'wrong', 'nobody');
      expect(r.status).toBe(429);
      waits.push(r.headers['retry-after']);
      advance(Number(r.headers['retry-after']) * 1000 + 1);
      expect((await login('203.0.113.1', 'wrong', 'nobody')).status).toBe(401);
    }
    expect(waits).toEqual(['60', '120', '240', '480', '960', '1920', '3600', '3600']);
  });

  it('locks the account across many IPs after ten failures, at most 15 minutes', async () => {
    for (let i = 0; i < 10; i++) expect((await login(`198.51.100.${i}`, 'wrong')).status).toBe(401);
    const r = await login('198.51.100.200', PASSWORD);
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('60');
    // Unknown user names are not the account; they count only per IP.
    expect((await login('198.51.100.201', 'wrong', 'someone-else')).status).toBe(401);

    advance(60_001);
    expect((await login('198.51.100.200', 'wrong')).status).toBe(401);
    for (let i = 0; i < 6; i++) {
      const x = await login('198.51.100.200', 'wrong');
      expect(x.status).toBe(429);
      advance(Number(x.headers['retry-after']) * 1000 + 1);
      expect((await login(`198.51.100.${50 + i}`, 'wrong')).status).toBe(401);
    }
    const capped = await login('198.51.100.202', 'wrong');
    expect(capped.status).toBe(429);
    expect(capped.headers['retry-after']).toBe('900');
  });

  it('counts parallel attempts before checking them', async () => {
    const spy = vi.spyOn(bcrypt, 'compare');
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => login('203.0.113.9', 'wrong')),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 401)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(15);
      // Only five guesses were ever checked.
      expect(spy).toHaveBeenCalledTimes(5);
    } finally {
      spy.mockRestore();
    }
  });

  it('forgets an IP 24 hours after its last failure', async () => {
    for (let i = 0; i < 4; i++) await login('203.0.113.1', 'wrong', 'nobody');
    advance(24 * 60 * 60_000 + 1);
    for (let i = 0; i < 5; i++) expect((await login('203.0.113.1', 'wrong', 'nobody')).status).toBe(401);
    expect((await login('203.0.113.1', 'wrong', 'nobody')).status).toBe(429);
  });

  it('never reaches bcrypt while locked', async () => {
    for (let i = 0; i < 5; i++) await login('203.0.113.1', 'wrong');
    const spy = vi.spyOn(bcrypt, 'compare');
    try {
      expect((await login('203.0.113.1', PASSWORD)).status).toBe(429);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('keys on the address nginx appends, not the ones a client sends', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await request(ctx.app)
        .post('/api/auth/login')
        .set({ 'X-Forwarded-For': `203.0.113.${i}, 198.51.100.7` })
        .send({ username: ADMIN, password: 'wrong' });
      expect(r.status).toBe(401);
    }
    expect((await login('198.51.100.7', PASSWORD)).status).toBe(429);
  });

  it('exempts an IP that completed a full login from the account lock, not from its own', async () => {
    const home = '203.0.113.20';
    expect((await answer(home, await partialFor(home), 'name')).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await login(`198.51.100.${i}`, 'wrong')).status).toBe(401);
    // The account is locked for everyone else …
    expect((await login('198.51.100.99', PASSWORD)).status).toBe(429);
    // … but not from home.
    expect((await login(home, PASSWORD)).status).toBe(200);
    for (let i = 0; i < 5; i++) await login(home, 'wrong');
    expect((await login(home, PASSWORD)).status).toBe(429);
  });

  it('does not count a malformed body', async () => {
    for (let i = 0; i < 8; i++) {
      const r = await request(ctx.app).post('/api/auth/login').set(from('203.0.113.1')).send({});
      expect(r.status).toBe(400);
    }
    expect((await login('203.0.113.1', PASSWORD)).status).toBe(200);
  });
});

describe('security step', () => {
  it('locks after five wrong answers, a new partial token does not reset it, then recovers', async () => {
    const ip = '203.0.113.5';
    let partial = await partialFor(ip);
    for (let i = 0; i < 5; i++) expect((await answer(ip, partial, 'wrong')).status).toBe(401);

    // Logging in again (the password step succeeds) changes nothing here.
    partial = await partialFor(ip);
    const locked = await answer(ip, partial, 'name');
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBe('60');

    advance(60_001);
    partial = await partialFor(ip);
    const ok = await answer(ip, partial, 'name');
    expect(ok.status).toBe(200);
    expect((await request(ctx.app).get('/api/auth/verify').set(bearer(ok.body.token))).status).toBe(200);
  });

  it('locks the account from any IP once ten answers have failed', async () => {
    for (let i = 0; i < 10; i++) {
      const ip = `198.51.100.${i}`;
      expect((await answer(ip, await partialFor(ip), 'wrong')).status).toBe(401);
    }
    const ip = '198.51.100.99';
    expect((await answer(ip, await partialFor(ip), 'name')).status).toBe(429);
  });

  it('still locks the account on this step from a known IP', async () => {
    const home = '203.0.113.21';
    expect((await answer(home, await partialFor(home), 'name')).status).toBe(200);
    for (let i = 0; i < 10; i++) {
      const ip = `198.51.100.${i}`;
      expect((await answer(ip, await partialFor(ip), 'wrong')).status).toBe(401);
    }
    expect((await answer(home, await partialFor(home), 'name')).status).toBe(429);
  });

  it('counts parallel answers before checking them', async () => {
    const ip = '203.0.113.7';
    const partial = await partialFor(ip);
    const spy = vi.spyOn(bcrypt, 'compare');
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () => answer(ip, partial, 'wrong')));
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 401)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(15);
      // Only five answers were ever checked.
      expect(spy).toHaveBeenCalledTimes(5);
    } finally {
      spy.mockRestore();
    }
  });

  it('is counted apart from the password step', async () => {
    const ip = '203.0.113.6';
    const partial = await partialFor(ip);
    for (let i = 0; i < 5; i++) await answer(ip, partial, 'wrong');
    expect((await answer(ip, partial, 'name')).status).toBe(429);
    expect((await login(ip, PASSWORD)).status).toBe(200);
  });
});

describe('client address', () => {
  it('trusts X-Forwarded-For only from a loopback peer', () => {
    const trust = ctx.app.get('trust proxy fn') as (addr: string, i: number) => boolean;
    expect(trust('127.0.0.1', 0)).toBe(true);
    expect(trust('::1', 0)).toBe(true);
    expect(trust('203.0.113.1', 0)).toBe(false);
  });
});

describe('createAttemptLimiter', () => {
  it('backs the security step off to a full day per account', () => {
    let t = NOW.getTime();
    const l = createAttemptLimiter();
    let last = 0;
    for (let i = 0; i < 30; i++) {
      const g = l.begin('security', `192.0.2.${i}`, ADMIN, t);
      if (!g.allowed) {
        last = g.retryAfterMs;
        t += g.retryAfterMs + 1;
        i--;
      }
    }
    expect(last).toBe(24 * 60 * 60_000);
  });

  it('keys IPv6 by /64 and IPv4-mapped addresses as IPv4', () => {
    expect(clientKey('::ffff:203.0.113.4')).toBe('203.0.113.4');
    expect(clientKey('203.0.113.4')).toBe('203.0.113.4');
    expect(clientKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:DB8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
  });

  it('locks a whole IPv6 /64 together', () => {
    const t = NOW.getTime();
    const l = createAttemptLimiter();
    for (let i = 1; i <= 5; i++) l.begin('login', `2001:db8:1:2::${i}`, null, t);
    expect(l.begin('login', '2001:db8:1:2::ffff', null, t).allowed).toBe(false);
    expect(l.begin('login', '2001:db8:1:3::1', null, t).allowed).toBe(true);
  });

  it('keeps at most maxIpEntries IP entries, evicting unlocked ones first', () => {
    const t = NOW.getTime();
    const l = createAttemptLimiter({ maxIpEntries: 3 });
    for (let i = 0; i < 5; i++) l.begin('login', '192.0.2.1', null, t); // locked
    for (let i = 2; i < 10; i++) l.begin('login', `192.0.2.${i}`, null, t);
    expect(l.ipEntries()).toBe(3);
    expect(l.begin('login', '192.0.2.1', null, t).allowed).toBe(false);
  });
});
