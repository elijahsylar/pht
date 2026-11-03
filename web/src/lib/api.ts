// The only module that talks to pht-api, always at the same-origin path /api
// (nginx in production, Vite's proxy in dev and preview).
//
// Auth: the two-step login (password, then security answer) ends in a 30-day
// sliding JWT, stored in localStorage under `pht:token` (the same key the
// React app used) and sent as `Authorization: Bearer`. When the API answers
// with a fresh token in the X-PHT-Token header (the last 7 days of a token's
// life), it replaces the stored one. A 401 on any authenticated call clears it
// and raises an `unauthorized` ApiError, which sends the page back to Login.

export interface Milestone {
  next: number;
  progress: number;
}

// A habit's schedule (pht-api src/lib/schedule.ts). Weekdays: 0 = Sunday.
export type Schedule =
  | { kind: 'daily' }
  | { kind: 'every_other_day'; anchor: string }
  | { kind: 'weekdays'; days: number[] };

export interface TodayHabit {
  id: number;
  slug: string;
  label: string;
  done: boolean;
  // False on a rest day: shown REST, dimmed, still checkable; a check there
  // leaves the streak alone.
  due: boolean;
  schedule: Schedule;
  streak: number;
  best: number;
  totalDone: number;
  rampText: string | null;
  milestone: Milestone;
}

export interface Today {
  date: string;
  doneCount: number;
  total: number;
  // The habits due on `date`, and how many of those are done.
  dueCount: number;
  dueDone: number;
  note: string | null;
  // "What new thing did I learn today?" for `date` (SIDE B).
  learned: string | null;
  habits: TodayHabit[];
}

export interface Habit {
  id: number;
  slug: string;
  label: string;
  sort: number;
  rampText: string | null;
  createdAt: string;
  retiredAt: string | null;
  schedule: Schedule;
  // The day the current schedule took effect; null = always.
  scheduleFrom: string | null;
}

export interface HistoryDay {
  date: string;
  done: boolean;
  due: boolean;
}

export interface Note {
  date: string;
  line: string;
  updatedAt: string;
}

export interface Learned {
  date: string;
  text: string;
  updatedAt: string;
}

// GET /learned: one page, newest first; `total` counts every match.
export interface LearnedPage {
  entries: Learned[];
  total: number;
  limit: number;
  offset: number;
}

