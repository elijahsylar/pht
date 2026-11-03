import { Router } from 'express';
import { getAppTimeZone } from '../db/settings.js';
import type { Store } from '../db/store.js';
import { WeatherError, type WeatherService } from '../lib/weather.js';

// GET /api/weather — the 7-day forecast for the desktop (see lib/weather.ts).
//   200 { days, updatedAt, stale, unit }   stale: true = Open-Meteo is failing
//   503 { error: 'weather not configured' } WEATHER_LAT / WEATHER_LON unset
//   502 { error: 'weather unavailable' }    Open-Meteo failing, no copy yet
export function weatherRouter(store: Store, weather: WeatherService): Router {
  const router = Router();

  router.get('/', async (_req, res, next) => {
    try {
      const forecast = await weather.get(await getAppTimeZone(store));
      res.set('Cache-Control', 'no-store').json(forecast);
    } catch (err) {
      if (err instanceof WeatherError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  return router;
}
