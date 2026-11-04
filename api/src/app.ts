import express, { type Express } from 'express';
import type { Store } from './db/store.js';
import type { AttemptLimiter } from './lib/attemptLimiter.js';
import { requireAuth, requireAuthOrToken } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/logger.js';
import { createWireService, type WireService } from './lib/wireService.js';
import { articleRouter } from './routes/article.js';
import { authRouter } from './routes/auth.js';
import { checksRouter } from './routes/checks.js';
import { createWeatherService, type WeatherService } from './lib/weather.js';
import { habitsRouter } from './routes/habits.js';
import { healthRouter } from './routes/health.js';
import { historyRouter } from './routes/history.js';
import { importMiniRouter } from './routes/importMini.js';
import { learnedRouter } from './routes/learned.js';
import { notesRouter } from './routes/notes.js';
import { settingsRouter } from './routes/settings.js';
import { todayRouter } from './routes/today.js';
import { weatherRouter } from './routes/weather.js';

// The whole HTTP surface, built over a Store so tests can run it against the
// in-memory fake. index.ts supplies the MySQL one and listens.
//
// No CORS middleware, on purpose: the page is served same-origin by nginx, and
// the widget and the server-side mail proxy are not browsers. With no
// Access-Control-Allow-Origin header, no other site's script can read a reply.
//
// `weather` defaults to the real Open-Meteo service reading WEATHER_LAT/LON
// from the environment; tests and dev:fake pass one with their own fetch.
// `wire` likewise defaults to the real AI Wire service over the configured
// sources.
export function createApp(
  store: Store,
  opts: { log?: boolean; weather?: WeatherService; wire?: WireService; limiter?: AttemptLimiter } = {},
): Express {
  const app = express();
  const anyAuth = requireAuthOrToken(store);
  const jwtAuth = requireAuth(store);

  app.disable('x-powered-by');
  // nginx on the same host appends the client to X-Forwarded-For; trusting only
  // a loopback peer makes req.ip that client (the login attempt limits key on
  // it) while a forged header from anywhere else is ignored.
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '1mb' }));
  if (opts.log !== false) app.use(requestLogger);

  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter(store, opts.limiter));

  // Open to the API token as well as the browser's JWT.
  app.use('/api/today', anyAuth, todayRouter(store));
  app.use('/api/history', anyAuth, historyRouter(store));
  app.use('/api/weather', anyAuth, weatherRouter(store, opts.weather ?? createWeatherService()));
  app.use('/api/article', anyAuth, articleRouter(store, opts.wire ?? createWireService(store)));
  app.use('/api/checks', anyAuth, checksRouter(store));
  app.use('/api/notes', anyAuth, notesRouter(store));
  app.use('/api/learned', anyAuth, learnedRouter(store));
  // GETs for both; POST and PATCH add jwtOnly inside the router.
  app.use('/api/habits', anyAuth, habitsRouter(store));

  // JWT only.
  app.use('/api/settings', jwtAuth, settingsRouter(store));
  app.use('/api/import', jwtAuth, importMiniRouter(store));

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use(errorHandler);
  return app;
}
