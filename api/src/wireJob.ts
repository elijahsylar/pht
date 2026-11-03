import 'dotenv/config';
import { classify, rank, score, withinLookback, isConfiguredSource } from './lib/wire.js';
import { isIsoDate } from './lib/dates.js';
import { gatherWire, loadWireConfig } from './lib/wireService.js';

// The AI Wire job by hand:
//   node dist/wireJob.js [YYYY-MM-DD]           choose the day's article if it has
//       none (default today in app_timezone) — the same thing the 03:30 tick in
//       the running API does — and print it. Run twice, the second run prints
//       the same article and fetches nothing.
//   node dist/wireJob.js --repick [YYYY-MM-DD]  fetch every source now, then
//       replace the day's article with the next best under the current rules
//       and sources, as Next does: the old one stays served and never comes
//       back (but it is not recorded as a dud).
//   node dist/wireJob.js --dry-run [N]          fetch every source now, in memory,
//       and print what the rules would pick (the top N, default all), how many
//       pass per source, and examples of what they reject with the reason.
//       Writes nothing; ends with the dud report when a database is reachable.
//   node dist/wireJob.js --duds [DAYS]          the dud report: articles passed
//       over with Next in the last DAYS (default 90), per source and tier, so
//       sources that keep missing can be pruned from wire.json by hand.
//       Read-only.
async function dryRun(top: number) {
  const cfg = loadWireConfig();
  const t = Date.now();
  const { reports, candidates } = await gatherWire(cfg, (...a: Parameters<typeof fetch>) => fetch(...a), t);
  for (const r of reports) if (!r.ok) console.log(`source failed: ${r.id} (${r.error})`);
  const live = candidates.filter((c) => withinLookback(c, cfg, t) && isConfiguredSource(cfg, c.sourceId));
  const passing = rank(live, cfg, t);
  console.log(`${live.length} stories in the last ${cfg.lookbackDays} days; ${passing.length} pass the gate.\n`);
  console.log(`PASSING (${Math.min(top, passing.length)} shown)`);
  passing.slice(0, top).forEach((c, i) => {
    console.log(
      `${String(i + 1).padStart(2)}. ${c.score.toFixed(1).padStart(5)}  ${c.tier} [${c.topics.join(', ')}]  ${c.source} | ${c.title}`,
    );
  });
  const ids = [cfg.hackerNews.id, ...cfg.feeds.map((f) => f.id)];
  console.log('\nPER SOURCE (fetched in window / passing)');
  for (const id of ids) {
    const r = reports.find((x) => x.id === id);
    const n = live.filter((c) => c.sourceId === id).length;
    const p = passing.filter((c) => c.sourceId === id).length;
    console.log(`  ${id.padEnd(24)} ${String(n).padStart(4)} / ${String(p).padStart(3)}${r && !r.ok ? `  FAILED: ${r.error}` : ''}`);
  }
  const rejected = live
    .map((c) => ({ c, v: classify(c, cfg) }))
    .filter((x): x is { c: typeof x.c; v: { ok: false; reason: string } } => !x.v.ok)
    .map((x) => ({ ...x, s: score(x.c, cfg, t) }))
    .sort((a, b) => b.s - a.s);
  const kind = (reason: string) => reason.replace(/".*"/, '"…"').replace(/\d+ matches/, 'n matches');
  const byReason = new Map<string, number>();
  for (const r of rejected) byReason.set(kind(r.v.reason), (byReason.get(kind(r.v.reason)) ?? 0) + 1);
  console.log(`\nREJECTED ${rejected.length}: ${[...byReason].map(([k, n]) => `${k} ×${n}`).join('; ')}`);
  // The highest-scoring reject of each kind first, then the rest by score.
  const firsts = [...new Set(rejected.map((r) => kind(r.v.reason)))].map((k) => rejected.find((r) => kind(r.v.reason) === k)!);
  const examples = [...firsts, ...rejected.filter((r) => !firsts.includes(r))].slice(0, 20);
  console.log('Examples:');
  examples.forEach((r, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${r.s.toFixed(1).padStart(5)}  {${r.v.reason}}  ${r.c.source} | ${r.c.title}`);
  });
  if (process.env.DB_HOST || process.env.DB_NAME) {
    console.log('');
    await withDb((store) => dudReport(store, 90)).catch((err) =>
      console.log(`(dud report skipped: ${err instanceof Error ? err.message : err})`),
    );
  } else {
    console.log('\n(no database configured: dud report skipped; run --duds where the database is)');
  }
}

async function dudReport(store: import('./db/store.js').Store, days: number) {
  const { addDays, todayInZone } = await import('./lib/dates.js');
  const { getAppTimeZone } = await import('./db/settings.js');
  const since = addDays(todayInZone(await getAppTimeZone(store)), -days);
  const duds = await store.listWireDuds(since);
  console.log(`DUDS since ${since}: ${duds.length} passed over with Next`);
  const bySource = new Map<string, { n: number; tiers: Map<string, number>; name: string }>();
  for (const d of duds) {
    const key = d.sourceId ?? d.source;
    const e = bySource.get(key) ?? { n: 0, tiers: new Map(), name: d.source };
    e.n += 1;
    const tier = d.tier ?? '(none)';
    e.tiers.set(tier, (e.tiers.get(tier) ?? 0) + 1);
    bySource.set(key, e);
  }
  for (const [key, e] of [...bySource].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${key.padEnd(24)} ${String(e.n).padStart(3)}  ${[...e.tiers].map(([t, n]) => `${t} ${n}`).join(', ')}`);
  }
}

