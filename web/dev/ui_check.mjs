// Headless walkthrough of the built desktop against pht-api `dev:fake`.
// Run it through `npm run ui:check` (dev/run-ui-check.sh), which starts the
// servers. Usage: node dev/ui_check.mjs <base-url> <screenshot-dir> <dev-url>
// UI_BROWSER=firefox runs it in Playwright's Firefox instead of Chrome
// (`npm run ui:check:firefox`); its screenshots go to <screenshot-dir>/firefox.
//
// Every request to a host other than 127.0.0.1 is aborted and reported, so a
// build can never reach the real API or Open-Meteo. CSP violations are
// collected from every page load; a deliberate inline script at the end proves
// the collector sees them.
import { chromium, firefox } from 'playwright-core';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:4198';
const FIREFOX = process.env.UI_BROWSER === 'firefox';
const SHOTS = path.join(process.argv[3] || os.tmpdir(), FIREFOX ? 'firefox' : '');
const DEV = process.argv[4] || 'http://127.0.0.1:4197';
// dev:fake directly, for changes made "behind the page's back" with the API token.
const API = process.env.PHT_API_URL || 'http://127.0.0.1:4199/api';
const API_DIR = process.env.PHT_API_DIR || path.join(os.homedir(), 'projects/pht-api');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The dev login lives in pht-api, the one place it is defined.
const credsSrc = fs.readFileSync(path.join(API_DIR, 'dev/credentials.ts'), 'utf8');
const cred = (name) => new RegExp(`export const ${name} = '([^']+)'`).exec(credsSrc)[1];
const USER = cred('DEV_USERNAME');
const PASS = cred('DEV_PASSWORD');
const ANSWER = cred('DEV_ANSWER');
const API_TOKEN = cred('DEV_API_TOKEN');
const JWT_SECRET = cred('DEV_JWT_SECRET');
const jwt = createRequire(path.join(API_DIR, 'package.json'))('jsonwebtoken');
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone; // dev:fake uses the same
const dateIn = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms));
const longDate = (iso) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(
    new Date(`${iso}T00:00:00Z`),
  );
const shortDate = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${iso}T00:00:00Z`));
const dayLabel = (iso) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${iso}T00:00:00Z`)).replace(',', '');
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
// The first instant of `iso` in TZ, found by bisection so any zone or DST rule works.
function midnightOf(iso, fromMs) {
  let lo = fromMs;
  let hi = fromMs + 3 * 86_400_000;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateIn(mid) >= iso) hi = mid;
    else lo = mid;
  }
  return hi;
}
// The API as the widget would call it: same dev:fake, with the API token.
async function viaToken(method, p, body) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { Authorization: `Bearer ${API_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const claims = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
const TODAY = dateIn(Date.now());

let failures = 0;
const check = (label, cond, detail = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  (${detail})` : ''}`);
};
const shots = [];
async function shot(page, name, opts = {}) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  shots.push(path.resolve(file));
}

fs.mkdirSync(SHOTS, { recursive: true });
const browser = FIREFOX
  ? await firefox.launch({ headless: true })
  : await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
console.log(`browser: ${FIREFOX ? 'firefox' : 'chrome'} ${browser.version()}`);

const blocked = [];
const csp = [];
const problems = [];

async function newContext(viewport, mobile, extra = {}) {
  const context = await browser.newContext({
    viewport,
    // Firefox has no mobile emulation; the phone runs are a narrow touch screen.
    ...(FIREFOX ? {} : { isMobile: mobile }),
    hasTouch: mobile,
    deviceScaleFactor: mobile ? 2 : 1,
    timezoneId: TZ,
    ...extra,
  });
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') return route.continue();
    blocked.push(u.href);
    return route.abort();
  });
  await context.exposeBinding('__reportCsp', (_src, v) => csp.push(v));
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__reportCsp(`${e.violatedDirective} ${e.blockedURI || 'inline'}`);
    });
  });
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/Content.Security.Policy|Refused to/i.test(t)) csp.push(`console: ${t}`);
    if (m.type() === 'error') problems.push(`console.error: ${t}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return { context, page };
}

// ── selectors and small helpers ──────────────────────────────────────────────
const key = (page, slug) => page.locator(`.strip[data-slug="${slug}"] .key`);
const nameBtn = (page, slug) => page.locator(`.strip[data-slug="${slug}"] .habit-name`);
const pressed = async (page, slug) => (await key(page, slug).getAttribute('aria-pressed')) === 'true';
const histToday = (page, slug) => page.locator(`.win-history .mrow[data-slug="${slug}"] .led.today`);
const histOn = async (page, slug) => (await histToday(page, slug).getAttribute('data-on')) === 'true';
const lcd = (page) => page.locator('.today-lcd').textContent();
const seg = (page, slug) => page.locator(`.strip[data-slug="${slug}"] .seg-val`).textContent();
const dialogTitle = (page) => page.locator('.dialog .title-bar-text').textContent();
const box = (page, sel) => page.locator(sel).boundingBox();
// Wait until every showing window is where its grid rect says (they glide
// there in 0.12s). On a phone there is no grid: nothing to wait for.
async function settle(page) {
  for (let i = 0; i < 60; i += 1) {
    const off = await page.evaluate(() => {
      const desk = document.querySelector('.desk');
      if (!desk || !document.querySelector('.snap-lines')) return 0;
      const d = desk.getBoundingClientRect();
      const cw = (d.width - 10) / 12;
      const ch = (d.height - 10) / 10;
      let worst = 0;
      for (const w of document.querySelectorAll('.desk .win:not(.minimized)')) {
        const [x, y, gw, gh] = w.dataset.rect.split(',').map(Number);
        const r = w.getBoundingClientRect();
        worst = Math.max(worst, Math.abs(r.left - d.left - (10 + x * cw)), Math.abs(r.top - d.top - (10 + y * ch)), Math.abs(r.width - (gw * cw - 10)), Math.abs(r.height - (gh * ch - 10)));
      }
      return worst;
    });
    if (off <= 1) return;
    await sleep(50);
  }
}
const widths = async (page) => ({
  today: (await box(page, '#win-today'))?.width ?? 0,
  history: (await box(page, '#win-history'))?.width ?? 0,
  weather: (await box(page, '#win-weather'))?.width ?? 0,
});
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const J = JSON.stringify;
// Every latching key: at least 96px wide, and its lamp and label inside it
// with room to spare (4px or more from each edge), nothing overflowing.
const keysFit = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.strip .key')].flatMap((k) => {
      const r = k.getBoundingClientRect();
      if (!r.width) return [];
      const bad = [];
      if (r.width < 96 - 0.5) bad.push(`${k.dataset.habitId}: ${r.width}px wide`);
      if (k.scrollWidth > k.clientWidth) bad.push(`${k.dataset.habitId}: overflows`);
      for (const part of k.querySelectorAll('.lamp, .key-text')) {
        const p = part.getBoundingClientRect();
        if (p.left < r.left + 4 || p.right > r.right - 4) bad.push(`${k.dataset.habitId}: ${part.className} at the edge`);
      }
      const lamp = k.querySelector('.lamp').getBoundingClientRect();
      const label = k.querySelector('.key-text').getBoundingClientRect();
      if (lamp.right + 4 > label.left) bad.push(`${k.dataset.habitId}: lamp not left of the label`);
      return bad;
    }),
  );
// Body text in the UI font; the pixel font only on title bars and the taskbar, at 11px.
const fonts = (page) =>
  page.evaluate(() => {
    const ff = (sel) => getComputedStyle(document.querySelector(sel)).fontFamily;
    const fs = (sel) => getComputedStyle(document.querySelector(sel)).fontSize;
    const pixel = (sel) => /Pixelated/.test(ff(sel));
    const body = ['.habit-name', '.deck-date', '.win-history .mlabel', '.note-input', '.key'];
    return {
      bodyInPixelFont: body.filter(pixel),
      habitName: fs('.habit-name'),
      title: pixel('.title-bar-text') && fs('.title-bar-text') === '11px',
      taskbar: pixel('.task-btn') && fs('.task-btn') === '11px',
    };
  });
async function idle(page) {
  await page.waitForLoadState('networkidle');
  await sleep(150);
}

// Poll a predicate in the page. Playwright's waitForFunction evaluates through
// eval, which this page's CSP (correctly) refuses; page.evaluate runs over the
// DevTools protocol and is not subject to the page's policy.
async function waitFor(page, fn, label, arg, timeout = 6000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(80);
  }
  console.log(`      (timed out waiting for: ${label})`);
  return false;
}
const ready = (page) => page.waitForSelector('.strip .key', { timeout: 8000 });

async function login(page, base = BASE) {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.fill('#login-user', USER);
  await page.fill('#login-pass', PASS);
  await page.click('.login-form button[type=submit]');
  await page.waitForSelector('#login-answer');
  await page.fill('#login-answer', ANSWER);
  await page.click('.login-form button[type=submit]');
  await ready(page);
}
// Wait for the splash (if any) to go and the desktop to settle.
async function settled(page) {
  await waitFor(page, () => !document.querySelector('.splash'), 'splash gone', undefined, 3000);
  await idle(page);
}
async function drag(page, sel, dx, dy = 0) {
  const b = await box(page, sel);
  const x = b.x + b.width / 2;
  const y = b.y + Math.min(b.height / 2, 10);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}
const balloonTexts = (page) => page.locator('.balloon .balloon-text').allTextContents();

// ─────────────── the look: synthwave at three desktop sizes ───────────────
for (const [w, hgt] of [
  [1920, 1080],
  [1440, 900],
  [1280, 800],
]) {
  const { context, page } = await newContext({ width: w, height: hgt }, false);
  await login(page);
  await settled(page);
  const ws = await widths(page);
  const fits = (await page.evaluate(() => document.documentElement.scrollWidth)) <= w;
  check(`${w}×${hgt}: three windows of equal width, no horizontal scroll`, near(ws.today, ws.history) && near(ws.history, ws.weather) && ws.today >= 300 && fits, JSON.stringify(ws));
  const tb = await box(page, '.taskbar');
  const hist = await box(page, '#win-history');
  const learnedWin = await box(page, '#win-learned');
  check(`${w}×${hgt}: windows fill the height above the taskbar (History full height, Learned under Today)`, hist.y + hist.height < tb.y && hist.height > hgt * 0.75 && learnedWin.y + learnedWin.height < tb.y && near(learnedWin.y + learnedWin.height, hist.y + hist.height), `${hist.y}+${hist.height} vs ${tb.y}`);
  const kf = await keysFit(page);
  check(`${w}×${hgt}: every key label fits inside its button, lamp left of it`, kf.length === 0, kf.join(' | '));
  const f = await fonts(page);
  check(`${w}×${hgt}: body text in the UI font (names 15px); pixel font only on title bars and the taskbar, at 11px`, f.bodyInPixelFont.length === 0 && f.habitName === '15px' && f.title && f.taskbar, JSON.stringify(f));
  const deckFill = await page.evaluate(() => {
    const body = document.querySelector('#win-today .win-body').getBoundingClientRect();
    const deck = document.querySelector('#win-today .deck').getBoundingClientRect();
    return body.bottom - deck.bottom;
  });
  check(`${w}×${hgt}: the deck fills Today's window body (no strip under the J-card)`, deckFill <= 1, `${deckFill}px left`);
  await shot(page, `desktop-${w}-synthwave`);
  await context.close();
}

