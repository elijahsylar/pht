import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { API_TOKEN_HASH_KEY, generateApiToken, hashApiToken } from '../src/lib/apiToken.js';
import { createWeatherService } from '../src/lib/weather.js';
import { createFakeStore, type FakeStore } from './fakeStore.js';
import { TEST_WEATHER_ENV, fakeOpenMeteoFetch } from './weatherFixture.js';

// Shared fixture for the route tests: the real app over the seeded fake store,
// with the clock pinned so "today" and the date guards are deterministic.

export const NOW = new Date('2026-10-13T20:00:00Z'); // 20:00 UTC on the 13th
export const TODAY = '2026-10-13';
export const TOMORROW = '2026-10-14';

export const ADMIN = 'owner';
export const PASSWORD = 'correct horse battery';

process.env.JWT_SECRET = 'test-only-secret';
process.env.ADMIN_USERNAME = ADMIN;
// Low cost factor: this hash only has to exist, not resist anything.
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

export function fullJwt(): string {
  return jwt.sign({ username: ADMIN, stage: 'full' }, process.env.JWT_SECRET as string, {
    expiresIn: '5m',
  });
}

export function partialJwt(): string {
  return jwt.sign({ username: ADMIN, stage: 'partial' }, process.env.JWT_SECRET as string, {
    expiresIn: '5m',
  });
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export interface Ctx {
  store: FakeStore;
  app: ReturnType<typeof createApp>;
  jwt: Record<string, string>;
  // Seeded habit ids by slug.
  id: Record<string, number>;
  // Issue the API token the way pht-rotate-token.sh does: store only its hash.
  issueApiToken(): Promise<string>;
}

// Registers the hooks and returns a holder that is repopulated for every test.
export function useApp(): Ctx {
  const ctx = {} as Ctx;

  beforeEach(async () => {
    // Fake only Date. Faking timers too would stall supertest's sockets.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const store = createFakeStore({ seed: true });
    // The seed "ran" a month ago, so the created_at floor is out of the way
    // unless a test moves it.
    const habits = await store.listHabits({ includeRetired: true });
    for (const h of habits) store.setCreatedAt(h.id, new Date('2026-09-01T12:00:00Z'));

    ctx.store = store;
    // Weather over a fake Open-Meteo: these tests never touch the network.
    const weather = createWeatherService({ env: TEST_WEATHER_ENV, fetch: fakeOpenMeteoFetch(() => TODAY) });
    ctx.app = createApp(store, { log: false, weather });
    ctx.jwt = bearer(fullJwt());
    ctx.id = Object.fromEntries(habits.map((h) => [h.slug, h.id]));
    ctx.issueApiToken = async () => {
      const token = generateApiToken();
      await store.setSetting(API_TOKEN_HASH_KEY, hashApiToken(token));
      return token;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  return ctx;
}
