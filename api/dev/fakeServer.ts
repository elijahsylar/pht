// `npm run dev:fake` — the real API on localhost over the in-memory store.
//
// For building and UI-testing the frontend without a database (the laptop has
// no usable MySQL). Everything resets on restart. It lives outside src/, so tsc
// never compiles it into dist/ and it cannot be deployed; and it refuses to
// start under NODE_ENV=production, or with any password, token or secret taken
// from the environment.
//
//   PORT=4100 (default)   binds 127.0.0.1 only

if (process.env.NODE_ENV === 'production') {
  console.error('[dev:fake] refusing to start: NODE_ENV=production. This server is for local development only.');
  process.exit(1);
}

import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { setSecurityAnswer, APP_TIMEZONE_KEY } from '../src/db/settings.js';
import { API_TOKEN_HASH_KEY, hashApiToken } from '../src/lib/apiToken.js';
import { addDays, todayInZone } from '../src/lib/dates.js';
import { createWeatherService } from '../src/lib/weather.js';
import type { Schedule } from '../src/lib/schedule.js';
import { createWireService } from '../src/lib/wireService.js';
import { createFakeStore } from '../tests/fakeStore.js';
import { TEST_WEATHER_ENV, fakeOpenMeteoFetch } from '../tests/weatherFixture.js';
import { WIRE_TEST_CONFIG, atom, daysAgo, fakeWireFetch, hn, hoursAgo, rss } from '../tests/wireFixture.js';
import {
  DEV_ANSWER,
  DEV_API_TOKEN,
  DEV_JWT_SECRET,
  DEV_PASSWORD,
  DEV_USERNAME,
} from './credentials.js';

// One string per habit, oldest day first, ending YESTERDAY: x = checked.
// 35 days, so the desktop's 30-day History is full. Today is left unchecked
// so the first click in the UI is a real change.
const PATTERN: Record<string, string> = {
  stretch: 'x.xxx.xxxxx..xxxx.xxxxxxx.xx.xxxxxx', //  6-day streak: checking today makes 7, a milestone
  read: 'xxxxxxxxxx..xxx.xx.x.xxxx..xxx..x.x', //  1, best 10
  water: '.x.x.x.x.x.x.x.x.xx.x.xx.x.x.x.x.x.', //  0, broken yesterday
  journal: '.........xx..........xxxxxxxxxxxxxx', //  14-day streak
  plan: '......x......x......x......x.......', //  weekly-ish, 0 now
  tidy: 'xxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxx', // 28-day streak
};
const DAYS = 35;

// `plan` is every other day, anchored so that today is always one of its
// rest days (set before the history starts): the deck and the matrix always
// show rest days, whatever day of the week the server starts on.
const SCHEDULES: Record<string, (today: string) => Schedule> = {
  plan: (today) => ({ kind: 'every_other_day', anchor: addDays(today, 1) }),
};

// AI Wire over invented .test hosts (they never resolve): the real service
// over a fake network, so the pick, Skip and the 24h pool all run for real.
// Dates follow the real clock.
function wireAnswers() {
  const now = Date.now();
  return {
    'https://lab.test/rss.xml': rss([
      {
        title: 'What we learned running Claude Code on a large monorepo',
        link: 'https://lab.test/engineering/claude-code-monorepo?utm_source=rss',
        date: hoursAgo(now, 30),
        description:
          '<p>Six months of Claude Code on a codebase with four hundred services: which hooks paid for themselves, how we split work across subagents, ' +
          'and why the CLAUDE.md that worked best was the shortest one. ' +
          'We share the review checklist we now run on every agent-written change, the evals that caught two regressions before release, and the one permission we wish we had turned off sooner.</p>',
      },
      {
        title: 'Notes on context engineering',
        link: 'https://lab.test/engineering/context-notes',
        date: daysAgo(now, 4),
        description: 'What goes in the context window, what stays out, and how to tell the difference.',
      },
    ]),
    'https://letter.test/atom.xml': atom([
      {
        title: 'Agentic coding for a team of one',
        link: 'https://letter.test/p/agentic-coding-solo',
        date: daysAgo(now, 2),
        description: 'A month of shipping side projects with a coding agent. What I kept doing by hand, and what I stopped.',
      },
      {
        title: 'Evals for LLM features, plainly',
        link: 'https://letter.test/p/evals-plainly',
        date: daysAgo(now, 6),
        description: 'Three kinds of test for an LLM feature, and why the cheapest one catches the most.',
      },
    ]),
    'https://hn.test/': hn([
      { title: 'What we learned running Claude Code on a large monorepo', url: 'https://lab.test/engineering/claude-code-monorepo', points: 412, date: hoursAgo(now, 26), comments: 188 },
      { title: 'Show HN: An MCP server that prints Claude output on fanfold paper', url: 'https://teletype.test/', points: 230, date: daysAgo(now, 3), comments: 64 },
      { title: 'Ask HN: Which Claude Code workflows do you use?', url: null, points: 300, date: daysAgo(now, 2) },
    ]),
  };
}

// The last seven days' articles (title, tier tag, source id), every other one read.
const PAST_WIRE: [string, string, string][] = [
  ['Writing a CLAUDE.md that ages well', 'Claude Code', 'letter'],
  ['Claude Code hooks, one year in', 'Claude Code', 'lab'],
  ['Prompt caching for people in a hurry', 'Anthropic', 'lab'],
  ['Code review when the author is an agent', 'AI engineering', 'letter'],
  ['MCP servers worth running locally', 'Anthropic', 'letter'],
  ['Subagents, plainly', 'Claude Code', 'lab'],
  ['Careers for engineers in the AI era', 'AI engineering', 'letter'],
];