// ─────────────────────────── desktop, 1920 × 1080 ───────────────────────────
{
  const { context, page } = await newContext({ width: 1920, height: 1080 }, false);
  const D = (n) => `desktop-${n}`;

  // Login, CSP meta, the splash after a fresh login only.
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  const meta = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
  console.log(`CSP: ${meta}`);
  check('CSP meta present, self-only, no unsafe-*', !!meta && /connect-src 'self'/.test(meta) && /script-src 'self'/.test(meta) && /style-src 'self'/.test(meta) && !/unsafe/.test(meta));
  check('login window shown with no token', await page.isVisible('.login-window'));
  await shot(page, D('login'));
  await page.fill('#login-user', USER);
  await page.fill('#login-pass', 'wrong-password');
  await page.click('.login-form button[type=submit]');
  check('wrong password is refused with a message', await waitFor(page, () => /not right/.test(document.querySelector('.login-message')?.textContent || ''), 'password message'));
  await page.fill('#login-pass', PASS);
  await page.click('.login-form button[type=submit]');
  await page.waitForSelector('#login-answer');
  await page.fill('#login-answer', 'wrong');
  await page.click('.login-form button[type=submit]');
  check('wrong security answer is refused', await waitFor(page, () => /not right/.test(document.querySelector('.login-message')?.textContent || ''), 'answer message'));
  await page.fill('#login-answer', ANSWER);
  await page.click('.login-form button[type=submit]');
  await page.waitForSelector('.splash', { timeout: 3000 }).catch(() => null);
  check('a fresh login shows the PHT-6 splash', (await page.locator('.splash-brand').textContent().catch(() => '')) === 'PHT-6');
  await ready(page);
  const t0 = Date.now();
  await waitFor(page, () => !document.querySelector('.splash'), 'splash removed', undefined, 3000);
  check('…which is gone after about a second', !(await page.locator('.splash').count()) && Date.now() - t0 < 2500);
  await idle(page);
  check('token stored in localStorage pht:token', !!(await page.evaluate(() => localStorage.getItem('pht:token'))));
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  check('a reload shows no splash', (await page.locator('#desktop').getAttribute('data-splash')) === 'skipped' && !(await page.locator('.splash').count()));
  await idle(page);

  // Structure and accessibility.
  const regions = await page.locator('.desk .win[role=region]').evaluateAll((els) => els.map((e) => document.getElementById(e.getAttribute('aria-labelledby'))?.textContent));
  check('five labelled regions: Today, History, Learned, Weather, AI Wire', regions.length === 5 && /^Today/.test(regions[0]) && /^History/.test(regions[1]) && /^Learned/.test(regions[2]) && /^Weather/.test(regions[3]) && /^AI Wire/.test(regions[4]), regions.join(' | '));
  const bars = await page.locator('.desk .win > .title-bar').evaluateAll((els) => els.map((e) => [e.tabIndex, e.getAttribute('aria-label'), e.parentElement.querySelectorAll(':scope > .rh').length]));
  check('focusable, labelled title bars (Alt+arrows) and 8 resize handles per window', bars.length === 5 && bars.every(([t, l, n]) => t === 0 && /Alt and arrow keys move it/.test(l) && n === 8), JSON.stringify(bars));
  // dev:fake keeps `plan` on an every-other-day schedule with today a rest day.
  check('Today: one strip per habit, the LCD counting the 5 habits due today', (await page.locator('.strip').count()) === 6 && (await lcd(page)) === 'TODAY 0/5');
  check(
    'a rest day: Plan tomorrow shows REST, dimmed, still a toggle, and says so',
    (await page.locator('.strip[data-slug="plan"]').evaluate((e) => e.classList.contains('rest'))) &&
      (await key(page, 'plan').textContent()) === 'REST' &&
      (await key(page, 'plan').getAttribute('aria-pressed')) === 'false' &&
      /rest day today/.test(await key(page, 'plan').getAttribute('aria-label')) &&
      (await page.locator('.strip.rest').count()) === 1,
  );
  {
    const histCall = page.locator('.win-history .mrow[data-slug="plan"]');
    const rest = await histCall.locator('.led.rest').count();
    const restToday = await histCall.locator(`.led[data-date="${TODAY}"]`).evaluate((e) => e.classList.contains('rest') && e.dataset.due === 'false');
    const look = await page.evaluate(() => {
      const r = document.querySelector('.win-history .mrow[data-slug="plan"] .led.rest:not(.on)');
      const m = document.querySelector('.win-history .mrow[data-slug="stretch"] .led:not(.on)');
      if (!r || !m) return { rest: String(r), missed: String(m), restOpacity: '1' };
      const cs = (e) => getComputedStyle(e);
      return { rest: cs(r).backgroundImage, missed: cs(m).backgroundImage, restOpacity: cs(r).opacity };
    });
    check(
      'History and the meters: rest days are hatched and dim, unlike a missed (dark) day',
      rest >= 15 && restToday && /repeating-linear-gradient/.test(look.rest) && look.missed === 'none' && Number(look.restOpacity) < 1 &&
        (await page.locator('.strip[data-slug="plan"] .meter .led.rest').count()) >= 6 &&
        (await page.locator('.strip[data-slug="stretch"] .meter .led.rest').count()) === 0,
      `${rest} ${restToday} ${JSON.stringify(look)}`,
    );
    check(
      'a rest day is named in its LED label',
      /\(rest day\)$/.test(await histCall.locator(`button.led[data-date="${TODAY}"]`).getAttribute('aria-label')),
    );
  }
  check('each key is a real toggle button', (await page.locator('.strip button.key[aria-pressed]').count()) === 6);
  check(
    '14 LEDs per meter on the desktop, with a text equivalent',
    (await page.locator('.strip[data-slug="stretch"] .meter .led').count()) === 14 &&
      /^Last 14 days: \d+ of 14 due days done$/.test(await page.locator('.strip[data-slug="stretch"] .meter').getAttribute('aria-label')) &&
      /^Last 14 days: \d+ of 7 due days done, 7 rest days$/.test(await page.locator('.strip[data-slug="plan"] .meter').getAttribute('aria-label')),
    await page.locator('.strip[data-slug="plan"] .meter').getAttribute('aria-label'),
  );
  check('streak counters are labelled and read the seeded streaks', (await page.locator('.strip[data-slug="stretch"] .seg7').getAttribute('aria-label')) === 'Streak 6 days' && (await seg(page, 'stretch')) === '06' && (await seg(page, 'tidy')) === '28');
  check('a zero streak is dim', await page.locator('.strip[data-slug="plan"] .seg7').evaluate((e) => e.classList.contains('zero')));
  const todayLeds = await page.locator('.strip[data-slug="stretch"] .meter .led.today').count();
  check("today's LED (and only it) has the amber ring", todayLeds === 1 && (await page.locator('.strip[data-slug="stretch"] .meter .led').last().evaluate((e) => e.classList.contains('today'))));
  check(
    'History: 32 columns per habit (31 toggle buttons, day 31 read-only), today ringed, Monday dates',
    (await page.locator('.win-history .mrow[data-slug="stretch"] .led').count()) === 32 &&
      (await page.locator('.win-history .mrow[data-slug="stretch"] button.led[aria-pressed]').count()) === 31 &&
      (await page.locator('.win-history .mrow[data-slug="stretch"] .led.old').count()) === 1 &&
      (await page.locator('.win-history .mrow .led.today').count()) === 6 &&
      (await page.locator('.mdate:not(:empty)').count()) >= 4,
  );
  check(
    'each History LED button is labelled with the habit and the day',
    (await page.locator(`.win-history .mrow[data-slug="stretch"] button.led[data-date="${TODAY}"]`).getAttribute('aria-label')) ===
      `Stretch, ${dayLabel(TODAY)}`,
  );
  const stats = await page.locator('.stats .lcd-value').allTextContents();
  const histApi = (await viaToken('GET', `/history?days=30&date=${TODAY}`)).body;
  check("History's three LCDs show the API's stats", stats.join(',') === `${histApi.stats.completionPct}%,${histApi.stats.bestLiveStreak},${histApi.stats.allDoneDays}`, stats.join(','));
  check('History lists the seeded notes, newest first', (await page.locator('.win-history .notes-list li').count()) === 8 && /river/.test(await page.locator('.win-history .notes-list li').first().textContent()));

  // Weather, normal state: every icon kind, the words, today highlighted.
  const kinds = await page.locator('.wx-day').evaluateAll((els) => els.map((e) => e.dataset.kind));
  check('weather: seven days', kinds.length === 7, kinds.join(','));
  check('weather: every icon kind drawn', ['sun', 'part', 'cloud', 'rain', 'storm', 'fog'].every((k) => kinds.includes(k)) && (await page.locator('svg.wx-icon[aria-hidden=true]').count()) === 7, kinds.join(','));
  check('weather: labels SUNNY…FOG under the days', (await page.locator('.wx-label').allTextContents()).join(',') === 'SUNNY,PARTLY,CLOUDY,SHOWERS,STORMS,FOG,SHOWERS');
  check('weather: today highlighted, updated time shown, not stale', (await page.locator('.wx-day.today').count()) === 1 && /^Updated \d{1,2}:\d{2} [AP]M$/.test(await page.locator('.wx-updated').textContent()));
  // Half a column (above AI Wire) is a compact tuner; the full height has the
  // 34px icons. AI Wire minimized frees the cells, Enter on the title bar fills.
  const small = await page.locator('svg.wx-icon.wx-sun').first().boundingBox();
  await page.click('.task-wire');
  await page.focus('#win-weather .title-bar');
  await page.keyboard.press('Enter');
  await settle(page);
  const icon = await page.locator('svg.wx-icon.wx-sun').first().boundingBox();
  check('weather icons are 34px in a full-height window (26px compact)', near(icon.width, 34, 1) && near(icon.height, 34, 1) && near(small.width, 26, 1), `${icon.width}x${icon.height}, compact ${small.width}`);
  await page.click('.start-btn');
  await page.click('.menu-reset-layout');
  await settle(page);

  // Check: optimistic in Today AND History together, then the server's numbers.
  await page.route('**/api/checks/**', async (r) => {
    await sleep(700);
    await r.continue();
  }, { times: 1 });
  await key(page, 'stretch').click();
  await sleep(100);
  check('check is optimistic: key down and LCD 1/5 at once', (await pressed(page, 'stretch')) && (await lcd(page)) === 'TODAY 1/5');
  check("…and History's today LED lights in the same moment", await histOn(page, 'stretch'));
  check("…and the meter's today LED too", (await page.locator('.strip[data-slug="stretch"] .meter .led.today').getAttribute('data-on')) === 'true');
  check('the key reads DONE', (await key(page, 'stretch').textContent()).includes('DONE'));
  await waitFor(page, () => document.querySelector('.strip[data-slug="stretch"] .seg-val')?.textContent === '07', 'streak 07');
  await idle(page);
  check('streak counter updates from the server to 07', (await seg(page, 'stretch')) === '07', `${await seg(page, 'stretch')} ${await lcd(page)} ${await pressed(page, 'stretch')}`);
  check('reaching 7 days shows a milestone balloon', (await balloonTexts(page)).includes('Stretch: 7 days'), (await balloonTexts(page)).join(' | '));
  check('…announced through the live region', await waitFor(page, () => document.getElementById('live')?.textContent === 'Stretch: 7 days', 'live region'));
  await shot(page, D('milestone-balloon'));
  await key(page, 'stretch').click();
  await sleep(100);
  check('uncheck clears Today and History together', !(await pressed(page, 'stretch')) && !(await histOn(page, 'stretch')) && (await lcd(page)) === 'TODAY 0/5');
  await idle(page);
  await key(page, 'stretch').click();
  await idle(page);
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await idle(page);
  check('a check persists across reload, in both windows', (await pressed(page, 'stretch')) && (await histOn(page, 'stretch')));
  await key(page, 'stretch').click();
  await idle(page);
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await idle(page);
  check('an uncheck persists across reload', !(await pressed(page, 'stretch')) && !(await histOn(page, 'stretch')));

  // Rollback on a forced 500.
  await page.route('**/api/checks/**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"forced failure"}' }), { times: 1 });
  await key(page, 'read').click();
  await page.waitForSelector('.dialog');
  check('a failed check shows a 98 error dialog with the API text', (await dialogTitle(page)) === "Couldn't check that" && /forced failure/.test(await page.locator('.dialog .dialog-message').textContent()));
  check('rollback: the key, the LCD and the History LED all go back', !(await pressed(page, 'read')) && (await lcd(page)) === 'TODAY 0/5' && !(await histOn(page, 'read')));
  await shot(page, D('error-rollback'));
  await page.click('.dialog .dialog-buttons button');
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await idle(page);
  check('server agrees: still unchecked', !(await pressed(page, 'read')));

  // Unreachable on load: Retry recovers.
  await page.route('**/api/today**', (r) => r.abort('connectionrefused'), { times: 1 });
  await page.reload();
  await page.waitForSelector('.dialog.unreachable');
  check('unreachable API shows "Can\'t reach PHT"', (await dialogTitle(page)) === "Can't reach PHT");
  await page.click('.dialog.unreachable button.default');
  await ready(page);
  await idle(page);
  check('Retry recovers', (await page.locator('.strip').count()) === 6);

  // Keyboard: number keys, N, ?, and nothing while typing.
  await page.locator('.brand-name').click();
  await page.keyboard.press('2');
  await sleep(80);
  check('key 2 toggles the second habit', await pressed(page, 'read'));
  await idle(page);
  await page.keyboard.press('2');
  await sleep(80);
  check('key 2 again unchecks it', !(await pressed(page, 'read')));
  await idle(page);
  await page.keyboard.press('n');
  check('N focuses the note, and types nothing', (await page.evaluate(() => document.activeElement?.classList.contains('note-input'))) && (await page.inputValue('.note-input')) === '');
  await page.keyboard.type('3 laps');
  await sleep(100);
  check('number keys are ignored while typing in the note', !(await pressed(page, 'water')) && (await page.inputValue('.note-input')) === '3 laps');
  await page.fill('.note-input', '');
  await page.locator('.brand-name').click();
  await idle(page);
  await page.keyboard.press('?');
  await page.waitForSelector('.help-window');
  check('? opens the keyboard help window', /1 – 9/.test(await page.locator('.help-window').textContent()));
  await page.keyboard.press('Escape');
  check('Esc closes it', !(await page.locator('.help-window').count()));

  // Note: debounced autosave, blur save, each surviving a reload; History follows.
  await page.fill('.note-input', 'Ran the long loop at dawn');
  await sleep(1300);
  await idle(page);
  check('note autosaves after typing stops', /Note saved/.test(await page.locator('.today-status').textContent()));
  check("History's notes show it at once (shared store)", (await page.locator('.win-history .notes-list li').first().locator('.note-line').textContent()) === 'Ran the long loop at dawn');
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await idle(page);
  check('note persisted across reload', (await page.inputValue('.note-input')) === 'Ran the long loop at dawn');
  check('the J-card is labelled SIDE A with the date', /^SIDE A · [A-Z][a-z]{2} \d{1,2}$/.test(await page.locator('.jcard-a .jcard-side').textContent()));
  await page.fill('.note-input', 'Ran the long loop at dawn, cool and clear');
  await page.locator('.brand-name').click(); // blur at once, inside the debounce
  await idle(page);
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await idle(page);
  check('note saved on blur before the debounce fired', (await page.inputValue('.note-input')) === 'Ran the long loop at dawn, cool and clear');

  // SIDE B: "What new thing did I learn today?" directly under SIDE A — the
  // same autosave (debounce, blur), surviving a reload; Learned follows.
  {
    const a = await box(page, '.jcard-a');
    const b = await box(page, '.jcard-b');
    check(
      'SIDE B · LEARNED sits directly under SIDE A, as wide, with its question',
      b.y >= a.y + a.height - 1 && b.y - (a.y + a.height) <= 12 && near(a.width, b.width) && (await page.locator('.jcard-b .jcard-side').textContent()) === 'SIDE B · LEARNED' && (await page.getAttribute('.learned-input', 'placeholder')) === 'What new thing did I learn today?',
      `${J(a)} ${J(b)}`,
    );
    const learnedApi = async (d) => (await viaToken('GET', `/learned?from=${d}&to=${d}`)).body?.entries?.[0]?.text ?? null;
    await page.fill('.learned-input', 'Bread rises more in a warm kitchen');
    await sleep(1300);
    await idle(page);
    check('SIDE B autosaves after typing stops, to today', /SIDE B saved/.test(await page.locator('.today-status').textContent()) && (await learnedApi(TODAY)) === 'Bread rises more in a warm kitchen');
    check(
      'the Learned window shows it at the top at once (shared store)',
      await waitFor(page, (t) => { const li = document.querySelector('.learned-list li'); return li?.dataset.date === t[0] && li.querySelector('.note-line')?.textContent === t[1]; }, 'learned follows', [TODAY, 'Bread rises more in a warm kitchen']),
    );
    await page.press('.learned-input', '3');
    check('number keys are ignored while typing in SIDE B', !(await pressed(page, 'water')) && (await page.inputValue('.learned-input')) === 'Bread rises more in a warm kitchen3');
    await page.fill('.learned-input', 'Bread rises the most in a warm kitchen');
    await page.locator('.brand-name').click(); // blur at once, inside the debounce
    await idle(page);
    await page.reload({ waitUntil: 'networkidle' });
    await ready(page);
    await idle(page);
    check('SIDE B saved on blur before the debounce fired, and persisted across a reload', (await page.inputValue('.learned-input')) === 'Bread rises the most in a warm kitchen' && (await learnedApi(TODAY)) === 'Bread rises the most in a warm kitchen');
    check('…SIDE A kept its own line', (await page.inputValue('.note-input')) === 'Ran the long loop at dawn, cool and clear');
    await shot(page, 'desktop-today-both-cards', { clip: await box(page, '#win-today') });
  }

  // The snap grid (all of it in dev/grid_check.mjs): a preset from Start ▸
  // Layouts, minimize/restore, and back to Three columns.
  await page.click('.start-btn');
  await page.click('.menu-layouts');
  await page.click('.menu-preset-wide');
  await settle(page);
  const wide = await widths(page);
  check('Start ▸ Layouts ▸ History wide', wide.history > wide.today * 1.9 && near(wide.today, wide.weather), JSON.stringify(wide));
  await page.mouse.move(5, 5);
  await shot(page, D('1920-history-wide'));
  await page.click('.task-weather');
  await settle(page);
  check('minimizing Weather hides it; the others keep their cells', (await widths(page)).weather === 0 && near((await widths(page)).history, wide.history) && (await page.getAttribute('.task-weather', 'aria-pressed')) === 'false');
  await page.click('.task-weather');
  await settle(page);
  check('restoring puts it back in its cells', near((await widths(page)).weather, wide.weather) && (await page.getAttribute('.task-weather', 'aria-pressed')) === 'true');
  await page.click('#win-today .min-btn');
  await settle(page);
  check("a window's own minimize button works too", (await widths(page)).today === 0 && (await page.getAttribute('.task-today', 'aria-pressed')) === 'false');
  await page.click('.task-today');
  await page.click('.start-btn');
  await page.click('.menu-reset-layout');
  await settle(page);
  { const w = await widths(page); check('Reset layout: three equal columns again', near(w.today, w.history) && near(w.history, w.weather), JSON.stringify(w)); }

  // ── Backfill: History's LEDs and the Today deck stepped back ──────────────
  {
    const YDAY = addDays(TODAY, -1);
    const cell = (slug, d) => page.locator(`.win-history .mrow[data-slug="${slug}"] [data-date="${d}"]`);
    const apiDay = async (d) => (await viaToken('GET', `/today?date=${d}`)).body;
    const streakOf = async (slug) => (await apiDay(TODAY)).habits.find((x) => x.slug === slug).streak;
    // Count every balloon and every LCD flash from here on (no celebrations on a backfill).
    const watchMoments = () =>
      page.evaluate(() => {
        window.__moments = 0;
        const mo = new MutationObserver((ms) => {
          for (const m of ms) {
            for (const n of m.addedNodes) if (n.classList?.contains('balloon')) window.__moments += 1;
            if (m.type === 'attributes' && m.target.classList.contains('flash')) window.__moments += 1;
          }
        });
        mo.observe(document.querySelector('.balloons'), { childList: true });
        mo.observe(document.querySelector('.today-lcd'), { attributes: true, attributeFilter: ['class'] });
      });
    const moments = () => page.evaluate(() => window.__moments);
    await watchMoments();
    const writes = [];
    const onReq = (r) => /\/api\/(checks|notes)\//.test(r.url()) && r.method() !== 'GET' && writes.push(`${r.method()} ${r.url()}`);
    page.on('request', onReq);

    // Day 31: dimmed and inert.
    const old = addDays(TODAY, -31);
    check('day 31 is not a button: dimmed and inert', (await cell('stretch', old).evaluate((e) => e.tagName)) === 'SPAN' && (await cell('stretch', old).evaluate((e) => e.classList.contains('old'))));
    await cell('stretch', old).click({ force: true });
    await page.locator(`.mhead [data-date="${old}"]`).click({ force: true });
    await idle(page);
    check('…clicking it sends nothing and opens nothing', writes.length === 0 && !(await page.locator('.deck.editing').count()), writes.join(' | '));

    // A History cell, yesterday: optimistic, then the streak follows.
    const planBefore = await streakOf('plan');
    const planWas = (await cell('plan', YDAY).getAttribute('aria-pressed')) === 'true';
    await cell('plan', YDAY).click();
    check("a History cell flips at once (aria-pressed)", (await cell('plan', YDAY).getAttribute('aria-pressed')) === String(!planWas));
    await idle(page);
    const planAfter = await streakOf('plan');
    check("backfilling yesterday from History changes the streak (API and Today's counter)", planAfter !== planBefore && Number(await seg(page, 'plan')) === planAfter, `${planBefore} → ${planAfter}, seg ${await seg(page, 'plan')}`);
    check('…written to yesterday', writes.some((w) => w.includes(`/checks/`) && w.endsWith(`/${YDAY}`)), writes.join(' | '));
    await cell('plan', YDAY).click();
    await idle(page);
    check('unchecking the cell puts the streak back', (await streakOf('plan')) === planBefore && (await cell('plan', YDAY).getAttribute('aria-pressed')) === String(planWas));

    // Clicking a header date opens that day in Today.
    const D2 = addDays(TODAY, -2);
    await page.locator(`.mhead button[data-date="${D2}"]`).click();
    check('a header date opens that day in Today: amber, EDITING, /day/ URL', await waitFor(page, (d) => location.pathname === `/day/${d}` && !!document.querySelector('.deck.editing'), 'day view', D2));
    check('…the LCD says EDITING and the date', (await lcd(page)) === `EDITING ${shortDate(D2).toUpperCase()}`);
    check('…and Back to today shows', await page.locator('.back-today').isVisible());
    await page.keyboard.press(']');
    check('] steps forward a day', await waitFor(page, (d) => location.pathname === `/day/${d}`, '] to yesterday', YDAY));
    await page.locator('.brand-name').click(); // focus off any button
    await shot(page, D('1920-editing'));

    // The stepped deck: a key, then the note, on yesterday.
    const waterBefore = await streakOf('water');
    const waterWas = await pressed(page, 'water');
    await key(page, 'water').click();
    check('on a past day a key flips at once, and its History cell with it', (await pressed(page, 'water')) === !waterWas && (await cell('water', YDAY).getAttribute('aria-pressed')) === String(!waterWas));
    await idle(page);
    check("…saved to that day", (await apiDay(YDAY)).habits.find((x) => x.slug === 'water').done === !waterWas);
    check("…and today's streak follows", (await streakOf('water')) !== waterBefore, `${waterBefore} → ${await streakOf('water')}`);
    await page.fill('.note-input', 'Backfilled the day after');
    await page.locator('.brand-name').click();
    await idle(page);
    check('the note on a past day saves to that day', (await viaToken('GET', `/notes?from=${YDAY}&to=${YDAY}`)).body?.[0]?.line === 'Backfilled the day after');
    check("…and History's notes show it", (await page.locator(`.win-history .notes-list li[data-date="${YDAY}"] .note-line`).textContent()) === 'Backfilled the day after');
    check('SIDE B on a past day asks about that day', (await page.getAttribute('.learned-input', 'placeholder')) === `What new thing did I learn on ${shortDate(YDAY)}?`);
    await page.fill('.learned-input', 'Cedar floats better dry');
    await page.locator('.brand-name').click();
    await idle(page);
    check('SIDE B on a past day saves to that day', (await viaToken('GET', `/learned?from=${YDAY}&to=${YDAY}`)).body?.entries?.[0]?.text === 'Cedar floats better dry');
    check("…and Learned shows it under that day", await waitFor(page, (d) => document.querySelector(`.learned-list li[data-date="${d}"] .note-line`)?.textContent === 'Cedar floats better dry', 'learned yday', YDAY));
    await key(page, 'water').click();
    await idle(page);
    check('unchecking on the past day puts the streak back', (await streakOf('water')) === waterBefore);

    // Every habit done on the past day: no all-done moment, no balloons.
    const flipped = [];
    for (const k of await page.locator('.strip').evaluateAll((els) => els.map((e) => e.dataset.slug))) {
      if (!(await pressed(page, k))) {
        await key(page, k).click();
        flipped.push(k);
        await idle(page);
      }
    }
    check('all done on a past day…', (await apiDay(YDAY)).doneCount === (await apiDay(YDAY)).total);
    check('…celebrates nothing: no flash, no balloon, all through the backfill', (await moments()) === 0, `${await moments()} moments`);
    for (const k of flipped) {
      await key(page, k).click();
      await idle(page);
    }

    // Limits: [ stops 30 days back; ] stops at today; out-of-window URLs go home.
    await page.goto(`${BASE}/day/${addDays(TODAY, -30)}`, { waitUntil: 'networkidle' });
    await ready(page);
    await idle(page);
    check('/day/ opens 30 days back directly', (await lcd(page)) === `EDITING ${shortDate(addDays(TODAY, -30)).toUpperCase()}` && (await page.locator('.day-prev').isDisabled()));
    await page.keyboard.press('[');
    await sleep(300);
    check('[ goes no further than 30 days back', new URL(page.url()).pathname === `/day/${addDays(TODAY, -30)}`);
    await page.goto(`${BASE}/day/${old}`, { waitUntil: 'networkidle' });
    await ready(page);
    await idle(page);
    check('a /day/ older than 30 days opens today at /', new URL(page.url()).pathname === '/' && /^TODAY /.test(await lcd(page)));
    await page.goto(`${BASE}/day/${addDays(TODAY, 1)}`, { waitUntil: 'networkidle' });
    await ready(page);
    check('a future /day/ opens today at /', await waitFor(page, () => location.pathname === '/', 'future → /'));
    await page.goto(`${BASE}/day/${YDAY}`, { waitUntil: 'networkidle' });
    await ready(page);
    await idle(page);
    await page.click('.back-today');
    check('Back to today: /, TODAY on the LCD, the deck no longer amber', await waitFor(page, () => location.pathname === '/' && !document.querySelector('.deck.editing') && /^TODAY /.test(document.querySelector('.today-lcd')?.textContent || ''), 'back to today'));
    await page.keyboard.press(']');
    await sleep(300);
    check('] goes no further than today', new URL(page.url()).pathname === '/');
    page.off('request', onReq);
  }

  // Start menu, by keyboard only.
  await page.focus('.start-btn');
  await page.keyboard.press('Enter');
  check('Enter on Start opens the menu with the first item focused', (await page.getAttribute('.start-btn', 'aria-expanded')) === 'true' && (await page.evaluate(() => document.activeElement?.dataset.item)) === 'setup');
  check(
    'the menu has real menu semantics, Layouts a submenu of the four presets',
    (await page.locator('.start-menu > ul[role=menu] > li > [role=menuitem]').count()) === 6 &&
      (await page.getAttribute('.menu-layouts', 'aria-haspopup')) === 'menu' &&
      (await page.locator('.start-sub [role=menu] [role=menuitem]').count()) === 4,
  );
  await page.keyboard.press('ArrowDown');
  check('ArrowDown moves to the next item', (await page.evaluate(() => document.activeElement?.dataset.item)) === 'retired');
  await page.keyboard.press('End');
  check('End goes to Log Off', (await page.evaluate(() => document.activeElement?.dataset.item)) === 'logoff');
  await page.keyboard.press('ArrowDown');
  check('ArrowDown wraps to the top', (await page.evaluate(() => document.activeElement?.dataset.item)) === 'setup');
  await page.keyboard.press('ArrowUp');
  check('ArrowUp wraps to the bottom', (await page.evaluate(() => document.activeElement?.dataset.item)) === 'logoff');
  await page.keyboard.press('Escape');
  check('Esc closes the menu and returns focus to Start', (await page.isHidden('.start-menu')) && (await page.evaluate(() => document.activeElement?.classList.contains('start-btn'))) && (await page.getAttribute('.start-btn', 'aria-expanded')) === 'false');
  await page.keyboard.press('ArrowUp');
  check('ArrowUp on Start opens the menu at the last item', (await page.evaluate(() => document.activeElement?.dataset.item)) === 'logoff');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.display-window');
  check('Enter on an item runs it (Display Properties opens) and closes the menu', await page.isHidden('.start-menu'));

  // Display Properties: each wallpaper, Apply / OK / Cancel, persistence.
  check('Synthwave is the default', (await page.getAttribute('#desktop', 'data-wallpaper')) === 'synthwave' && (await page.locator('.wp-option.selected').textContent()) === 'Synthwave');
  check('the animation is off by default', !(await page.isChecked('.animate-box')));
  await shot(page, D('display-properties'));
  await page.click('.wp-option[data-wallpaper="memphis"]');
  check('picking a wallpaper previews it, and changes nothing yet', (await page.getAttribute('.monitor-screen', 'class')).includes('wp-memphis') && (await page.getAttribute('#desktop', 'data-wallpaper')) === 'synthwave');
  await page.click('.display-window [data-act="apply"]');
  check('Apply puts Memphis on the desktop', (await page.getAttribute('#desktop', 'data-wallpaper')) === 'memphis' && (await page.locator('#desktop.wp-memphis').count()) === 1);
  await page.click('.display-window [data-act="cancel"]');
  await sleep(100);
  await shot(page, D('1920-memphis'));
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  check('the wallpaper persists across reload', (await page.getAttribute('#desktop', 'data-wallpaper')) === 'memphis');
  await page.click('.start-btn');
  await page.click('.menu-display');
  await page.focus('.wp-list');
  await page.keyboard.press('End');
  check('the wallpaper list works by keyboard', (await page.locator('.wp-option.selected').textContent()) === 'Teal');
  await page.click('.display-window [data-act="ok"]');
  check('OK applies Teal and closes the window', (await page.getAttribute('#desktop', 'data-wallpaper')) === 'teal' && !(await page.locator('.display-window').count()));
  await idle(page);
  await shot(page, D('1920-teal'));
  await page.click('.start-btn');
  await page.click('.menu-display');
  await page.click('.wp-option[data-wallpaper="synthwave"]');
  await page.click('.display-window [data-act="cancel"]');
  check('Cancel throws the choice away', (await page.getAttribute('#desktop', 'data-wallpaper')) === 'teal');
  await page.click('.start-btn');
  await page.click('.menu-display');
  await page.click('.wp-option[data-wallpaper="synthwave"]');
  await page.click('.animate-row label');
  await page.click('.display-window [data-act="ok"]');
  const anim = await page.locator('.wp-grid').evaluate((e) => getComputedStyle(e).animationName);
  check('Synthwave with "Animate wallpaper" scrolls the grid (a CSS animation)', (await page.getAttribute('#desktop', 'data-wallpaper')) === 'synthwave' && anim === 'wp-scroll', anim);
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  check('the animation setting persists', (await page.locator('.wp-grid').evaluate((e) => getComputedStyle(e).animationName)) === 'wp-scroll');
  await page.click('.start-btn');
  await page.click('.menu-display');
  await page.click('.animate-row label');
  await page.click('.display-window [data-act="ok"]');
  check('…and turns off again', (await page.locator('.wp-grid').evaluate((e) => getComputedStyle(e).animationName)) === 'none');

  // Info: opens over the grid at /habit/:id, drags, clamps, Esc returns focus.
  await nameBtn(page, 'stretch').click();
  await page.waitForSelector('.info-window .stat-row');
  check('the name opens Info at /habit/:id, over the grid', /\/habit\/\d+$/.test(page.url()) && (await page.locator('.desk .info-window').count()) === 0 && (await page.locator('.strip').count()) === 6, page.url());
  check('Info shows current/best/total and 14 LEDs', (await page.locator('.info-window .stat-value').allTextContents()).length === 3 && (await page.locator('.info-window .info-meter .led').count()) === 14);
  const i0 = await box(page, '.info-window');
  check('Info opens centred', near(i0.x + i0.width / 2, 960, 2), `${i0.x}`);
  // Up by as much as there is room for (Info is tall: it has the schedule).
  const up = Math.min(200, Math.floor(i0.y) - 10);
  await drag(page, '.info-window .title-bar-text', -500, -up);
  const i1 = await box(page, '.info-window');
  check('dragging the title bar moves Info', up >= 40 && near(i1.x, i0.x - 500, 2) && near(i1.y, i0.y - up, 2), `${i1.x},${i1.y} (up ${up})`);
  await drag(page, '.info-window .title-bar-text', -5000, -5000);
  const i2 = await box(page, '.info-window');
  check('…and it stays inside the viewport', i2.x >= 0 && i2.y >= 0 && i2.x < 2 && i2.y < 2, `${i2.x},${i2.y}`);
  await drag(page, '.info-window .title-bar-text', 5000, 5000);
  const i3 = await box(page, '.info-window');
  const tbY = (await box(page, '.taskbar')).y;
  check('…on every side, above the taskbar', i3.x + i3.width <= 1920 + 0.5 && i3.y + i3.height <= tbY + 0.5, `${i3.x + i3.width},${i3.y + i3.height}`);
  await page.keyboard.press('Escape');
  check('Esc closes Info, back at /', !(await page.locator('.info-window').count()) && new URL(page.url()).pathname === '/');
  check('…and focus returns to the habit name that opened it', await nameBtn(page, 'stretch').evaluate((e) => e === document.activeElement));
  await nameBtn(page, 'read').click();
  await page.waitForSelector('.info-window .stat-row');
  await shot(page, D('info-open'));
  await page.goBack();
  await sleep(200);
  check('browser Back closes Info', !(await page.locator('.info-window').count()) && new URL(page.url()).pathname === '/');
  await page.goForward();
  await page.waitForSelector('.info-window .stat-row');
  check('browser Forward opens it again', /\/habit\/\d+$/.test(page.url()));
  await page.click('.info-window .title-bar-controls button');
  check('× closes it', !(await page.locator('.info-window').count()) && new URL(page.url()).pathname === '/');
  const readId = await key(page, 'read').getAttribute('data-habit-id');
  await page.goto(`${BASE}/habit/${readId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.info-window .stat-row');
  check('opening /habit/:id directly shows the desktop with Info open', (await page.locator('.strip').count()) === 6);
  await page.keyboard.press('Escape');
  check('…and closing it there replaces the URL with /', new URL(page.url()).pathname === '/');
  await page.goto(`${BASE}/history`, { waitUntil: 'networkidle' });
  await ready(page);
  check('an old one-window path is replaced by /', new URL(page.url()).pathname === '/');

  // Info: ramp, rename, retire; Retired habits: unretire; Setup: add, reorder.
  await nameBtn(page, 'stretch').click();
  await page.waitForSelector('.info-window .ramp-input');
  await page.fill('.ramp-input', '5 min, then 10');
  await page.click('.ramp-save');
  await idle(page);
  check('rampText saved', /Ramp saved/.test(await page.locator('.info-window .status-bar-field').textContent()));
  await page.click('.rename-btn');
  await page.fill('#dialog-input', 'Stretch longer');
  await page.click('.dialog button.default');
  await idle(page);
  check('rename updates Info, the strip and the History row', (await page.locator('.info-window .title-bar-text').textContent()) === 'Stretch longer' && (await nameBtn(page, 'stretch').textContent()) === 'Stretch longer' && (await page.locator('.win-history .mrow[data-slug="stretch"] .mlabel').textContent()) === 'Stretch longer');
  await page.click('.rename-btn');
  await page.fill('#dialog-input', 'Stretch');
  await page.click('.dialog button.default');
  await idle(page);
  // Info ▸ Schedule: every other day with today off, then back to every day.
  {
    check('Info shows the schedule', /^Now: Daily$/.test(await page.locator('.info-window .schedule-now').textContent()) && (await page.locator('.info-window .schedule-save').isDisabled()));
    await page.click('.info-window .schedule-every_other_day + label');
    await page.selectOption('.info-window select.schedule-eod', 'tomorrow');
    await page.click('.info-window .schedule-save');
    await waitFor(page, () => document.querySelector('.strip[data-slug="stretch"]')?.classList.contains('rest'), 'stretch resting');
    await idle(page);
    const stretchApi = (await viaToken('GET', '/habits')).body.find((x) => x.slug === 'stretch');
    check(
      'Info ▸ Schedule: every other day, today off — REST on the deck, saved from today',
      JSON.stringify(stretchApi.schedule) === JSON.stringify({ kind: 'every_other_day', anchor: addDays(TODAY, 1) }) &&
        stretchApi.scheduleFrom === TODAY &&
        (await key(page, 'stretch').textContent()) === 'REST' &&
        /Every other day \(rest today\)/.test(await page.locator('.info-window .schedule-now').textContent()) &&
        /from today/.test(await page.locator('.info-window .status-bar-field').textContent()),
      JSON.stringify(stretchApi),
    );
    await page.click('.info-window .schedule-daily + label');
    await page.click('.info-window .schedule-save');
    await waitFor(page, () => !document.querySelector('.strip[data-slug="stretch"]')?.classList.contains('rest'), 'stretch due again');
    await idle(page);
    check('…back to every day, the streak untouched', (await key(page, 'stretch').textContent()) === 'TODAY' && (await seg(page, 'stretch')) === '06');
  }
  await page.click('.retire-btn');
  await page.waitForSelector('.dialog');
  check('retire asks for confirmation', (await dialogTitle(page)) === 'Retire habit');
  await page.click('.dialog button.default');
  await idle(page);
  check('a retired habit leaves Today and History, and Info closes', (await page.locator('.strip').count()) === 5 && (await page.locator('.win-history .mrow[data-slug="stretch"]').count()) === 0 && !(await page.locator('.info-window').count()));
  await page.click('.start-btn');
  await page.click('.menu-retired');
  await page.waitForSelector('.retired-list [data-slug="stretch"]');
  await page.click('.retired-list [data-slug="stretch"] .unretire-btn');
  await idle(page);
  check('Unretire brings it back to the desktop with its history', (await page.locator('.strip').count()) === 6 && (await seg(page, 'stretch')) === '06');
  await page.keyboard.press('Escape');
  await page.click('.start-btn');
  await page.click('.menu-setup');
  await page.waitForSelector('.setup-window .active-list');
  await page.click('.active-list [data-slug="tidy"] .move-up');
  await idle(page);
  const order = await page.locator('.strip').evaluateAll((els) => els.map((e) => e.dataset.slug).join(','));
  check('Setup reorders, and the desktop follows', order === 'stretch,read,water,journal,tidy,plan', order);
  await page.fill('.new-label', 'Floss');
  await page.click('.add-btn');
  await page.waitForSelector('.strip[data-slug="floss"]');
  await idle(page);
  check('Setup adds a habit: a new strip and a new History row', (await page.locator('.strip').count()) === 7 && (await page.locator('.win-history .mrow[data-slug="floss"]').count()) === 1 && (await lcd(page)) === 'TODAY 0/6');

  // Schedules from Setup: Water on the weekdays other than today's, then
  // back to every day. The streak maths is the API's (pht-api tests).
  {
    const wd = new Date(`${TODAY}T00:00:00Z`).getUTCDay();
    const habitsApi = async () => (await viaToken('GET', '/habits')).body;
    const waterId = String((await habitsApi()).find((x) => x.slug === 'water').id);
    await page.selectOption('.setup-window .schedule-habit', waterId);
    await page.click('.setup-window .schedule-weekdays + label');
    for (let d = 0; d < 7; d += 1) {
      const box = page.locator(`.setup-window .schedule-day[value="${d}"]`);
      if ((await box.isChecked()) !== (d !== wd)) await page.click(`.setup-window .schedule-day[value="${d}"] + label`);
    }
    await page.click('.setup-window .schedule-save');
    await waitFor(page, () => document.querySelector('.strip[data-slug="water"]')?.classList.contains('rest'), 'water resting');
    await idle(page);
    const w = (await habitsApi()).find((x) => x.slug === 'water');
    const wantDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== wd);
    check(
      'Setup ▸ Schedule: Water on the other six weekdays, from today; today it rests',
      JSON.stringify(w.schedule) === JSON.stringify({ kind: 'weekdays', days: wantDays }) && w.scheduleFrom === TODAY &&
        (await key(page, 'water').textContent()) === 'REST' && (await lcd(page)) === 'TODAY 0/5',
      `${JSON.stringify(w)} ${await lcd(page)}`,
    );
    check('…and Setup names it', /water/i.test(await page.locator('.setup-window .schedule-habit option:checked').textContent()) && /Now: /.test(await page.locator('.setup-window .schedule-now').textContent()));
    await page.selectOption('.setup-window .schedule-habit', waterId);
    await page.click('.setup-window .schedule-daily + label');
    await page.click('.setup-window .schedule-save');
    await waitFor(page, () => !document.querySelector('.strip[data-slug="water"]')?.classList.contains('rest'), 'water due again');
    await idle(page);
    check('…and back to every day', (await habitsApi()).find((x) => x.slug === 'water').schedule.kind === 'daily' && (await lcd(page)) === 'TODAY 0/6', await lcd(page));
  }
  check('Setup shows the time zone, the current one selected', (await page.inputValue('.zone-select')) === TZ && (await page.locator('.zone-select option').count()) > 100);
  // Pick a zone at least a few hours away, so the clock visibly moves.
  const other = TZ === 'Pacific/Kiritimati' ? 'Pacific/Tahiti' : 'Pacific/Kiritimati';
  await page.selectOption('.zone-select', other);
  await page.click('.zone-set');
  await page.waitForEvent('load');
  await ready(page);
  await idle(page);
  // /settings is JWT-only: read it with the page's own session.
  const savedZone = () => page.evaluate(async () => (await (await fetch('/api/settings/timezone', { headers: { Authorization: `Bearer ${localStorage.getItem('pht:token')}` } })).json()).timezone);
  // The clock ticks every 10s, so across a minute boundary it can lag that long.
  const clockShows = (tz) =>
    waitFor(page, (z) => document.querySelector('.clock')?.textContent === new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: z }).format(new Date()), `clock in ${tz}`, tz, 12_000);
  check('Set saves it through the API', (await savedZone()) === other);
  check('…and the desktop restarts on it: the clock shows that zone', await clockShows(other));
  await page.evaluate(async (tz) => {
    await fetch('/api/settings/timezone', { method: 'PUT', headers: { Authorization: `Bearer ${localStorage.getItem('pht:token')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: tz }) });
  }, TZ);
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await idle(page);
  check('…and back', (await savedZone()) === TZ && (await clockShows(TZ)));

  // The all-done moment: once per day per device.
  await page.locator('.brand-name').click();
  for (let i = 1; i <= 7; i += 1) {
    await page.keyboard.press(String(i));
    await sleep(60);
  }
  check('keys 1–7 check every habit, the resting one too', (await page.locator('.strip .key[aria-pressed="true"]').count()) === 7);
  await waitFor(page, () => /^ALL 6/.test(document.querySelector('.today-lcd')?.textContent || ''), 'ALL 6 on the LCD');
  check('the LCD flashes "ALL 6 ✓" (the six habits due)', (await lcd(page)) === 'ALL 6 ✓' && (await page.locator('.today-lcd.flash').count()) === 1);
  check('a balloon says "All habits complete. Streaks safe."', (await balloonTexts(page)).includes('All habits complete. Streaks safe.'));
  check('remembered for the day on this device', (await page.evaluate(() => localStorage.getItem('pht:all-done'))) === JSON.stringify(TODAY));
  await shot(page, D('all-done-balloon'));
  await idle(page);
  await page.locator('.balloon .balloon-close').evaluateAll((els) => els.forEach((e) => e.click()));
  await key(page, 'plan').click();
  await idle(page);
  await key(page, 'plan').click();
  await idle(page);
  await sleep(300);
  check('unchecking and re-checking does not repeat it', !(await balloonTexts(page)).includes('All habits complete. Streaks safe.'));
  await waitFor(page, () => document.querySelector('.today-lcd')?.textContent === 'TODAY 6/6', 'LCD back', undefined, 4000);
  check('the LCD returns to TODAY 6/6', (await lcd(page)) === 'TODAY 6/6');
  // Leave a mix for the remaining screenshots, and Floss retired.
  for (const slug of ['read', 'water', 'plan', 'floss']) {
    await key(page, slug).click();
    await idle(page);
  }
  await nameBtn(page, 'floss').click();
  await page.waitForSelector('.info-window .retire-btn');
  await page.click('.retire-btn');
  await page.click('.dialog button.default');
  await idle(page);

  // Weather: stale, not configured, unavailable — in the window, never a dialog.
  const stale = (await viaToken('GET', '/weather')).body;
  stale.stale = true;
  await page.route('**/api/weather', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stale) }), { times: 1 });
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await idle(page);
  check('weather: a stale copy still shows, marked OFFLINE COPY', (await page.locator('.wx-day').count()) === 7 && / · OFFLINE COPY$/.test(await page.locator('.wx-updated').textContent()));
  await page.route('**/api/weather', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"weather not configured"}' }), { times: 1 });
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await idle(page);
  check('weather: 503 shows "not configured" in the window', (await page.locator('.wx-msg').textContent()) === 'WEATHER NOT CONFIGURED' && (await page.locator('.wx-day').count()) === 0);
  check('…with no dialog', !(await page.locator('.dialog').count()));
  await shot(page, D('weather-not-configured'), { clip: await box(page, '#win-weather') });
  await page.route('**/api/weather', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"weather unavailable"}' }), { times: 1 });
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await idle(page);
  check('weather: 502 with no copy shows "unavailable", no dialog', /UNAVAILABLE/.test(await page.locator('.wx-msg').textContent()) && !(await page.locator('.dialog').count()));
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await idle(page);
  check('weather: back to normal on the next load', (await page.locator('.wx-day').count()) === 7);

  // A 401 sends the page back to Login.
  await page.evaluate(() => localStorage.setItem('pht:token', 'not-a-real-token'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.login-window');
  check('a 401 returns to Login and clears the token', (await page.evaluate(() => localStorage.getItem('pht:token'))) === null);
  await context.close();
}

// ─────────────── reduced motion: no animation, no splash ───────────────
{
  const { context, page } = await newContext({ width: 1440, height: 900 }, false, { reducedMotion: 'reduce' });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('pht:animate', 'true');
    localStorage.setItem('pht:wallpaper', '"synthwave"');
  });
  await login(page);
  check('reduced motion: no splash even after a fresh login', (await page.locator('#desktop').getAttribute('data-splash')) === 'skipped' && !(await page.locator('.splash').count()));
  check('reduced motion: the grid does not move although Animate is on', (await page.locator('#desktop.wp-animate').count()) === 1 && (await page.locator('.wp-grid').evaluate((e) => getComputedStyle(e).animationName)) === 'none');
  for (const wp of ['memphis', 'teal']) {
    await page.evaluate((w) => localStorage.setItem('pht:wallpaper', JSON.stringify(w)), wp);
    await page.reload({ waitUntil: 'networkidle' });
    await ready(page);
    const moving = await page.evaluate(() => [...document.querySelectorAll('.wallpaper, .wallpaper *')].some((e) => getComputedStyle(e).animationName !== 'none'));
    check(`${wp}: no motion at all`, !moving);
  }
  await context.close();
}

