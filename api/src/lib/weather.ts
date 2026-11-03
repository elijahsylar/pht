// The 7-day forecast for the desktop's Weather window, from Open-Meteo.
//
// The page never calls Open-Meteo itself (its CSP allows only same-origin
// requests); GET /api/weather does, through the service below. The location is
// WEATHER_LAT and WEATHER_LON in the server's .env — never in code, tests or
// docs — and the day boundary is app_timezone. One upstream call per hour at
// most: a good answer is cached for 60 minutes, and when Open-Meteo fails the
// last good copy is served marked `stale` until it answers again.

export type WeatherKind = 'sun' | 'part' | 'cloud' | 'rain' | 'storm' | 'fog';

// The word shown under the day name; the icon only decorates it.
export const KIND_LABEL: Record<WeatherKind, string> = {
  sun: 'SUNNY',
  part: 'PARTLY',
  cloud: 'CLOUDY',
  rain: 'SHOWERS',
  storm: 'STORMS',
  fog: 'FOG',
};

// WMO weather interpretation code (Open-Meteo's `weather_code`) → kind.
// There is no snow kind: snow, sleet and freezing rain are precipitation and
// read as SHOWERS. A code outside the table reads as CLOUDY.
export function wmoKind(code: number): WeatherKind {
  if (code === 0) return 'sun';
  if (code === 1 || code === 2) return 'part';
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 95 && code <= 99) return 'storm';
  if ((code >= 51 && code <= 67) || (code >= 71 && code <= 77) || (code >= 80 && code <= 86)) return 'rain';
  return 'cloud';
}

export interface ForecastDay {
  date: string;
  kind: WeatherKind;
  label: string;
  code: number;
  hi: number;
  lo: number;
  // Precipitation probability max, 0–100; null when Open-Meteo has none.
  rainPct: number | null;
}

export interface Forecast {
  days: ForecastDay[];
  // When this copy was fetched from Open-Meteo (ISO instant).
  updatedAt: string;
  // True when Open-Meteo failed and this is the last good copy.
  stale: boolean;
  unit: 'F';
}

export const OPEN_METEO_HOST = 'api.open-meteo.com';
export const CACHE_MS = 60 * 60 * 1000;
export const UPSTREAM_TIMEOUT_MS = 5000;

// Thrown by WeatherService.get when there is nothing to serve.
export class WeatherError extends Error {
  constructor(
    message: string,
    readonly status: 502 | 503,
  ) {
    super(message);
    this.name = 'WeatherError';
  }
}

// WEATHER_LAT / WEATHER_LON → numbers in range, or null (= not configured).
export function readLocation(env: Record<string, string | undefined>): { lat: number; lon: number } | null {
  const raw = [env.WEATHER_LAT, env.WEATHER_LON].map((v) => (v ?? '').trim());
  if (raw.some((v) => v === '' || !/^-?\d+(\.\d+)?$/.test(v))) return null;
  const [lat, lon] = raw.map(Number);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function forecastUrl(lat: number, lon: number, timezone: string): string {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    temperature_unit: 'fahrenheit',
    timezone,
    forecast_days: '7',
  });
  return `https://${OPEN_METEO_HOST}/v1/forecast?${q}`;
}

// Open-Meteo's daily block → days. Anything malformed throws, which the
// service treats exactly like an upstream failure.
export function parseForecast(body: unknown): ForecastDay[] {
  const daily = (body as { daily?: Record<string, unknown> } | null)?.daily;
  if (!daily || typeof daily !== 'object') throw new Error('no daily block');
  const col = (k: string) => {
    const v = daily[k];
    if (!Array.isArray(v)) throw new Error(`missing ${k}`);
    return v as unknown[];
  };
  const time = col('time');
  const code = col('weather_code');
  const hi = col('temperature_2m_max');
  const lo = col('temperature_2m_min');
  const pop = col('precipitation_probability_max');
  if (!time.length) throw new Error('no days');
  return time.slice(0, 7).map((date, i) => {
    const c = code[i];
    const h = hi[i];
    const l = lo[i];
    const p = pop[i];
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date');
    if (typeof c !== 'number' || typeof h !== 'number' || typeof l !== 'number') throw new Error('bad values');
    const kind = wmoKind(c);
    return {
      date,
      kind,
      label: KIND_LABEL[kind],
      code: c,
      hi: Math.round(h),
      lo: Math.round(l),
      rainPct: typeof p === 'number' ? Math.round(p) : null,
    };
  });
}

export interface WeatherService {
  get(timezone: string): Promise<Forecast>;
}

export function createWeatherService(
  opts: {
    fetch?: typeof fetch;
    env?: Record<string, string | undefined>;
    now?: () => number;
  } = {},
): WeatherService {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;

  // One copy per location and zone, so a changed setting never serves the old one.
  let cache: { key: string; at: number; days: ForecastDay[] } | null = null;
  let inFlight: { key: string; p: Promise<ForecastDay[]> } | null = null;

  async function fetchDays(url: string): Promise<ForecastDay[]> {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    return parseForecast(await res.json());
  }

  return {
    async get(timezone) {
      const loc = readLocation(env);
      if (!loc) throw new WeatherError('weather not configured', 503);
      const key = `${loc.lat},${loc.lon},${timezone}`;
      const t = now();
      const copy = cache && cache.key === key ? cache : null;
      if (copy && t - copy.at < CACHE_MS) {
        return { days: copy.days, updatedAt: new Date(copy.at).toISOString(), stale: false, unit: 'F' };
      }

      // Concurrent requests share one upstream call.
      if (!inFlight || inFlight.key !== key) {
        const p = fetchDays(forecastUrl(loc.lat, loc.lon, timezone));
        inFlight = { key, p };
        void p
          .catch(() => undefined)
          .finally(() => {
            if (inFlight?.p === p) inFlight = null;
          });
      }
      try {
        const days = await inFlight.p;
        const at = now();
        cache = { key, at, days };
        return { days, updatedAt: new Date(at).toISOString(), stale: false, unit: 'F' };
      } catch (err) {
        console.error(`[weather] upstream failed: ${err instanceof Error ? err.message : String(err)}`);
        if (copy) {
          return { days: copy.days, updatedAt: new Date(copy.at).toISOString(), stale: true, unit: 'F' };
        }
        throw new WeatherError('weather unavailable', 502);
      }
    },
  };
}
