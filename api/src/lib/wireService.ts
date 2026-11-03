import { readFileSync } from 'node:fs';
import type { DailyArticle, Store } from '../db/store.js';
import { getAppTimeZone } from '../db/settings.js';
import { addDays, dateInZone } from './dates.js';
import defaultConfig from '../config/wire.json';
import {
  allowedHosts,
  mergeDuplicates,
  parseFeed,
  parseGithubReleases,
  parseIndexPage,
  robotsAllows,
  parseHn,
  rank,
  wireConfigSchema,
  type Candidate,
  type FeedSource,
  type Ranked,
  type WireConfig,
} from './wire.js';

// AI Wire, the side with effects: fetching the sources, keeping the
// candidates, and choosing the day's article. One article per date, the same
// for every device. Nothing here calls an AI model.
//
// The pool for a day is every never-served candidate fetched in the last 24
// hours. A source that fails this time still has its candidates from a fetch
// within that window in the pool — that is the 24-hour fallback. Only when
// the pool is empty is there "No signal today".

export const POOL_MS = 24 * 60 * 60 * 1000;
// A refresh (all sources) at most this often per process, so a run of
// requests on a day with no signal does not hammer anyone.
export const REFRESH_MIN_MS = 15 * 60 * 1000;
// Unserved candidates older than this are dropped.
export const PRUNE_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 3;
export const USER_AGENT = 'PHT-AI-Wire/1.0 (personal reader; one request per source per day)';

// WIRE_CONFIG names an ops-edited JSON file; without it, the config shipped
// in the build (src/config/wire.json). Read on every refresh, so an edit
// takes effect on the next one without a restart. A broken file is an error
// in the log and the shipped config is used.
export function loadWireConfig(env: Record<string, string | undefined> = process.env): WireConfig {
  const file = env.WIRE_CONFIG?.trim();
  if (file) {
    try {
      return wireConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      console.error(`[wire] WIRE_CONFIG unusable, using the built-in list: ${err instanceof Error ? err.message : err}`);
    }
  }
  return wireConfigSchema.parse(defaultConfig);
}

export class WireFetchError extends Error {}

// settings key prefix: when a rate-limited source was last fetched (epoch ms).
export const FETCHED_KEY = 'wire_fetched_at:';