// ─────────────────────────── phone, 390 × 844 ───────────────────────────────
{
  const { context, page } = await newContext({ width: 390, height: 844 }, true);
  const P = (n) => `phone-${n}`;
  await login(page);
  await settled(page);
  const tb = await box(page, '#win-today');
  const hb = await box(page, '#win-history');
  const wb = await box(page, '#win-weather');
  check('phone: windows stack Today, History, Weather', tb.y < hb.y && hb.y < wb.y && near(tb.x, hb.x) && near(hb.x, wb.x) && tb.width > 370, `${tb.y},${hb.y},${wb.y}`);
  check('phone: no resize handles or grid, no horizontal scroll', (await page.locator('.rh:visible, .snap-lines:visible').count()) === 0 && (await page.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  {
    const bar = await box(page, '#win-history .title-bar');
    await page.mouse.move(bar.x + 40, bar.y + 10);
    await page.mouse.down();
    await page.mouse.move(bar.x + 40, bar.y + 300, { steps: 6 });
    await page.mouse.up();
    const hb2 = await box(page, '#win-history');
    check('phone: a title-bar drag moves nothing', near(hb2.y, hb.y) && near(hb2.x, hb.x) && !(await page.locator('#desktop.snapping').count()), `${hb.y} → ${hb2.y}`);
  }
  const visibleTaskbar = await page.locator('.taskbar > *').evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.className));
  check('phone: the taskbar shows only Start and the clock', visibleTaskbar.join(',') === 'start-btn,tray', visibleTaskbar.join(','));
  check('phone: no minimize buttons', !(await page.locator('.min-btn').first().isVisible()));
  check('phone: 7 LEDs per meter and 7 History columns', (await page.locator('.strip[data-slug="stretch"] .meter .led').count()) === 7 && (await page.locator('.win-history .mrow[data-slug="stretch"] .led').count()) === 7 && /last 7 days/.test(await page.locator('#title-history').textContent()));
  const kb = await key(page, 'stretch').boundingBox();
  check('phone: each key is at least 44px tall', kb.height >= 44, `${kb.height}`);
  await shot(page, P('390-top'));
  await page.evaluate(() => window.scrollTo(0, document.querySelector('#win-weather').getBoundingClientRect().top + window.scrollY - 60));
  await sleep(200);
  await shot(page, P('390-scrolled'));
  await page.evaluate(() => window.scrollTo(0, 0));
  await nameBtn(page, 'read').click();
  await page.waitForSelector('.info-window .stat-row');
  const ib = await box(page, '.info-window');
  check('phone: Info is a full-width sheet', near(ib.width, 390, 1) && near(ib.x, 0, 1) && near(ib.y + ib.height, 844, 2), JSON.stringify(ib));
  await shot(page, P('390-info-sheet'));
  await page.click('.info-window .title-bar-controls button');

  // Standalone view: safe-area insets as on an iPhone. Emulated through CDP,
  // so Chrome only.
  if (FIREFOX) {
    console.log('SKIP  standalone safe-area insets (CDP only; covered by the Chrome run)');
    await context.close();
  } else {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 47, topMax: 47, bottom: 34, bottomMax: 34, left: 0, leftMax: 0, right: 0, rightMax: 0 },
  });
  await sleep(200);
  const tbar = await box(page, '.taskbar');
  const first = await box(page, '#win-today');
  check('standalone: the first window starts below the status bar (47px)', first.y >= 47, `${first.y}`);
  check('standalone: the taskbar clears the home indicator (34px)', near(844 - (tbar.y + tbar.height), 0, 1) && (await page.locator('.start-btn').boundingBox()).y + 32 <= 844 - 34 + 1, `${tbar.y + tbar.height}`);
  await shot(page, P('390-standalone'));
  await cdp.detach();
  await context.close();
  }
}