async function withDb(fn: (store: import('./db/store.js').Store) => Promise<void>) {
  const [{ createMysqlStore }, { pool }] = await Promise.all([import('./db/mysqlStore.js'), import('./db/pool.js')]);
  try {
    await fn(createMysqlStore(pool));
  } finally {
    await pool.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--dry-run') {
    const n = args[1] === undefined ? Infinity : Number(args[1]);
    if (n !== Infinity && (!Number.isInteger(n) || n < 1)) throw new Error(`not a count: ${args[1]}`);
    return dryRun(n);
  }
  if (args[0] === '--duds') {
    const days = args[1] === undefined ? 90 : Number(args[1]);
    if (!Number.isInteger(days) || days < 1) throw new Error(`not a number of days: ${args[1]}`);
    return withDb((store) => dudReport(store, days));
  }
  const repick = args[0] === '--repick';
  const arg = repick ? args[1] : args[0];
  if (arg !== undefined && !isIsoDate(arg)) throw new Error(`not a date: ${arg}`);
  const [{ getAppTimeZone }, { todayInZone }, { createWireService }] = await Promise.all([
    import('./db/settings.js'),
    import('./lib/dates.js'),
    import('./lib/wireService.js'),
  ]);
  await withDb(async (store) => {
    const date = arg ?? todayInZone(await getAppTimeZone(store));
    const had = await store.getDailyArticle(date);
    const wire = createWireService(store);
    const show = (a: { source: string; title: string; url: string; topics: string[] }) =>
      `${a.source} | ${a.title} | ${a.url}${a.topics.length ? ` | [${a.topics.join(', ')}]` : ''}`;
    if (repick) {
      if (!had) throw new Error(`${date} has no article to re-pick`);
      // After a rules or sources change the pool may hold only what the old
      // sources gave: gather from the current ones first.
      const reports = await wire.refresh(true);
      const failed = reports.filter((r) => !r.ok).map((r) => r.id);
      console.log(`fetched ${reports.length - failed.length}/${reports.length} sources${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`);
      // A re-pick after a rules change is not a judgement on the article.
      const next = await wire.skip(date, { dud: false });
      console.log(`${date} was: ${show(had)}`);
      console.log(next ? `${date} now: ${show(next)}` : `${date}: nothing passes the rules; the old article stays`);
      return;
    }
    const a = await wire.ensure(date);
    console.log(
      a
        ? `${date} ${had ? 'unchanged' : 'chosen'}: ${show(a)}`
        : `${date}: no signal (every source failed and nothing fetched in the last 24h)`,
    );
  });
}

main().catch((err) => {
  console.error('[wireJob] failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