// GET a URL whose host is in the allowlist, following at most three
// redirects that also stay inside it, with a timeout and a size cap.
export async function fetchAllowed(
  url: string,
  opts: { fetch: typeof fetch; hosts: ReadonlySet<string>; timeoutMs: number; maxBytes: number; accept: string },
): Promise<string> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const u = new URL(target);
    if (u.protocol !== 'https:' || !opts.hosts.has(u.hostname)) {
      throw new WireFetchError(`host not allowed: ${u.hostname}`);
    }
    const res = await opts.fetch(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { Accept: opts.accept, 'User-Agent': USER_AGENT },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new WireFetchError(`redirect without location from ${u.hostname}`);
      target = new URL(loc, target).toString();
      continue;
    }
    if (!res.ok) throw new WireFetchError(`${u.hostname} answered ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > opts.maxBytes) throw new WireFetchError(`${u.hostname} body too large`);
    const text = await res.text();
    if (text.length > opts.maxBytes) throw new WireFetchError(`${u.hostname} body too large`);
    return text;
  }
  throw new WireFetchError('too many redirects');
}

export interface SourceReport {
  id: string;
  ok: boolean;
  count: number;
  // Not fetched: fetched less than minIntervalHours ago.
  skipped?: boolean;
  error?: string;
}

export type ArticleJson = {
  date: string;
  url: string;
  title: string;
  source: string;
  publishedAt: string;
  excerpt: string | null;
  // The topic tags it matched, main one first.
  topics: string[];
  read: boolean;
};

export function articleJson(a: DailyArticle): ArticleJson {
  return {
    date: a.date,
    url: a.url,
    title: a.title,
    source: a.source,
    publishedAt: a.publishedAt.toISOString(),
    excerpt: a.excerpt,
    topics: a.topics,
    read: a.readAt !== null,
  };
}

async function fetchSource(cfg: WireConfig, hosts: Set<string>, id: string, doFetch: typeof fetch, now: number): Promise<Candidate[]> {
  const base = { fetch: doFetch, hosts, timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxBytes };
  if (id === cfg.hackerNews.id) {
    const since = Math.floor(now / 1000) - cfg.lookbackDays * 86_400;
    const out: Candidate[] = [];
    let ok = 0;
    let lastError: unknown = null;
    for (const q of cfg.hackerNews.queries) {
      const params = new URLSearchParams({
        query: q.query,
        tags: 'story',
        numericFilters: `created_at_i>${since},points>=${q.minPoints}`,
        hitsPerPage: '100',
      });
      try {
        const body = await fetchAllowed(`${cfg.hackerNews.url}?${params}`, { ...base, accept: 'application/json' });
        out.push(...parseHn(JSON.parse(body), cfg, q.minPoints));
        ok += 1;
      } catch (err) {
        lastError = err;
      }
    }
    // HN counts as failed only when every query did.
    if (!ok) throw lastError;
    return out;
  }
  const feed = cfg.feeds.find((f) => f.id === id);
  if (!feed) return [];
  if (feed.kind === 'page') {
    // Polite: robots.txt first (a 404 there allows everything), then the
    // listing page itself and nothing else.
    const u = new URL(feed.url);
    let robots = '';
    try {
      robots = await fetchAllowed(`${u.origin}/robots.txt`, { ...base, accept: 'text/plain' });
    } catch (err) {
      if (!(err instanceof WireFetchError && / answered 404$/.test(err.message))) throw err;
    }
    if (!robotsAllows(robots, USER_AGENT, u.pathname)) throw new WireFetchError(`robots.txt disallows ${u.pathname}`);
    const html = await fetchAllowed(feed.url, { ...base, accept: 'text/html' });
    return parseIndexPage(html, feed);
  }
  const body = await fetchAllowed(feed.url, {
    ...base,
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
  });
  return feed.kind === 'github-releases' ? parseGithubReleases(body, feed) : parseFeed(body, feed);
}

// Every source fetched now, merged; nothing stored. refresh() keeps the
// result, the dry run (wireJob --dry-run) only prints it.
// `due(source)` says whether a source with minIntervalHours may be fetched
// now (refresh asks the DB; the dry run fetches everything); `fetched(id)` is
// told after each such fetch succeeds.
export async function gatherWire(
  cfg: WireConfig,
  doFetch: typeof fetch,
  t: number,
  opts: { due?: (src: FeedSource) => Promise<boolean>; fetched?: (id: string) => Promise<void> } = {},
): Promise<{ reports: SourceReport[]; candidates: Candidate[] }> {
  const hosts = allowedHosts(cfg);
  const ids = [cfg.hackerNews.id, ...cfg.feeds.map((f) => f.id)];
  const results = await Promise.all(
    ids.map(async (id): Promise<[SourceReport, Candidate[]]> => {
      const feed = cfg.feeds.find((f) => f.id === id);
      const limited = Boolean(feed && feed.minIntervalHours > 0);
      if (feed && limited && opts.due && !(await opts.due(feed))) return [{ id, ok: true, count: 0, skipped: true }, []];
      try {
        const list = (await fetchSource(cfg, hosts, id, doFetch, t)).filter(
          (c) => c.publishedAt.getTime() >= t - cfg.lookbackDays * 86_400_000,
        );
        if (limited) await opts.fetched?.(id);
        return [{ id, ok: true, count: list.length }, list];
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return [{ id, ok: false, count: 0, error }, []];
      }
    }),
  );
  return {
    reports: results.map(([r]) => r),
    candidates: mergeDuplicates(
      results.flatMap(([, l]) => l),
      cfg.hackerNews.id,
    ),
  };
}

export interface WireService {
  // The day's article, choosing it first if there is none yet (null = no
  // signal). Choosing happens only once per date: a second call, from the
  // job or a request, returns the same row.
  ensure(date: string): Promise<DailyArticle | null>;
  // Replace the day's article with the next best ("Next"). The passed one
  // stays served and is recorded as a dud (with its source and tier) unless
  // `dud: false` (a re-pick after a rules change is not a judgement). Null
  // when nothing else is left (the day keeps its article).
  skip(date: string, opts?: { dud?: boolean }): Promise<DailyArticle | null>;
  // How many qualifying stories are waiting behind the day's article. Fetches
  // nothing.
  queue(): Promise<number>;
  // Fetch every source now (the job's first step). Reports per source.
  refresh(force?: boolean): Promise<SourceReport[]>;
}

export function createWireService(
  store: Store,
  opts: {
    fetch?: typeof fetch;
    now?: () => number;
    config?: () => WireConfig;
    log?: (msg: string) => void;
  } = {},
): WireService {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? Date.now;
  const config = opts.config ?? (() => loadWireConfig());
  const log = opts.log ?? ((m: string) => console.log(`[wire] ${m}`));
  let lastRefresh = -Infinity;

  // Everything that writes runs one at a time in this process. Another
  // process (the job CLI) is kept honest by the DB: insertDailyArticle and
  // replaceDailyArticle only ever write over what they expect.
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn);
    chain = p.catch(() => undefined);
    return p;
  }

  async function refresh(force = false): Promise<SourceReport[]> {
    const t = now();
    if (!force && t - lastRefresh < REFRESH_MIN_MS) return [];
    lastRefresh = t;
    const cfg = config();
    const { reports, candidates: fresh } = await gatherWire(cfg, doFetch, t, {
      // A rate-limited source (an index page) is fetched at most every
      // minIntervalHours, across processes and restarts: the time is kept in
      // settings.
      due: async (src) => {
        const last = Number(await store.getSetting(`${FETCHED_KEY}${src.id}`));
        return !Number.isFinite(last) || t - last >= src.minIntervalHours * 3_600_000;
      },
      fetched: (id) => store.setSetting(`${FETCHED_KEY}${id}`, String(t)),
    });
    await store.upsertWireCandidates(fresh, new Date(t));
    await store.pruneWireCandidates(new Date(t - PRUNE_MS));
    const failed = reports.filter((r) => !r.ok).map((r) => `${r.id} (${r.error})`);
    log(`refreshed: ${fresh.length} stories from ${reports.length - failed.length}/${reports.length} sources` +
      (failed.length ? `; failed: ${failed.join(', ')}` : ''));
    return reports;
  }

  // The ranked never-served pool that passes the topic gate, with every story
  // whose title was served before (under any URL) left out.
  async function candidates(): Promise<Ranked[]> {
    const t = now();
    const cfg = config();
    const [pool, servedTitles] = await Promise.all([
      store.wirePool(new Date(t - POOL_MS)),
      store.wireServedTitleHashes(),
    ]);
    const fresh = pool.filter((c) => !servedTitles.has(c.titleHash));
    return rank(mergeDuplicates(fresh, cfg.hackerNews.id), cfg, t);
  }

  async function pick(exclude: { urlHash: string; titleHash: string } | null): Promise<Ranked | null> {
    let list = await candidates();
    if (!list.length) {
      await refresh();
      list = await candidates();
    }
    return list.find((c) => !exclude || (c.urlHash !== exclude.urlHash && c.titleHash !== exclude.titleHash)) ?? null;
  }

  const toRow = (date: string, c: Ranked) => ({
    date,
    url: c.url,
    title: c.title,
    source: c.source,
    publishedAt: c.publishedAt,
    excerpt: c.excerpt,
    urlHash: c.urlHash,
    titleHash: c.titleHash,
    topics: c.topics,
    sourceId: c.sourceId,
  });

  return {
    refresh: (force) => serial(() => refresh(force)),

    ensure(date) {
      return serial(async () => {
        const have = await store.getDailyArticle(date);
        if (have) return have;
        // A new day: gather first (at most once per REFRESH_MIN_MS).
        await refresh();
        const best = await pick(null);
        if (!best) {
          log(`no signal for ${date}`);
          return null;
        }
        if (await store.insertDailyArticle(toRow(date, best))) {
          await store.markWireServed(best.urlHash, date);
          log(`${date}: ${best.source} — ${best.title}`);
        }
        return store.getDailyArticle(date);
      });
    },

    queue: () => serial(async () => (await candidates()).length),

    skip(date, { dud = true } = {}) {
      return serial(async () => {
        const current = await store.getDailyArticle(date);
        if (!current) return null;
        // Whatever happens next, the skipped one is never shown again.
        await store.markWireServed(current.urlHash, date);
        if (dud) {
          await store.recordWireDud({
            date,
            urlHash: current.urlHash,
            title: current.title,
            sourceId: current.sourceId,
            source: current.source,
            tier: current.topics[0] ?? null,
          });
        }
        const next = await pick(current);
        if (!next) return null;
        if (await store.replaceDailyArticle(current.urlHash, toRow(date, next))) {
          await store.markWireServed(next.urlHash, date);
          log(`${date}: skipped to ${next.source} — ${next.title}`);
        }
        return store.getDailyArticle(date);
      });
    },
  };
}

// The 03:30 job, in-process: once a minute, from 03:30 in app_timezone on,
// make sure today has its article. ensure() returns at once when it does, so
// the tick is cheap, and a request earlier in the day may have chosen it
// already. Returns a stop function.
export const JOB_TIME = '03:30';

export function startWireSchedule(store: Store, wire: WireService, now: () => number = Date.now): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const tz = await getAppTimeZone(store);
      const at = new Date(now());
      const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
      if (hhmm >= JOB_TIME) await wire.ensure(dateInZone(at, tz));
    } catch (err) {
      console.error(`[wire] scheduled run failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}

// Which dates may be chosen or skipped: today in app_timezone and one day
// either side (the client owns "today"). Older days only ever show what they
// had.
export async function isLiveDate(store: Store, date: string, now: number = Date.now()): Promise<boolean> {
  const today = dateInZone(new Date(now), await getAppTimeZone(store));
  return date >= addDays(today, -1) && date <= addDays(today, 1);
}