// ───────────── refresh on return, sessions, midnight, install (desktop) ─────────────
{
  const { context, page } = await newContext({ width: 1440, height: 900 }, false);
  await page.clock.install({ time: new Date() });
  const jump = (ms) => page.clock.setSystemTime(new Date(ms));
  const focusBack = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const visibleAgain = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const now = () => page.evaluate(() => Date.now());

  // Session renewal through X-PHT-Token.
  const t0 = Date.now();
  const aged = jwt.sign(
    { username: USER, stage: 'full', iatMs: t0 - 25 * 86_400_000, iat: Math.floor((t0 - 25 * 86_400_000) / 1000) },
    JWT_SECRET,
    { expiresIn: 30 * 86_400 },
  );
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.evaluate((t) => localStorage.setItem('pht:token', t), aged);
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await idle(page);
  const stored = await page.evaluate(() => localStorage.getItem('pht:token'));
  check('an aged session token is renewed on first use', stored && stored !== aged, 'token unchanged');
  check('the renewed token runs a full 30 days from now', Math.abs(claims(stored).exp * 1000 - (Date.now() + 30 * 86_400_000)) < 120_000);

  const today = dateIn(await now());
  const textId = Number(await key(page, 'journal').getAttribute('data-habit-id'));
  const textWas = await pressed(page, 'journal');
  const want = !textWas;
  check('the widget changes "journal" behind the page', (await viaToken(want ? 'PUT' : 'DELETE', `/checks/${textId}/${today}`)).status === 200);
  await focusBack();
  await sleep(400);
  check('within 30 s of the last load, focus does not refetch', (await pressed(page, 'journal')) === textWas);
  await jump((await now()) + 31_000);
  await focusBack();
  check('after 30 s, regaining focus shows it in Today', await waitFor(page, (w) => document.querySelector('.strip[data-slug="journal"] .key')?.getAttribute('aria-pressed') === String(w), 'text after focus', want));
  check('…and in History', (await histOn(page, 'journal')) === want);
  await viaToken(textWas ? 'PUT' : 'DELETE', `/checks/${textId}/${today}`);
  await jump((await now()) + 31_000);
  await visibleAgain();
  check('visibilitychange refreshes too', await waitFor(page, (w) => document.querySelector('.strip[data-slug="journal"] .key')?.getAttribute('aria-pressed') === String(w), 'text after visibility', textWas));

  // An unsaved note is never overwritten by a refresh.
  await viaToken('PUT', `/notes/${today}`, { line: 'written by the widget' });
  await page.click('.note-input');
  await page.fill('.note-input', 'draft in progress');
  await jump((await now()) + 31_000);
  await focusBack();
  await sleep(500);
  check('a note being edited is not overwritten by a refresh', (await page.inputValue('.note-input')) === 'draft in progress');
  await page.locator('.brand-name').click(); // blur → save
  await idle(page);
  check('…and the edit, not the refresh, is what gets saved', (await viaToken('GET', `/notes?from=${today}&to=${today}`)).body?.[0]?.line === 'draft in progress');
  await viaToken('PUT', `/notes/${today}`, { line: 'the widget wins this one' });
  await jump((await now()) + 31_000);
  await focusBack();
  check('a note with no edit in progress does follow a refresh', await waitFor(page, () => document.querySelector('.note-input')?.value === 'the widget wins this one', 'note refreshed'));
  // The same rule for SIDE B.
  await viaToken('PUT', `/learned/${today}`, { text: 'learned elsewhere' });
  await page.click('.learned-input');
  await page.fill('.learned-input', 'learned here, still typing');
  await jump((await now()) + 31_000);
  await focusBack();
  await sleep(500);
  check('SIDE B being edited is not overwritten by a refresh', (await page.inputValue('.learned-input')) === 'learned here, still typing');
  await page.locator('.brand-name').click();
  await idle(page);
  check("…and the edit is what gets saved", (await viaToken('GET', `/learned?from=${today}&to=${today}`)).body?.entries?.[0]?.text === 'learned here, still typing');
  await viaToken('PUT', `/learned/${today}`, { text: 'learned elsewhere, later' });
  await jump((await now()) + 31_000);
  await focusBack();
  check('SIDE B with no edit in progress follows a refresh', await waitFor(page, () => document.querySelector('.learned-input')?.value === 'learned elsewhere, later', 'learned refreshed'));

  // Midnight rollover, with an unsaved note typed just before it.
  const tomorrow = addDays(today, 1);
  await page.fill('.learned-input', 'learned just before midnight');
  await page.click('.note-input');
  await page.fill('.note-input', 'last thing before midnight');
  await jump(midnightOf(tomorrow, await now()) + 20_000);
  await visibleAgain();
  check('past midnight, the desktop switches to the new date', await waitFor(page, (d) => document.querySelector('.deck-date')?.textContent === d, 'new date', longDate(tomorrow)));
  check('…with nothing done yet on the new day', await waitFor(page, () => /^TODAY 0\/\d+$/.test(document.querySelector('.today-lcd')?.textContent || ''), 'LCD 0/n'));
  check("…History's today column moved with it", (await page.locator('.win-history .mrow .led.today').first().getAttribute('data-date')) === tomorrow);
  check('…and an empty note for the new day', (await page.inputValue('.note-input')) === '');
  await idle(page);
  check('the note typed before midnight was saved to the old day', (await viaToken('GET', `/notes?from=${today}&to=${today}`)).body?.[0]?.line === 'last thing before midnight');
  check('…SIDE B typed before midnight too, and the new day starts empty', (await viaToken('GET', `/learned?from=${today}&to=${today}`)).body?.entries?.[0]?.text === 'learned just before midnight' && (await page.inputValue('.learned-input')) === '');
  await jump(Date.now());
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  check('back at real time, the real date again', (await page.locator('.deck-date').textContent()) === longDate(today));

  // On a past day, a refresh and even midnight leave the deck where it is.
  {
    const past = addDays(today, -3);
    await page.goto(`${BASE}/day/${past}`, { waitUntil: 'networkidle' });
    await ready(page);
    await idle(page);
    const was = await pressed(page, 'journal');
    await viaToken(was ? 'DELETE' : 'PUT', `/checks/${textId}/${past}`);
    await jump((await now()) + 31_000);
    await focusBack();
    check('on a past day, a refresh shows a change behind the page on that day', await waitFor(page, (w) => document.querySelector('.strip[data-slug="journal"] .key')?.getAttribute('aria-pressed') === String(w), 'past refresh', !was));
    check('…and stays on that day', new URL(page.url()).pathname === `/day/${past}` && (await lcd(page)) === `EDITING ${shortDate(past).toUpperCase()}`);
    await viaToken(was ? 'PUT' : 'DELETE', `/checks/${textId}/${past}`);
    await page.click('.note-input');
    await page.fill('.note-input', 'mid-edit at midnight');
    await jump(midnightOf(addDays(today, 1), await now()) + 20_000);
    await visibleAgain();
    check('past midnight, History moves to the new day…', await waitFor(page, (d) => document.querySelector('.win-history .mrow .led.today')?.dataset.date === d, 'history moved', addDays(today, 1)));
    check('…but a deck editing a past day stays on it, with the edit', new URL(page.url()).pathname === `/day/${past}` && (await lcd(page)) === `EDITING ${shortDate(past).toUpperCase()}` && (await page.inputValue('.note-input')) === 'mid-edit at midnight');
    await page.locator('.brand-name').click();
    await idle(page);
    check('…and the edit saves to that day', (await viaToken('GET', `/notes?from=${past}&to=${past}`)).body?.[0]?.line === 'mid-edit at midnight');
    await jump(Date.now());
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await ready(page);
  }

  // Installable: manifest, icons, metas.
  // Chrome parses it through CDP (with its own error list); Firefox has no
  // such hook, so there it is fetched from the <link> and parsed here.
  const cdp = FIREFOX ? null : await context.newCDPSession(page);
  const manifest = cdp
    ? await cdp.send('Page.getAppManifest')
    : { errors: [], data: await (await page.request.get(new URL(await page.getAttribute('link[rel="manifest"]', 'href'), BASE).href)).text() };
  const m = JSON.parse(manifest.data || '{}');
  check('the manifest loads and parses with no errors', manifest.errors.length === 0 && !!manifest.data, JSON.stringify(manifest.errors));
  check(
    'manifest: PHT, standalone, start_url /, navy theme, teal background',
    m.name === 'PHT' && m.short_name === 'PHT' && m.display === 'standalone' && m.start_url === '/' && m.theme_color === '#000080' && m.background_color === '#008080',
    JSON.stringify(m),
  );
  const iconUrls = [...m.icons.map((i) => i.src), await page.getAttribute('link[rel="apple-touch-icon"]', 'href')];
  const wantSize = { '/icons/icon-192.png': 192, '/icons/icon-512.png': 512, '/icons/apple-touch-icon.png': 180 };
  for (const u of iconUrls) {
    const r = await page.request.get(BASE + u);
    const buf = await r.body();
    const w = buf.readUInt32BE(16);
    check(`icon ${u} is a ${wantSize[u]}px PNG`, r.status() === 200 && r.headers()['content-type'] === 'image/png' && w === wantSize[u], `${r.status()} ${w}`);
  }
  check('no service worker is registered', (await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0)) === 0);
  const font = await page.request.get(BASE + '/vendor/dseg/DSEG7Classic-Bold.woff2');
  const lic = await page.request.get(BASE + '/vendor/dseg/DSEG-LICENSE.txt');
  check('the 7-segment font is self-hosted with its OFL licence', font.status() === 200 && lic.status() === 200 && /Open Font License/.test(await lic.text()));
  check('…and actually used by the counters', await page.evaluate(() => document.fonts.check("26px 'DSEG7'") && getComputedStyle(document.querySelector('.seg7')).fontFamily.includes('DSEG7')));
  await cdp?.detach();

  // Log Off from the Start menu ends the session on the server.
  const before = await page.evaluate(() => localStorage.getItem('pht:token'));
  await page.click('.start-btn');
  await page.click('.menu-logoff');
  await page.waitForSelector('.dialog');
  check('Log Off asks first', (await dialogTitle(page)) === 'Log Off PHT');
  await page.click('.dialog button.default');
  await page.waitForSelector('.login-window');
  check('Log Off returns to Login and clears the token', (await page.evaluate(() => localStorage.getItem('pht:token'))) === null);
  const replay = await fetch(`${API}/today`, { headers: { Authorization: `Bearer ${before}` } });
  check('the logged-off token is refused by the server (session ended)', replay.status === 401 && (await replay.json()).error === 'session ended');
  check('the API token is unaffected by Log Off', (await viaToken('GET', `/today?date=${today}`)).status === 200);
  await context.close();
}

