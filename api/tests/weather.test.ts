import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  CACHE_MS,
  KIND_LABEL,
  OPEN_METEO_HOST,
  UPSTREAM_TIMEOUT_MS,
  createWeatherService,
  parseForecast,
  readLocation,
  wmoKind,
  type WeatherKind,
} from '../src/lib/weather.js';
import { createFakeStore } from './fakeStore.js';
import { TODAY, bearer, fullJwt, useApp } from './helpers.js';
import { FIXTURE_CODES, TEST_WEATHER_ENV, openMeteoBody } from './weatherFixture.js';

// No test here may reach the network: the real fetch is replaced with one
// that fails the test if anything calls it.
let realFetchCalls = 0;
beforeEach(() => {
  realFetchCalls = 0;
  vi.stubGlobal('fetch', async () => {
    realFetchCalls += 1;
    throw new Error('the real fetch was called');
  });
});
afterEach(() => {
  expect(realFetchCalls).toBe(0);
  vi.unstubAllGlobals();
});

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

// A scriptable upstream: each call takes the next answer, recording the URL.
function upstream(...answers: (unknown | Error | number)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    if (typeof a === 'number') return new Response('{}', { status: a });
    return ok(a);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('wmoKind', () => {
  const table: [number[], WeatherKind][] = [
    [[0], 'sun'],
    [[1, 2], 'part'],
    [[3], 'cloud'],
    [[45, 48], 'fog'],
    [[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86], 'rain'],
    [[95, 96, 99], 'storm'],
    [[4, 10, 44, 50, 90, 100, -1], 'cloud'],
  ];
  for (const [codes, kind] of table) {
    it(`${codes.join(', ')} → ${kind}`, () => {
      for (const c of codes) expect(wmoKind(c), String(c)).toBe(kind);
    });
  }

  it('has a label for every kind', () => {
    expect(KIND_LABEL).toEqual({
      sun: 'SUNNY',
      part: 'PARTLY',
      cloud: 'CLOUDY',
      rain: 'SHOWERS',
      storm: 'STORMS',
      fog: 'FOG',
    });
  });
});

describe('readLocation', () => {
  it('is null unless both are set to numbers in range', () => {
    expect(readLocation({})).toBeNull();
    expect(readLocation({ WEATHER_LAT: '1.5' })).toBeNull();
    expect(readLocation({ WEATHER_LAT: '', WEATHER_LON: '' })).toBeNull();
    expect(readLocation({ WEATHER_LAT: 'north', WEATHER_LON: '2' })).toBeNull();
    expect(readLocation({ WEATHER_LAT: '91', WEATHER_LON: '2' })).toBeNull();
    expect(readLocation({ WEATHER_LAT: '1', WEATHER_LON: '-181' })).toBeNull();
    expect(readLocation({ WEATHER_LAT: ' -1.25 ', WEATHER_LON: '2.5' })).toEqual({ lat: -1.25, lon: 2.5 });
  });
});

describe('parseForecast', () => {
  it('maps the daily block to rounded days with a kind and label', () => {
    const days = parseForecast(openMeteoBody(TODAY));
    expect(days).toHaveLength(7);
    expect(days.map((d) => d.kind)).toEqual(['sun', 'part', 'cloud', 'rain', 'storm', 'fog', 'rain']);
    expect(days[0]).toEqual({ date: TODAY, kind: 'sun', label: 'SUNNY', code: 0, hi: 81, lo: 68, rainPct: 5 });
  });

  it('throws on anything malformed', () => {
    expect(() => parseForecast(null)).toThrow();
    expect(() => parseForecast({})).toThrow();
    expect(() => parseForecast({ daily: { time: [] } })).toThrow();
    const bad = openMeteoBody(TODAY);
    (bad.daily.temperature_2m_max as unknown[])[2] = 'hot';
    expect(() => parseForecast(bad)).toThrow();
  });

  it('allows a missing rain probability', () => {
    const body = openMeteoBody(TODAY);
    (body.daily.precipitation_probability_max as unknown[])[0] = null;
    expect(parseForecast(body)[0].rainPct).toBeNull();
  });
});

describe('createWeatherService', () => {
  it('is "not configured" without a location, and never calls upstream', async () => {
    const up = upstream(openMeteoBody(TODAY));
    const svc = createWeatherService({ env: {}, fetch: up.fetch });
    await expect(svc.get('UTC')).rejects.toMatchObject({ status: 503, message: 'weather not configured' });
    expect(up.calls).toHaveLength(0);
  });

  it('asks Open-Meteo for 7 days in °F, in the app timezone, with a 5 s timeout', async () => {
    const up = upstream(openMeteoBody(TODAY));
    const svc = createWeatherService({ env: TEST_WEATHER_ENV, fetch: up.fetch });
    const f = await svc.get('Pacific/Tahiti');
    expect(f.stale).toBe(false);
    expect(f.unit).toBe('F');
    const url = new URL(up.calls[0].url);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe(OPEN_METEO_HOST);
    expect(url.pathname).toBe('/v1/forecast');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: '1.5',
      longitude: '2.5',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      temperature_unit: 'fahrenheit',
      timezone: 'Pacific/Tahiti',
      forecast_days: '7',
    });
    expect(up.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(UPSTREAM_TIMEOUT_MS).toBe(5000);
  });

  it('gives up on a hung upstream when the timeout fires', async () => {
    let seen: AbortSignal | undefined;
    const fetch = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        seen = init?.signal ?? undefined;
        seen?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof globalThis.fetch;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Exercise the abort path without waiting 5 s: the signal is real, so
    // firing it ends the request the same way the timeout would.
    const svc = createWeatherService({ env: TEST_WEATHER_ENV, fetch });
    const p = svc.get('UTC');
    await vi.waitFor(() => expect(seen).toBeDefined());
    (seen as AbortSignal & { dispatchEvent(e: Event): boolean }).dispatchEvent(new Event('abort'));
    await expect(p).rejects.toMatchObject({ status: 502 });
    err.mockRestore();
  });

  it('caches a good answer for 60 minutes, then fetches again', async () => {
    let t = 1_000_000;
    const up = upstream(openMeteoBody(TODAY));
    const svc = createWeatherService({ env: TEST_WEATHER_ENV, fetch: up.fetch, now: () => t });
    const first = await svc.get('UTC');
    t += CACHE_MS - 1;
    const second = await svc.get('UTC');
    expect(up.calls).toHaveLength(1);
    expect(second.updatedAt).toBe(first.updatedAt);
    t += 2;
    const third = await svc.get('UTC');
    expect(up.calls).toHaveLength(2);
    expect(third.updatedAt).not.toBe(first.updatedAt);
  });

  it('keeps one copy per zone: a changed zone fetches', async () => {
    const up = upstream(openMeteoBody(TODAY));
    const svc = createWeatherService({ env: TEST_WEATHER_ENV, fetch: up.fetch });
    await svc.get('UTC');
    await svc.get('Pacific/Tahiti');
    expect(up.calls).toHaveLength(2);
  });

  it('shares one upstream call between concurrent requests', async () => {
    const up = upstream(openMeteoBody(TODAY));
    const svc = createWeatherService({ env: TEST_WEATHER_ENV, fetch: up.fetch });
    await Promise.all([svc.get('UTC'), svc.get('UTC'), svc.get('UTC')]);
    expect(up.calls).toHaveLength(1);
  });

  it('serves the last good copy marked stale when upstream fails, until it recovers', async () => {
    let t = 1_000_000;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const up = upstream(openMeteoBody(TODAY), new Error('ECONNRESET'), 500, { daily: {} }, openMeteoBody(TODAY));
    const svc = createWeatherService({ env: TEST_WEATHER_ENV, fetch: up.fetch, now: () => t });
    const good = await svc.get('UTC');
    for (let i = 0; i < 3; i += 1) {
      t += CACHE_MS + 1;
      const s = await svc.get('UTC');
      expect(s.stale, `failure ${i}`).toBe(true);
      expect(s.updatedAt).toBe(good.updatedAt);
      expect(s.days).toEqual(good.days);
    }
    t += 1;
    const back = await svc.get('UTC');
    expect(back.stale).toBe(false);
    expect(up.calls).toHaveLength(5);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('is "unavailable" when upstream fails with no copy to fall back on', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const svc = createWeatherService({ env: TEST_WEATHER_ENV, fetch: upstream(503).fetch });
    await expect(svc.get('UTC')).rejects.toMatchObject({ status: 502, message: 'weather unavailable' });
    err.mockRestore();
  });
});

describe('GET /api/weather', () => {
  const ctx = useApp();

  it('returns the forecast with every kind, for a login or the API token', async () => {
    const res = await request(ctx.app).get('/api/weather').set(ctx.jwt);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.stale).toBe(false);
    expect(res.body.days.map((d: { kind: string }) => d.kind)).toEqual(
      FIXTURE_CODES.map((c) => wmoKind(c)),
    );
    expect(new Set(res.body.days.map((d: { kind: string }) => d.kind))).toEqual(
      new Set(['sun', 'part', 'cloud', 'rain', 'storm', 'fog']),
    );
    const token = await ctx.issueApiToken();
    expect((await request(ctx.app).get('/api/weather').set(bearer(token))).status).toBe(200);
  });

  it('401s without credentials', async () => {
    expect((await request(ctx.app).get('/api/weather')).status).toBe(401);
  });

  it('uses app_timezone for the day boundary', async () => {
    const up = upstream(openMeteoBody(TODAY));
    const store = createFakeStore({ seed: true });
    await store.setSetting('app_timezone', 'Pacific/Tahiti');
    const app = createApp(store, { log: false, weather: createWeatherService({ env: TEST_WEATHER_ENV, fetch: up.fetch }) });
    await request(app).get('/api/weather').set(bearer(fullJwt()));
    expect(new URL(up.calls[0].url).searchParams.get('timezone')).toBe('Pacific/Tahiti');
  });

  it('503s "weather not configured" with no location', async () => {
    const app = createApp(createFakeStore({ seed: true }), {
      log: false,
      weather: createWeatherService({ env: {}, fetch: upstream(openMeteoBody(TODAY)).fetch }),
    });
    const res = await request(app).get('/api/weather').set(bearer(fullJwt()));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'weather not configured' });
  });

  it('defaults to reading the location from the environment', async () => {
    // No weather option: the real service, over process.env, which has none
    // here — so a 503, and the stubbed global fetch is never reached.
    delete process.env.WEATHER_LAT;
    delete process.env.WEATHER_LON;
    const app = createApp(createFakeStore({ seed: true }), { log: false });
    const res = await request(app).get('/api/weather').set(bearer(fullJwt()));
    expect(res.status).toBe(503);
  });

  it('502s with no copy, then serves stale after a success', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let t = 5_000_000;
    const up = upstream(500, openMeteoBody(TODAY), new Error('down'));
    const app = createApp(createFakeStore({ seed: true }), {
      log: false,
      weather: createWeatherService({ env: TEST_WEATHER_ENV, fetch: up.fetch, now: () => t }),
    });
    const auth = bearer(fullJwt());
    const first = await request(app).get('/api/weather').set(auth);
    expect(first.status).toBe(502);
    expect(first.body).toEqual({ error: 'weather unavailable' });
    expect((await request(app).get('/api/weather').set(auth)).body.stale).toBe(false);
    t += CACHE_MS + 1;
    const stale = await request(app).get('/api/weather').set(auth);
    expect(stale.status).toBe(200);
    expect(stale.body.stale).toBe(true);
    err.mockRestore();
  });

  it('sends no CORS headers', async () => {
    const res = await request(ctx.app).get('/api/weather').set(ctx.jwt).set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

