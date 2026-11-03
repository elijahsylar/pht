import { addDays } from '../src/lib/dates.js';

// A fixed Open-Meteo daily answer, shaped like the real one, used by the
// route tests and by dev:fake. Seven days from `start`, one of each kind and a
// second SHOWERS: 0 sun, 2 part, 3 cloud, 61 rain, 95 storm, 45 fog, 80 rain.
export const FIXTURE_CODES = [0, 2, 3, 61, 95, 45, 80];

export function openMeteoBody(start: string) {
  const time = FIXTURE_CODES.map((_, i) => addDays(start, i));
  return {
    latitude: 0,
    longitude: 0,
    timezone: 'UTC',
    daily_units: { temperature_2m_max: '°F' },
    daily: {
      time,
      weather_code: FIXTURE_CODES,
      temperature_2m_max: [81.4, 80.2, 79.6, 78.9, 77.5, 76.8, 80.1],
      temperature_2m_min: [68.2, 67.4, 67.1, 66.6, 66.2, 65.9, 67.3],
      precipitation_probability_max: [5, 20, 35, 70, 90, 10, 60],
    },
  };
}

// A stand-in for global fetch that answers like Open-Meteo, with no network.
// `start` is read on every call so the forecast can follow "today".
export function fakeOpenMeteoFetch(start: () => string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(openMeteoBody(start())), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

// Placeholder location for tests: obviously not a real place of interest.
export const TEST_WEATHER_ENV = { WEATHER_LAT: '1.5', WEATHER_LON: '2.5' };