// Notes on a few recent days: days-ago → line.
const NOTES: [number, string][] = [
  [1, 'Long walk by the river before the rain.'],
  [2, 'Garden beds are in.'],
  [4, 'Rain all day, read inside.'],
  [7, 'Called an old friend. Long overdue.'],
  [11, 'Tired. Did the minimum, still counts.'],
  [16, 'New shoes, old route.'],
  [23, 'Back on the morning routine.'],
  [29, 'First day back on the list.'],
];

// "What new thing did I learn today?" — enough entries for More… (over 50),
// reaching back past the 30-day window (read-only there), none for today or
// yesterday (the walkthrough types those). Every fifth day is left empty.
const LEARNED_TOPICS = [
  'Octopuses have three hearts',
  'CSS container queries ignore the padding box',
  'Honey never spoils if it is sealed',
  'Rust moves a value out unless it is Copy',
  'The Eiffel Tower grows in summer heat',
  'Sourdough rises slower in a cold kitchen',
  'MySQL LIKE is case-insensitive under a _ci collation',
  'Bananas are botanically berries',
  'Prompt caching only pays off past the minimum length',
  'SQL NULL is not equal to NULL',
  'A git rebase keeps the author date',
];
const LEARNED: [number, string][] = [];
for (let ago = 2; ago <= 70; ago += 1) {
  if (ago % 5 === 0) continue;
  LEARNED.push([ago, `${LEARNED_TOPICS[ago % LEARNED_TOPICS.length]} (day ${ago})`]);
}

async function main() {
  const host = '127.0.0.1';
  const port = Number(process.env.PORT ?? 4100);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Never inherit a real secret from a shell that happens to have one set.
  process.env.JWT_SECRET = DEV_JWT_SECRET;
  process.env.ADMIN_USERNAME = DEV_USERNAME;
  process.env.ADMIN_PASSWORD_HASH = await bcrypt.hash(DEV_PASSWORD, 10);

  const store = createFakeStore({ seed: true });
  await store.setSetting(APP_TIMEZONE_KEY, tz);
  await setSecurityAnswer(store, DEV_ANSWER);
  await store.setSetting(API_TOKEN_HASH_KEY, hashApiToken(DEV_API_TOKEN));

  const today = todayInZone(tz);
  const habits = await store.listHabits({ includeRetired: true });
  for (const h of habits) {
    // Created before the history starts, so the created_at floor allows all of it.
    store.setCreatedAt(h.id, new Date(Date.now() - (DAYS + 5) * 86_400_000));
    const days = PATTERN[h.slug] ?? '';
    if (days.length !== DAYS) throw new Error(`PATTERN.${h.slug} is ${days.length} days, not ${DAYS}`);
    for (let i = 0; i < days.length; i += 1) {
      if (days[i] === 'x') await store.addCheck(h.id, addDays(today, i - days.length));
    }
  }
  for (const [ago, line] of NOTES) await store.putNote(addDays(today, -ago), line);
  for (const [ago, text] of LEARNED) await store.putLearned(addDays(today, -ago), text);
  for (const h of habits) {
    const sch = SCHEDULES[h.slug];
    if (sch) await store.setSchedule(h.id, sch(today), addDays(today, -DAYS - 1));
  }
  for (let i = 0; i < PAST_WIRE.length; i += 1) {
    const date = addDays(today, -(i + 1));
    const [title, tag, sourceId] = PAST_WIRE[i];
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await store.insertDailyArticle({
      date,
      url: `https://letter.test/p/${slug}`,
      title,
      source: sourceId === 'lab' ? 'Test Lab' : 'Test Letter',
      publishedAt: new Date(Date.now() - (i + 2) * 86_400_000),
      excerpt: null,
      urlHash: `dev-${slug}`,
      titleHash: `dev-${slug}`,
      topics: [tag],
      sourceId,
    });
    if (i % 2 === 0) await store.markArticleRead(date);
  }

  // A fixed 7-day forecast using every kind, starting on the real today in
  // this zone. Served through the real weather service over a fake Open-Meteo,
  // so nothing leaves the machine.
  const weather = createWeatherService({
    env: TEST_WEATHER_ENV,
    fetch: fakeOpenMeteoFetch(() => todayInZone(tz)),
  });

  const wire = createWireService(store, {
    fetch: (url, init) => fakeWireFetch(wireAnswers()).fetch(url, init),
    config: () => WIRE_TEST_CONFIG,
  });

  createApp(store, { weather, wire }).listen(port, host, () => {
    console.log(`[dev:fake] PHT API (in-memory, resets on restart) on http://${host}:${port}/api`);
    console.log(`[dev:fake] timezone ${tz}, today ${today}`);
    console.log(`[dev:fake] login     ${DEV_USERNAME} / ${DEV_PASSWORD}`);
    console.log(`[dev:fake] answer    ${DEV_ANSWER}`);
    console.log(`[dev:fake] api token ${DEV_API_TOKEN}`);
  });
}

main().catch((err) => {
  console.error('[dev:fake] failed to start:', err);
  process.exit(1);
});
