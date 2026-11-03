import { describe, expect, it, vi } from 'vitest';
import { API_BASE, ApiError, RENEW_HEADER, TOKEN_KEY, createApi, type TokenStore } from './api';

function store(initial: Record<string, string> = {}): TokenStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });

function setup(responses: (Response | Error)[], initial: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...responses];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  const s = store(initial);
  const api = createApi({ baseUrl: '/api/', fetch: fetchMock as typeof fetch, storage: s });
  return { api, calls, s };
}

const headers = (init: RequestInit) => init.headers as Record<string, string>;

describe('two-step login', () => {
  it('sends the partial token only to verify-security and stores only the full one', async () => {
    const { api, calls, s } = setup([
      json(200, { partialToken: 'partial.jwt' }),
      json(200, { token: 'full.jwt' }),
    ]);
    const partial = await api.login('owner', 'pw');
    expect(partial).toBe('partial.jwt');
    expect(s.data.size).toBe(0);
    await api.verifySecurity(partial, 'answer');

    expect(calls[0].url).toBe('/api/auth/login');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ username: 'owner', password: 'pw' });
    expect(headers(calls[0].init).Authorization).toBeUndefined();
    expect(headers(calls[1].init).Authorization).toBe('Bearer partial.jwt');
    expect(s.data.get(TOKEN_KEY)).toBe('full.jwt');
    expect(api.hasToken()).toBe(true);
  });

  it('reports bad credentials as an http error, not a logout', async () => {
    const { api, s } = setup([json(401, { error: 'invalid credentials' })], { [TOKEN_KEY]: 'keep' });
    const err = await api.login('owner', 'nope').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ kind: 'http', status: 401, message: 'invalid credentials' });
    expect(s.data.get(TOKEN_KEY)).toBe('keep');
  });
});

describe('authenticated calls', () => {
  it('sends the stored token, encodes dates, and keeps paths under the base', async () => {
    const { api, calls } = setup(
      [json(200, { date: '2026-10-13', habits: [] }), json(200, { done: true }), json(200, { done: false })],
      { [TOKEN_KEY]: 'full.jwt' },
    );
    await api.today('2026-10-13');
    await api.check(3, '2026-10-13');
    await api.uncheck(3, '2026-10-13');
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/today?date=2026-10-13',
      'PUT /api/checks/3/2026-10-13',
      'DELETE /api/checks/3/2026-10-13',
    ]);
    for (const c of calls) {
      expect(headers(c.init).Authorization).toBe('Bearer full.jwt');
      expect(c.init.cache).toBe('no-store');
    }
    // No body, so no content type on a bodiless request.
    expect(headers(calls[1].init)['Content-Type']).toBeUndefined();
  });

  it('builds query strings and bodies for the other routes', async () => {
    const { api, calls } = setup(
      [
        json(200, { days: [{ date: '2026-10-13', done: true }] }),
        json(200, []),
        json(200, { date: '2026-10-13', line: 'hi' }),
        json(200, { id: 1 }),
        json(201, { id: 7 }),
      ],
      { [TOKEN_KEY]: 't' },
    );
    expect(await api.history(4, 14, '2026-10-13')).toEqual([{ date: '2026-10-13', done: true }]);
    await api.notes('2026-09-30', '2026-10-13');
    await api.putNote('2026-10-13', 'hi');
    await api.patchHabit(1, { rampText: 'x', retired: false });
    await api.createHabit({ slug: 'floss', label: 'Floss' });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/habits/4/history?days=14&date=2026-10-13',
      'GET /api/notes?from=2026-09-30&to=2026-10-13',
      'PUT /api/notes/2026-10-13',
      'PATCH /api/habits/1',
      'POST /api/habits',
    ]);
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ line: 'hi' });
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ rampText: 'x', retired: false });
    expect(headers(calls[3].init)['Content-Type']).toBe('application/json');
  });

  it('asks for Learned with its query, saves an entry, and reads the queue from Next', async () => {
    const page = { entries: [{ date: '2026-10-13', text: 'Rust borrows', updatedAt: 'x' }], total: 1, limit: 50, offset: 0 };
    const { api, calls } = setup(
      [
        json(200, page),
        json(200, page),
        json(200, { date: '2026-10-13', text: 'Rust borrows' }),
        json(200, { article: { title: 'Next one' }, queue: 2 }),
      ],
      { [TOKEN_KEY]: 't' },
    );
    expect(await api.learned({ q: 'rust & tea', limit: 50, offset: 50 })).toEqual(page);
    await api.learned();
    await api.putLearned('2026-10-13', 'Rust borrows');
    expect(await api.skipArticle('2026-10-13')).toEqual({ article: { title: 'Next one' }, queue: 2 });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/learned?q=rust+%26+tea&limit=50&offset=50',
      'GET /api/learned',
      'PUT /api/learned/2026-10-13',
      'POST /api/article/skip',
    ]);
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ text: 'Rust borrows' });
  });

  it('clears the token and raises unauthorized on a 401', async () => {
    const { api, s } = setup([json(401, { error: 'invalid token' })], { [TOKEN_KEY]: 'stale' });
    const err = await api.today('2026-10-13').catch((e) => e);
    expect(err).toMatchObject({ kind: 'unauthorized', status: 401 });
    expect(s.data.has(TOKEN_KEY)).toBe(false);
    expect(api.hasToken()).toBe(false);
  });

  it('treats a failed fetch and a 502/503/504 as unreachable', async () => {
    const { api, s } = setup(
      [new TypeError('Failed to fetch'), json(502, undefined), json(503, undefined), json(504, undefined)],
      { [TOKEN_KEY]: 't' },
    );
    for (let i = 0; i < 4; i += 1) {
      const err = await api.today('2026-10-13').catch((e) => e);
      expect(err).toMatchObject({ kind: 'network', message: "Can't reach PHT" });
    }
    // Being offline is not a reason to log out.
    expect(s.data.get(TOKEN_KEY)).toBe('t');
  });

  it("treats a 502/503 carrying pht-api's own error as an answer, not an outage", async () => {
    const { api, s } = setup(
      [
        json(503, { error: 'weather not configured' }),
        json(502, { error: 'weather unavailable' }),
        new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
      ],
      { [TOKEN_KEY]: 't' },
    );
    expect(await api.weather().catch((e) => e)).toMatchObject({ kind: 'http', status: 503, message: 'weather not configured' });
    expect(await api.weather().catch((e) => e)).toMatchObject({ kind: 'http', status: 502, message: 'weather unavailable' });
    // nginx's own error page is still "the API is down".
    expect(await api.weather().catch((e) => e)).toMatchObject({ kind: 'network', status: 502 });
    expect(s.data.get(TOKEN_KEY)).toBe('t');
  });

  it('asks for the history matrix and the weather with the stored token', async () => {
    const { api, calls } = setup([json(200, { dates: [] }), json(200, { days: [] })], { [TOKEN_KEY]: 't' });
    await api.historyMatrix(30, '2026-10-14');
    await api.weather();
    expect(calls.map((c) => c.url)).toEqual(['/api/history?days=30&date=2026-10-14', '/api/weather']);
    expect(headers(calls[1].init).Authorization).toBe('Bearer t');
  });

  it("surfaces the API's error text, or the status when there is none", async () => {
    const { api } = setup(
      [json(409, { error: 'habit is retired' }), new Response('oops', { status: 500 })],
      { [TOKEN_KEY]: 't' },
    );
    expect(await api.check(1, '2026-10-13').catch((e) => e)).toMatchObject({
      kind: 'http',
      status: 409,
      message: 'habit is retired',
    });
    expect(await api.check(1, '2026-10-13').catch((e) => e)).toMatchObject({
      kind: 'http',
      status: 500,
      message: 'HTTP 500',
    });
  });

  it('survives storage that throws (private mode)', async () => {
    const throwing: TokenStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const api = createApi({
      baseUrl: '/api',
      fetch: (async () => json(200, { token: 'x' })) as typeof fetch,
      storage: throwing,
    });
    expect(api.hasToken()).toBe(false);
    await expect(api.verifySecurity('p', 'a')).resolves.toBeUndefined();
    expect(() => api.logout()).not.toThrow();
  });
});