export interface LearnedQuery {
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

// GET /history: the desktop's matrix. `done[i]` is for `dates[i]`, oldest first.
export interface HistoryMatrix {
  start: string;
  end: string;
  dates: string[];
  // `due[i]` false = a rest day for that habit (drawn hatched, never missed).
  habits: { id: number; slug: string; label: string; done: boolean[]; due: boolean[]; streak: number }[];
  stats: { completionPct: number; bestLiveStreak: number; allDoneDays: number };
}

export type WeatherKind = 'sun' | 'part' | 'cloud' | 'rain' | 'storm' | 'fog';

export interface ForecastDay {
  date: string;
  kind: WeatherKind;
  label: string;
  code: number;
  hi: number;
  lo: number;
  rainPct: number | null;
}

// GET /weather. A 503 'weather not configured' and a 502 'weather unavailable'
// arrive as `http` ApiErrors with those messages.
export interface Forecast {
  days: ForecastDay[];
  updatedAt: string;
  stale: boolean;
  unit: 'F';
}

export interface HabitPatch {
  label?: string;
  sort?: number;
  rampText?: string | null;
  retired?: boolean;
  schedule?: Schedule;
  // The first day the new schedule applies: the client's today.
  scheduleFrom?: string;
}

// AI Wire: the day's article, the same on every device.
export interface Article {
  date: string;
  url: string;
  title: string;
  source: string;
  publishedAt: string;
  excerpt: string | null;
  // The tier tags it matched, main one first ("Claude Code"); may be empty
  // for old days.
  topics: string[];
  read: boolean;
}

// GET /article. `status` 'no-signal' = nothing qualifies (or every source
// failed and nothing is cached): `article` is null. `queue` is how many
// qualifying articles wait behind today's (0 for a day that is not live).
// `past` is the seven days before, newest first.
export interface Wire {
  date: string;
  status: 'ok' | 'no-signal';
  article: Article | null;
  queue: number;
  past: Article[];
}

// network      the request never got an answer from pht-api (offline, DNS,
//              or nginx answering 502/503/504 because the API is down). A
//              502/503 with pht-api's own JSON `error` body is `http`: the API
//              answered (GET /weather uses both).
// unauthorized 401 on an authenticated call: the token is gone or expired
// http         pht-api answered with an error; `message` is its `error` text
export type ApiErrorKind = 'network' | 'unauthorized' | 'http';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface TokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const TOKEN_KEY = 'pht:token';
export const API_BASE = '/api';
export const RENEW_HEADER = 'X-PHT-Token';

const GATEWAY_DOWN = new Set([502, 503, 504]);

export function createApi(opts: {
  baseUrl: string;
  fetch: typeof fetch;
  storage: TokenStore;
}) {
  const base = opts.baseUrl.replace(/\/+$/, '');

  const getToken = () => {
    try {
      return opts.storage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  };
  const setToken = (t: string) => {
    try {
      opts.storage.setItem(TOKEN_KEY, t);
    } catch {
      /* private mode: the session simply won't survive a reload */
    }
  };
  const clearToken = () => {
    try {
      opts.storage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing stored */
    }
  };

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    auth: { bearer?: string | null; session?: boolean } = { session: true },
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const bearer = auth.session ? getToken() : auth.bearer;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    let res: Response;
    try {
      res = await opts.fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch {
      throw new ApiError("Can't reach PHT", 'network', 0);
    }

    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    const apiError =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : null;

    if (GATEWAY_DOWN.has(res.status) && apiError === null) {
      throw new ApiError("Can't reach PHT", 'network', res.status);
    }

    // A renewed session token. Only for the stored session: never for the
    // login steps, and never on a 401 (that token is already dead).
    const renewed = res.headers.get(RENEW_HEADER);
    if (renewed && auth.session && res.status !== 401) setToken(renewed);

    if (res.status === 401 && auth.session) {
      clearToken();
      throw new ApiError('Please log in again', 'unauthorized', 401);
    }
    if (!res.ok) throw new ApiError(apiError ?? `HTTP ${res.status}`, 'http', res.status);
    return data as T;
  }

  const q = (params: Record<string, string | number | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
    const str = s.toString();
    return str ? `?${str}` : '';
  };
  const enc = encodeURIComponent;

  return {
    hasToken: () => Boolean(getToken()),
    // Local only: forget the token on this device.
    logout: clearToken,

    // End every browser session on the server (all devices), then forget the
    // token here. The token is forgotten even if the server call fails, so Log
    // Off always logs this device off; the error is still raised so the caller
    // can say the other devices may still be signed in.
    async logoutEverywhere(): Promise<void> {
      try {
        await call<{ ok: true }>('POST', '/auth/logout');
      } finally {
        clearToken();
      }
    },

    // Step 1: password → a 10-minute partial token, held by the caller only.
    async login(username: string, password: string): Promise<string> {
      const r = await call<{ partialToken: string }>(
        'POST',
        '/auth/login',
        { username, password },
        { bearer: null },
      );
      return r.partialToken;
    },

    // Step 2: security answer → the full token, which is stored.
    async verifySecurity(partialToken: string, answer: string): Promise<void> {
      const r = await call<{ token: string }>(
        'POST',
        '/auth/verify-security',
        { answer },
        { bearer: partialToken },
      );
      setToken(r.token);
    },

    setTimezone: (timezone: string) =>
      call<{ ok: true; timezone: string; serverToday: string }>('PUT', '/settings/timezone', { timezone }),

    async timezone(): Promise<string | null> {
      return (await call<{ timezone: string | null }>('GET', '/settings/timezone')).timezone;
    },

    today: (date: string) => call<Today>('GET', `/today${q({ date })}`),

    check: (habitId: number, date: string) =>
      call<{ done: boolean }>('PUT', `/checks/${habitId}/${enc(date)}`),
    uncheck: (habitId: number, date: string) =>
      call<{ done: boolean }>('DELETE', `/checks/${habitId}/${enc(date)}`),

    async history(habitId: number, days: number, date: string): Promise<HistoryDay[]> {
      const r = await call<{ days: HistoryDay[] }>(
        'GET',
        `/habits/${habitId}/history${q({ days, date })}`,
      );
      return r.days;
    },

    // The desktop matrix: active habits × `days` ending at `date`, with stats
    // over the last `statsDays` of them (all of them when omitted).
    historyMatrix: (days: number, date: string, statsDays?: number) =>
      call<HistoryMatrix>('GET', `/history${q({ days, date, statsDays })}`),

    weather: () => call<Forecast>('GET', '/weather'),

    article: (date: string) => call<Wire>('GET', `/article${q({ date })}`),
    // 409 'nothing else on the wire today' when nothing is left.
    // "Next": the passed article is recorded as served (and a dud) for good.
    skipArticle: (date: string) => call<{ article: Article; queue: number }>('POST', '/article/skip', { date }),
    readArticle: (date: string) => call<{ article: Article }>('POST', '/article/read', { date }),

    habits: () => call<Habit[]>('GET', '/habits'),
    createHabit: (h: { slug: string; label: string; rampText?: string | null }) =>
      call<Habit>('POST', '/habits', h),
    patchHabit: (id: number, patch: HabitPatch) => call<Habit>('PATCH', `/habits/${id}`, patch),

    notes: (from: string, to: string) => call<Note[]>('GET', `/notes${q({ from, to })}`),
    putNote: (date: string, line: string) =>
      call<{ date: string; line: string | null }>('PUT', `/notes/${enc(date)}`, { line }),
    learned: (query: LearnedQuery = {}) => call<LearnedPage>('GET', `/learned${q({ ...query })}`),
    putLearned: (date: string, text: string) =>
      call<{ date: string; text: string | null }>('PUT', `/learned/${enc(date)}`, { text }),
  };
}

export type Api = ReturnType<typeof createApi>;

// Always same-origin: the policy's connect-src 'self' allows nothing else, so
// there is deliberately no setting for another base URL.
export const api: Api = createApi({
  baseUrl: API_BASE,
  fetch: (...args) => fetch(...args),
  storage: typeof localStorage === 'undefined' ? memoryStore() : localStorage,
});

function memoryStore(): TokenStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}