// ─────────────────── npm run dev + dev:fake (the local preview) ───────────────────
{
  const { context, page } = await newContext({ width: 1280, height: 800 }, false);
  await page.goto(DEV + '/', { waitUntil: 'networkidle' });
  check('dev server: /api is proxied same-origin to dev:fake', (await page.request.get(DEV + '/api/health')).status() === 200);
  await login(page, DEV);
  check('dev server: log in and the desktop renders', (await page.locator('.strip').count()) >= 6 && (await page.locator('.win').count()) === 5);
  await context.close();
}

// ─────────────── AI Wire ───────────────
// The window, Read (a new tab, noopener, marked read), Skip until the wire
// runs dry, the past list, "No signal today", and the phone. Article links
// point at invented .test hosts; a click there is answered here, so nothing
// leaves the machine.
{
  const { context, page } = await newContext({ width: 1920, height: 1080 }, false);
  await context.route(/^https?:\/\/[^/]*\.test(\/|$)/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>article</title><p>article</p>' }));
  await login(page);
  await settled(page);
  await waitFor(page, () => !!document.querySelector('.wire-title')?.textContent, 'wire title');
  const api = (await viaToken('GET', `/article?date=${TODAY}`)).body;
  const stamp = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${iso}T00:00:00Z`)).toUpperCase();
  check('AI Wire: a window on the grid and a taskbar button', (await page.locator('#win-wire.win[role=region]').count()) === 1 && (await page.locator('.task-wire').textContent()) === 'AI Wire');
  check(
    "AI Wire: today's article from the API — source and date, title, excerpt",
    api.status === 'ok' &&
      (await page.locator('#title-wire').textContent()) === `AI Wire — ${stamp(TODAY)}` &&
      (await page.locator('.wire-title').textContent()) === api.article.title &&
      (await page.locator('.wire-meta').textContent()) === `${api.article.source.toUpperCase()} · ${stamp(api.article.publishedAt.slice(0, 10))}` &&
      (await page.locator('.wire-excerpt').textContent()) === api.article.excerpt &&
      api.article.excerpt.length <= 400,
    JSON.stringify(api.article),
  );
  check(
    'AI Wire: the main topic as a tag line above the source',
    api.article.topics.length > 0 &&
      (await page.locator('.wire-tag').textContent()) === api.article.topics[0].toUpperCase() &&
      (await page.locator('.wire-tag').isVisible()) &&
      (await page.locator('.wire-story > *').first().getAttribute('class')) === 'wire-tag',
    `${await page.locator('.wire-tag').textContent()} ${JSON.stringify(api.article.topics)}`,
  );
  const look = await page.evaluate(() => {
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      font: cs('.wire-paper').fontFamily,
      holes: cs('.wire-paper').backgroundImage,
      perf: getComputedStyle(document.querySelector('.wire-paper'), '::before').borderLeftStyle,
    };
  });
  check('teletype paper: monospace, tractor-feed holes down both sides, perforation lines', /Courier|Mono|monospace/.test(look.font) && (look.holes.match(/radial-gradient/g) || []).length === 2 && look.perf === 'dashed', JSON.stringify(look));
  const readLink = page.locator('.wire-read');
  check(
    'Read is a link to the article: new tab, rel="noopener noreferrer"',
    (await readLink.getAttribute('href')) === api.article.url && (await readLink.getAttribute('target')) === '_blank' && (await readLink.getAttribute('rel')) === 'noopener noreferrer',
    `${await readLink.getAttribute('href')} ${await readLink.getAttribute('rel')}`,
  );
  // The past list: the seven days before today, read ones ticked.
  const past = await page.locator('.wire-past-item').evaluateAll((els) => els.map((e) => [e.dataset.date, e.dataset.read, e.querySelector('.wire-tick').textContent, e.querySelector('a').getAttribute('rel'), e.querySelector('a').getAttribute('target')]));
  check(
    'past articles: the last 7 days, newest first, read ones ticked, links noopener',
    past.length === 7 && past.every(([d, r, t, rel, tg], i) => d === addDays(TODAY, -(i + 1)) && r === String(api.past[i].read) && t === (api.past[i].read ? '✓' : '·') && rel === 'noopener noreferrer' && tg === '_blank') && api.past.some((p) => p.read) && api.past.some((p) => !p.read),
    JSON.stringify(past),
  );
  await shot(page, 'desktop-wire', { clip: await box(page, '#win-wire') });

  // Read: a new tab on the article, which cannot reach back (noopener), and
  // the article is marked read for every device.
  const [tab] = await Promise.all([context.waitForEvent('page'), readLink.click()]);
  await tab.waitForLoadState('domcontentloaded').catch(() => null);
  const opener = await tab.evaluate(() => window.opener === null).catch(() => null);
  check('Read opens the article in a new tab, with no opener', tab.url() === api.article.url && opener === true, `${tab.url()} opener null: ${opener}`);
  await tab.close();
  await waitFor(page, () => /✓/.test(document.querySelector('.wire-read')?.textContent || ''), 'read tick');
  check('…and marks it read (Read ✓, and in the API)', (await readLink.textContent()) === 'Read ✓' && (await viaToken('GET', `/article?date=${TODAY}`)).body.article.read === true);

  // Next ▸: the next best each time, never one seen before; "N more in
  // queue" counts down with the API, and at 0 the button is disabled. `]`
  // with focus in the window presses it.
  check(
    'Next ▸ with "N more in queue" beside it, as the API counts it',
    (await page.locator('.wire-next').textContent()) === 'Next ▸' && (await page.locator('.wire-queue').textContent()) === `${api.queue} more in queue` && api.queue >= 2,
    `${await page.locator('.wire-queue').textContent()} vs ${api.queue}`,
  );
  const seen = [api.article.title];
  const queues = [];
  let byKey = 0;
  for (let i = 0; i < 12; i += 1) {
    if (await page.locator('.wire-next').isDisabled()) break;
    const before = await page.locator('.wire-title').textContent();
    if (i === 1) {
      await page.locator('#win-wire').focus();
      await page.keyboard.press(']');
    } else {
      await page.click('.wire-next');
    }
    const moved = await waitFor(page, (b) => document.querySelector('.wire-title')?.textContent !== b, 'next', before);
    if (i === 1 && moved) byKey += 1;
    seen.push(await page.locator('.wire-title').textContent());
    queues.push(await page.locator('.wire-queue').textContent());
  }
  const now = (await viaToken('GET', `/article?date=${TODAY}`)).body;
  check('Next brings the next best, never a repeat, and the API agrees', seen.length >= 3 && new Set(seen).size === seen.length && now.article.title === seen[seen.length - 1] && now.article.read === false && now.queue === 0, seen.join(' | '));
  check('"N more in queue" counts down to 0 with each Next', queues.join('|') === queues.map((_, i) => `${queues.length - 1 - i} more in queue`).join('|'), queues.join(' | '));
  check('] with focus in the Wire window pressed Next (and the deck stayed on today)', byKey === 1 && new URL(page.url()).pathname === '/' && /^TODAY /.test(await lcd(page)));
  check(
    'at 0 Next is disabled, the last article stays, no dialog',
    (await page.locator('.wire-next').isDisabled()) && (await page.locator('.wire-title').textContent()) === now.article.title && !(await page.locator('.dialog').count()),
  );
  {
    const asked = [];
    page.on('request', (rq) => rq.url().includes('/article/skip') && asked.push(rq.url()));
    await page.locator('.wire-next').click({ force: true }).catch(() => null);
    await page.locator('#win-wire').focus();
    await page.keyboard.press(']');
    await sleep(300);
    check('…and neither a click nor ] sends anything at 0', asked.length === 0, asked.join(' '));
  }
  await shot(page, 'desktop-wire-queue-empty', { clip: await box(page, '#win-wire') });

  // No signal: every source failed and nothing cached.
  await page.route('**/api/article?*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ date: TODAY, status: 'no-signal', article: null, queue: 0, past: [] }) }));
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await waitFor(page, () => document.querySelector('.wire-msg')?.dataset.state === 'no-signal', 'no signal');
  {
    const ns = {
      msg: await page.locator('.wire-msg').textContent(),
      story: await page.locator('.wire-story').isVisible(),
      skip: await page.locator('.wire-skip').isVisible(),
      dialogs: await page.locator('.dialog').count(),
      title: await page.locator('#title-wire').textContent(),
    };
    check('"No signal today" in the window, the story and its buttons hidden, no dialog', ns.msg === 'NO SIGNAL TODAY' && !ns.story && !ns.skip && ns.dialogs === 0 && ns.title === 'AI Wire', JSON.stringify(ns));
  }
  await shot(page, 'desktop-wire-no-signal', { clip: await box(page, '#win-wire') });
  await page.unroute('**/api/article?*');
  await page.route('**/api/article?*', (r) => r.fulfill({ status: 502, body: '' }));
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await waitFor(page, () => document.querySelector('.wire-msg')?.dataset.state === 'offline', 'offline');
  check("PHT unreachable: CAN'T REACH PHT in the window, never a dialog", (await page.locator('.wire-msg').textContent()) === "CAN'T REACH PHT" && !(await page.locator('.dialog').count()));
  await page.unroute('**/api/article?*');
  await context.close();

  // The phone: AI Wire stacks last, full width, nothing sideways.
  const phone = await newContext({ width: 390, height: 844 }, true);
  await phone.context.route(/^https?:\/\/[^/]*\.test(\/|$)/, (r) => r.fulfill({ status: 200, body: 'article' }));
  await login(phone.page);
  await settled(phone.page);
  await waitFor(phone.page, () => !!document.querySelector('.wire-title')?.textContent, 'wire title (phone)');
  const order = await phone.page.locator('.desk .win').evaluateAll((els) => els.map((e) => [e.id, Math.round(e.getBoundingClientRect().top), Math.round(e.getBoundingClientRect().width)]));
  const sideways = await phone.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('phone: Learned stacks after History, AI Wire last, full width, the page never scrolls sideways', order.map((o) => o[0]).join() === 'win-today,win-history,win-learned,win-weather,win-wire' && order.every((o, i) => i === 0 || o[1] > order[i - 1][1]) && order[4][2] >= 370 && order[2][2] >= 370 && !sideways, JSON.stringify(order));
  {
    const a = await box(phone.page, '.jcard-a');
    const b = await box(phone.page, '.jcard-b');
    check('phone: SIDE B shows under SIDE A', b.y >= a.y + a.height - 1 && near(a.width, b.width), `${J(a)} ${J(b)}`);
  }
  await phone.page.locator('#win-learned').scrollIntoViewIfNeeded();
  await shot(phone.page, 'phone-learned', { clip: await box(phone.page, '#win-learned') });
  await phone.page.locator('#win-wire').scrollIntoViewIfNeeded();
  await shot(phone.page, 'phone-wire', { clip: await box(phone.page, '#win-wire') });
  await phone.context.close();
}

// ─────────────── Learned ───────────────
// Every SIDE B entry newest first on the lined paper: the count, the month
// line, More…, search, an entry opening its day in Today, an older one
// read-only. dev:fake seeds 55 entries reaching back 70 days.
{
  const { context, page } = await newContext({ width: 1920, height: 1080 }, false);
  await login(page);
  await settled(page);
  // A tall Learned window beside Today, for the walkthrough and its picture.
  await page.evaluate((v) => localStorage.setItem('pht:grid', v), J({
    rects: { today: [0, 0, 4, 10], learned: [4, 0, 4, 10], history: [8, 0, 4, 10], weather: [8, 0, 4, 5], wire: [8, 5, 4, 5] },
    minimized: ['weather', 'wire'],
  }));
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
  await settle(page);
  await waitFor(page, () => document.querySelectorAll('.learned-list li[data-date]').length > 0, 'learned list');
  const all = (await viaToken('GET', '/learned?limit=200')).body;
  const monthStart = `${TODAY.slice(0, 8)}01`;
  const month = (await viaToken('GET', `/learned?from=${monthStart}&to=${TODAY}&limit=1`)).body.total;
  const shown = () => page.locator('.learned-list li[data-date]').evaluateAll((els) => els.map((e) => e.dataset.date));
  check('Learned: a window on the grid and a taskbar button', (await page.locator('#win-learned.win[role=region]').count()) === 1 && (await page.locator('.task-learned').textContent()) === 'Learned');
  check(
    'the total, and "Learned something N days this month", as the API counts them',
    (await page.locator('.learned-count').textContent()) === `${all.total} entries` && (await page.locator('.learned-month').textContent()) === `Learned something ${month} ${month === 1 ? 'day' : 'days'} this month` && all.total > 50,
    `${await page.locator('.learned-count').textContent()} / ${all.total}; ${await page.locator('.learned-month').textContent()} / ${month}`,
  );
  const first = await shown();
  check('the first 50, newest first, date + text on the lined paper', J(first) === J(all.entries.slice(0, 50).map((e) => e.date)) && (await page.locator('.learned-paper').evaluate((e) => getComputedStyle(e).backgroundImage.includes('repeating-linear-gradient'))), `${first.length} shown`);
  check(
    '…each one its text',
    (await page.locator('.learned-list li[data-date] .note-line').first().textContent()) === all.entries[0].text,
  );
  await page.click('.learned-more');
  await waitFor(page, (n) => document.querySelectorAll('.learned-list li[data-date]').length === n, 'more', all.total);
  check('More… brings the rest, then goes away', J(await shown()) === J(all.entries.map((e) => e.date)) && !(await page.locator('.learned-more').isVisible()));

  // Search: case-insensitive, the count says how many were found.
  const found = (await viaToken('GET', '/learned?q=octopus&limit=200')).body;
  await page.fill('.learned-search', 'OCTOPUS');
  await waitFor(page, (t) => document.querySelector('.learned-count')?.textContent === t, 'search count', `${found.total} found`);
  const texts = await page.locator('.learned-list li[data-date] .note-line').allTextContents();
  check(
    'search: every match and only matches, case-insensitive, counted; the title says so',
    found.total > 1 && texts.length === found.total && texts.every((t) => /octopus/i.test(t)) && (await page.locator('#title-learned').textContent()) === `Learned — ${found.total} found`,
    `${texts.length} vs ${found.total}`,
  );
  await page.fill('.learned-search', 'zzzz no such thing');
  await waitFor(page, () => document.querySelector('.learned-count')?.textContent === '0 found', 'no match');
  check('a search with no match says so', (await page.locator('.learned-list .empty').textContent()) === 'Nothing learned matches "zzzz no such thing".');
  await page.fill('.learned-search', '');
  await waitFor(page, (t) => document.querySelector('.learned-count')?.textContent === t, 'cleared', `${all.total} entries`);
  check('clearing the search brings the full list back', (await page.locator('#title-learned').textContent()) === 'Learned');

  // An entry in the window opens its day in Today; an older one is read-only.
  const inside = addDays(TODAY, -3);
  const older = addDays(TODAY, -41);
  const insideText = all.entries.find((e) => e.date === inside)?.text;
  await page.click(`.learned-list li[data-date="${inside}"] button.learned-entry`);
  check(
    'clicking an entry in the last 30 days opens that day in Today (amber, /day/, SIDE B showing it)',
    (await waitFor(page, (d) => location.pathname === `/day/${d}` && !!document.querySelector('.deck.editing'), 'day from learned', inside)) && (await page.inputValue('.learned-input')) === insideText,
    `${page.url()} "${await page.inputValue('.learned-input')}"`,
  );
  const ro = page.locator(`.learned-list li[data-date="${older}"]`);
  await ro.scrollIntoViewIfNeeded();
  const url = page.url();
  await ro.click();
  await sleep(300);
  check(
    'an entry older than 30 days is read-only: no button, and a click opens nothing',
    (await ro.getAttribute('class'))?.includes('read-only') && (await ro.locator('button').count()) === 0 && page.url() === url,
  );
  await page.click('.back-today');
  await waitFor(page, () => location.pathname === '/', 'back to today');
  await page.locator('.learned-paper').evaluate((e) => (e.scrollTop = 0));
  await shot(page, 'desktop-learned', { clip: await box(page, '#win-learned') });
  await context.close();
}

// ─────────────── ?debug=drag: the Drag log ───────────────
{
  const { context, page } = await newContext({ width: 1600, height: 900 }, false);
  if (!FIREFOX) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await login(page);
  await settled(page);
  // The drags below are on three columns, AI Wire and Learned minimized.
  await page.evaluate(() =>
    localStorage.setItem(
      'pht:grid',
      JSON.stringify({ rects: { today: [0, 0, 4, 10], history: [4, 0, 4, 10], learned: [0, 7, 4, 3], weather: [8, 0, 4, 10], wire: [8, 5, 4, 5] }, minimized: ['wire', 'learned'] }),
    ),
  );
  check('without ?debug=drag there is no drag log', !(await page.locator('.drag-log').count()));
  await page.goto(`${BASE}/?debug=drag`, { waitUntil: 'networkidle' });
  await ready(page);
  await idle(page);
  check('?debug=drag opens the Drag log window', await page.locator('.drag-log').isVisible());
  const head = await page.locator('.drag-log-head').textContent();
  check('its header: user agent, devicePixelRatio, viewport, the layout JSON', /userAgent: Mozilla/.test(head) && /devicePixelRatio: \d/.test(head) && /viewport: 1600x900/.test(head) && /layout: \{"rects":/.test(head), head);

  const requests = [];
  const onReq = (r) => requests.push(r.url());
  page.on('request', onReq);
  // The drags themselves save the layout (pht:grid); the log adds nothing.
  const keys = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k !== 'pht:grid').sort().join(','));
  const keysBefore = await keys();
  const at = async (sel) => page.locator(sel).boundingBox();
  // On Three columns: Weather's bottom edge up 4 cells (free space below it),
  // Weather moved into that space, a bad drop, a swap, and Today's east edge
  // pulled into History (clamped).
  const desk = await at('.desk');
  const cw = (desk.width - 10) / 12;
  const ch = (desk.height - 10) / 10;
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
    await sleep(100);
    await settle(page);
  };
  const mid = async (sel) => {
    const b = await at(sel);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  let p = await mid('#win-weather .rh-s');
  await drag(p, { x: p.x, y: p.y - 4 * ch });
  let bar = await at('#win-weather .title-bar');
  await drag({ x: bar.x + 40, y: bar.y + 10 }, { x: bar.x + 40, y: bar.y + 10 + 4 * ch });
  bar = await at('#win-weather .title-bar');
  await drag({ x: bar.x + bar.width - 50, y: bar.y + 10 }, { x: desk.x + 10 + 10.5 * cw, y: desk.y + 10 + 1.5 * ch });
  bar = await at('#win-today .title-bar');
  await drag({ x: bar.x + 40, y: bar.y + 10 }, { x: desk.x + 6 * cw, y: desk.y + 5 * ch });
  p = await mid('#win-history .rh-e');
  await drag(p, { x: p.x + 2 * cw, y: p.y });
  await sleep(200);
  page.off('request', onReq);
  const log = await page.locator('.drag-log-lines').textContent();
  const has = (re) => re.test(log);
  check(
    'the log has each event with its target, buttons, pointer type, coordinates and prevented',
    has(/pointerdown +div\.title-bar(-text)?.* in #win-weather +button=0 buttons=1 x=[\d.]+ y=[\d.]+ +id=\d+ type=mouse primary=true +prevented=true/) &&
      has(/pointerup /) && has(/data-role=title-bar/) && has(/data-role=resize-s/) && has(/data-role=resize-e/),
    log.split('\n').filter((l) => /pointerdown|pointerup/.test(l)).join(' | ').slice(0, 900),
  );
  check(
    '…and what the grid decided: start, landing rect, swap target, bad drop, clamp, and each end with its result',
    has(/>> resize s weather start at \d+,\d+ \(pointer \d+ mouse\), rect \[8,0,4,10\]/) &&
      has(/>> resize s weather end: pointerup, resized to \[8,0,4,6\]/) &&
      has(/>> move weather: landing \[8,4,4,6\] free/) &&
      has(/>> move weather end: pointerup, moved to \[8,4,4,6\]/) &&
      has(/>> move weather: landing \[\d+,\d+,4,6\]: bad drop, taken by history/) &&
      has(/>> move weather end: pointerup, bad drop: reverted/) &&
      has(/>> move today: landing \[4,0,4,10\]: swap with history/) &&
      has(/>> move today end: pointerup, swapped with history/) &&
      has(/>> resize e history: rect \[0,0,4,10\] \(wanted \[0,0,6,10\], clamped by today\)/),
    log.split('\n').filter((l) => l.includes('>>')).join(' | '),
  );
  const moves = log.split('\n').filter((l) => /pointermove/.test(l)).map((l) => Number(/\+\s*([\d.]+)ms/.exec(l)[1]));
  check('pointermove is throttled to one per 50ms', moves.length >= 2 && moves.every((t, i) => i === 0 || t - moves[i - 1] >= 49.5), moves.join(','));
  check('the drag log sends nothing and stores nothing', requests.length === 0 && (await keys()) === keysBefore, `${requests.join(' ')} | ${keysBefore} → ${await keys()}`);

  await page.click('.drag-log-copy');
  await sleep(300);
  const note = await page.locator('.drag-log-note').textContent();
  if (FIREFOX) {
    const fallback = (await page.locator('.drag-log-fallback').count()) ? await page.inputValue('.drag-log-fallback') : '';
    check('Copy log copies it (or selects it in a box to copy)', /^Copied \d+ lines/.test(note) || /^PHT drag log/.test(fallback), note);
  } else {
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check('Copy log puts the header and every line on the clipboard', /^Copied \d+ lines/.test(note) && /^PHT drag log/.test(clip) && /userAgent:/.test(clip) && /pointerdown/.test(clip), note);
  }
  await page.click('.drag-log-clear');
  check('Clear empties it', (await page.locator('.drag-log-lines').textContent()).trim().split('\n').length === 1);
  await page.locator('.brand-name').click();
  await page.keyboard.press('[');
  check('?debug=drag stays in the URL as the deck steps a day', await waitFor(page, () => /^\/day\//.test(location.pathname) && location.search === '?debug=drag', 'query kept'));
  await page.keyboard.press(']');
  await page.evaluate(() => localStorage.removeItem('pht:grid'));
  await context.close();
}

// ─────────────── CSP: nothing reported, then prove the collector works ───────────────
{
  const { context, page } = await newContext({ width: 1280, height: 800 }, false);
  await login(page);
  await settled(page);
  const before = csp.length;
  check('no CSP violations anywhere in the run', before === 0, csp.join(' | '));
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true';
    document.head.append(s);
    const d = document.createElement('div');
    d.setAttribute('style', 'color: red');
    document.body.append(d);
  });
  await sleep(500);
  check('probe: inline script was blocked', !(await page.evaluate(() => window.__inlineRan)));
  check('probe: the violation was reported (the collector works)', csp.length > before, `${csp.length - before} new`);
  await context.close();
}

await browser.close();

check('no request left 127.0.0.1', blocked.length === 0, blocked.join(' '));
// Expected noise: the browser logs each deliberate 500/502/503, aborted request,
// the 401s from the wrong password, wrong answer and bad token, and the 409
// from skipping when the AI Wire has nothing left.
const unexpected = problems.filter(
  (p) =>
    !/status of (500|502|503|401|409)|ERR_CONNECTION_REFUSED|net::ERR_FAILED/.test(p) &&
    !/Content.Security.Policy|Refused to/.test(p),
);
check('no unexpected console errors or page errors', unexpected.length === 0, unexpected.join(' | '));

console.log('\nscreenshots:');
for (const s of shots) console.log(`  ${s}`);
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