describe('the API base', () => {
  it('is always same-origin /api', () => {
    expect(API_BASE).toBe('/api');
  });
});

describe('session renewal', () => {
  it('replaces the stored token when the API sends a fresh one', async () => {
    const { api, s } = setup(
      [json(200, { habits: [] }, { [RENEW_HEADER]: 'renewed.jwt' }), json(200, { habits: [] })],
      { [TOKEN_KEY]: 'old.jwt' },
    );
    await api.today('2026-10-13');
    expect(s.data.get(TOKEN_KEY)).toBe('renewed.jwt');
    await api.today('2026-10-13');
    expect(s.data.get(TOKEN_KEY)).toBe('renewed.jwt');
  });

  it('sends the renewed token on the next request', async () => {
    const { api, calls } = setup(
      [json(200, {}, { [RENEW_HEADER]: 'renewed.jwt' }), json(200, {})],
      { [TOKEN_KEY]: 'old.jwt' },
    );
    await api.today('2026-10-13');
    await api.today('2026-10-13');
    expect(headers(calls[1].init).Authorization).toBe('Bearer renewed.jwt');
  });

  it('takes a renewal on an error response, but never on a 401', async () => {
    const a = setup([json(409, { error: 'habit is retired' }, { [RENEW_HEADER]: 'r1' })], {
      [TOKEN_KEY]: 'old',
    });
    await a.api.check(1, '2026-10-13').catch(() => undefined);
    expect(a.s.data.get(TOKEN_KEY)).toBe('r1');

    const b = setup([json(401, { error: 'session ended' }, { [RENEW_HEADER]: 'r2' })], {
      [TOKEN_KEY]: 'old',
    });
    await b.api.today('2026-10-13').catch(() => undefined);
    expect(b.s.data.has(TOKEN_KEY)).toBe(false);
  });

  it('ignores the header on the login steps', async () => {
    const { api, s } = setup([json(200, { partialToken: 'p' }, { [RENEW_HEADER]: 'nope' })]);
    await api.login('owner', 'pw');
    expect(s.data.has(TOKEN_KEY)).toBe(false);
  });
});

describe('logoutEverywhere', () => {
  it('posts /auth/logout with the token, then forgets it', async () => {
    const { api, calls, s } = setup([json(200, { ok: true })], { [TOKEN_KEY]: 't' });
    await api.logoutEverywhere();
    expect(`${calls[0].init.method} ${calls[0].url}`).toBe('POST /api/auth/logout');
    expect(headers(calls[0].init).Authorization).toBe('Bearer t');
    expect(s.data.has(TOKEN_KEY)).toBe(false);
  });

  it('forgets the token here even when PHT cannot be reached', async () => {
    const { api, s } = setup([new TypeError('offline')], { [TOKEN_KEY]: 't' });
    await expect(api.logoutEverywhere()).rejects.toMatchObject({ kind: 'network' });
    expect(s.data.has(TOKEN_KEY)).toBe(false);
  });
});
