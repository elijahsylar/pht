// The snap grid, in Chrome and Firefox, at zoom 1.0 and 1.2 (a 1920px screen
// zoomed to 120% leaves a 1600px viewport at device scale 1.2). Run by
// `npm run ui:check` after ui_check.mjs, against the built page (with its CSP).
// Usage: node dev/grid_check.mjs <base-url> <screenshot-dir>
//
// Moving (free spot, swap, bad drop that reverts, Escape), resizing from each
// edge and corner, neighbor clamping and the 3 × 3 minimum, double-click
// fill, the presets in Start ▸ Layouts, persistence and the old keys' removal,
// minimize/restore along all four restore paths, Alt+arrows and
// Alt+Shift+arrows with what they announce, the Firefox protections (mousedown,
// dragstart, selectstart, blur, pointercancel), and every window's contents at
// 3 × 3, 4 × 10, 12 × 3 and full width with nothing clipped or scrolling
// sideways (AI Wire and Learned included). The move, resize and restore cases
// run on a three-window baseline with AI Wire and Learned minimized
// (`baseline`), so they are the prototype's; the five-window presets are
// checked on their own.
// Screenshots (Chrome, zoom 1.0) go to <screenshot-dir>/grid/.
import { chromium, firefox } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:4198';
const SHOTS = path.join(process.argv[3] || os.tmpdir(), 'grid');
const API_DIR = process.env.PHT_API_DIR || path.join(os.homedir(), 'projects/pht-api');
const credsSrc = fs.readFileSync(path.join(API_DIR, 'dev/credentials.ts'), 'utf8');
const cred = (name) => new RegExp(`export const ${name} = '([^']+)'`).exec(credsSrc)[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONLY = process.env.GRID_ONLY; // e.g. "chrome" or "firefox", for a quicker run

let failures = 0;
let tag = '';
const check = (label, cond, detail = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${tag}${label}${!cond && detail ? `  (${detail})` : ''}`);
};
const shots = [];
const J = JSON.stringify;
// Equal as data: object keys in any order (a layout's windows are keyed).
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const eq = (a, b) => J(canon(a)) === J(canon(b));

const BROWSERS = [
  ['chrome', () => chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })],
  ['firefox', () => firefox.launch({ headless: true })],
].filter(([n]) => !ONLY || n === ONLY);
const SCALES = [
  { name: 'zoom 1.0', viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
  { name: 'zoom 1.2', viewport: { width: 1600, height: 820 }, deviceScaleFactor: 1.2 },
];
const WINDOWS = ['today', 'history', 'learned', 'weather', 'wire'];
// The presets, AI Wire and Learned in each.
const PRESETS = {
  thirds: { today: [0, 0, 4, 7], learned: [0, 7, 4, 3], history: [4, 0, 4, 10], weather: [8, 0, 4, 5], wire: [8, 5, 4, 5] },
  wide: { today: [0, 0, 3, 7], learned: [0, 7, 3, 3], history: [3, 0, 6, 10], weather: [9, 0, 3, 5], wire: [9, 5, 3, 5] },
  stack: { today: [0, 0, 4, 7], history: [4, 0, 8, 7], weather: [0, 7, 4, 3], wire: [4, 7, 4, 3], learned: [8, 7, 4, 3] },
  quad: { today: [0, 0, 5, 6], history: [5, 0, 7, 6], weather: [0, 6, 4, 4], wire: [4, 6, 4, 4], learned: [8, 6, 4, 4] },
};
// The three-window baseline (AI Wire and Learned minimized) most cases start from.
const THIRDS = { today: [0, 0, 4, 10], history: [4, 0, 4, 10], weather: [8, 0, 4, 10] };
const PARKED = { wire: [8, 5, 4, 5], learned: [0, 7, 4, 3] };
const BASE3 = ['today', 'history', 'weather'];

// ── page helpers ─────────────────────────────────────────────────────────────
async function ready(page) {
  await page.waitForSelector('.strip', { state: 'attached' });
  await page.waitForSelector('.wx-day', { state: 'attached' });
  await sleep(350);
}
async function login(page) {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.fill('#login-user', cred('DEV_USERNAME'));
  await page.fill('#login-pass', cred('DEV_PASSWORD'));
  await page.click('.login-form button[type=submit]');
  await page.waitForSelector('#login-answer');
  await page.fill('#login-answer', cred('DEV_ANSWER'));
  await page.click('.login-form button[type=submit]');
  await ready(page);
}
// Each window's rect in cells, as placed (null when minimized): Today,
// History and Weather by default, every window with `all`.
const rects = (page, all = false) =>
  page.evaluate((names) =>
    Object.fromEntries(
      names.map((n) => {
        const el = document.getElementById(`win-${n}`);
        return [n, el.classList.contains('minimized') ? null : el.dataset.rect.split(',').map(Number)];
      }),
    ),
  all ? WINDOWS : BASE3);
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('pht:grid') || 'null'));
// Store a layout and reload. A window not given is parked minimized (AI
// Wire and Learned, unless a case is about them).
async function setGrid(page, r, minimized = []) {
  const parked = WINDOWS.filter((n) => !r[n]);
  const full = { ...Object.fromEntries(parked.map((n) => [n, PARKED[n] ?? PRESETS.thirds[n]])), ...r };
  await page.evaluate((v) => localStorage.setItem('pht:grid', v), J({ rects: full, minimized: [...new Set([...minimized, ...parked])] }));
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page);
}
const baseline = (page) => setGrid(page, THIRDS);
async function geo(page) {
  return page.evaluate(() => {
    const d = document.querySelector('.desk').getBoundingClientRect();
    return { left: d.left, top: d.top, cw: (d.width - 10) / 12, ch: (d.height - 10) / 10 };
  });
}
// The middle of cell (x, y), in page px.
const cellPt = (g, x, y) => ({ x: g.left + 10 + x * g.cw + (g.cw - 10) / 2, y: g.top + 10 + y * g.ch + (g.ch - 10) / 2 });
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
async function center(page, sel) {
  await settle(page);
  const b = await page.locator(sel).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
// A title bar, `fromRight` px in from its right end (else 40px from the left).
async function barPt(page, name, fromRight) {
  await settle(page);
  const b = await page.locator(`#win-${name} .title-bar`).boundingBox();
  return { x: fromRight ? b.x + b.width - fromRight : b.x + 40, y: b.y + b.height / 2 };
}
// Where the dotted outline is, in cells, and what it says.
const ghost = (page) =>
  page.evaluate(() => {
    const g = document.querySelector('.snap-ghost');
    const d = document.querySelector('.desk').getBoundingClientRect();
    const cw = (d.width - 10) / 12;
    const ch = (d.height - 10) / 10;
    const s = g.style;
    const px = (v) => parseFloat(v);
    return {
      shown: !g.hidden,
      kind: g.dataset.kind,
      msg: g.textContent,
      rect: [Math.round((px(s.left) - 10) / cw), Math.round((px(s.top) - 10) / ch), Math.round((px(s.width) + 10) / cw), Math.round((px(s.height) + 10) / ch)],
      lines: getComputedStyle(document.querySelector('.snap-lines')).opacity,
    };
  });
// Press at `from`, move to `to`, run `mid` while still held, release.
async function drag(page, from, to, mid) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await sleep(220);
  const seen = mid ? await mid() : null;
  await page.mouse.up();
  await sleep(220);
  return seen;
}
// Drag a window's resize handle by (dx, dy) cells, the pointer kept inside
// the viewport (synthetic moves past its edge are not what a real mouse sends).
async function resizeBy(page, name, dir, dx, dy) {
  const g = await geo(page);
  const p = await center(page, `#win-${name} .rh-${dir}`);
  const vp = page.viewportSize();
  const inside = (v, max) => Math.max(2, Math.min(max - 2, v));
  return drag(page, p, { x: inside(p.x + dx * g.cw, vp.width), y: inside(p.y + dy * g.ch, vp.height) });
}
async function startMenu(page, item) {
  await page.click('.start-btn');
  await page.click(`.menu-${item}`);
  await sleep(250);
}
async function preset(page, p) {
  await page.click('.start-btn');
  await page.click('.menu-layouts');
  await page.click(`.menu-preset-${p}`);
  await sleep(250);
}
const liveText = async (page) => {
  await sleep(120);
  return page.locator('#live').textContent();
};

// Everything inside a window's body: nothing sticks out sideways, nothing
// scrolls sideways, and anything not inside a scrolling box is fully inside
// the window. Returns the problems.
function overflowIn(name) {
  const win = document.getElementById(`win-${name}`);
  const body = win.querySelector('.win-body');
  const br = body.getBoundingClientRect();
  const desc = (el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`;
  const out = [];
  for (const el of body.querySelectorAll('*')) {
    if (el.closest('.status-bar')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) out.push(`${desc(el)} scrolls sideways`);
    let sc = el.parentElement;
    while (sc && sc !== body && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
    const box = sc && sc !== body ? sc.getBoundingClientRect() : br;
    if (r.left < box.left - 1 || r.right > box.right + 1) out.push(`${desc(el)} sticks out sideways (${Math.round(r.left)}–${Math.round(r.right)} vs ${Math.round(box.left)}–${Math.round(box.right)})`);
    if ((!sc || sc === body) && (r.top < br.top - 1 || r.bottom > br.bottom + 1)) out.push(`${desc(el)} clipped (${Math.round(r.top)}–${Math.round(r.bottom)} vs ${Math.round(br.top)}–${Math.round(br.bottom)})`);
  }
  if (document.documentElement.scrollWidth > window.innerWidth) out.push('the page scrolls sideways');
  return [...new Set(out)].slice(0, 6);
}

for (const [bname, launch] of BROWSERS) {
  let browser;
  try {
    browser = await launch();
  } catch (err) {
    tag = `${bname}: `;
    check('browser launches (npx playwright-core install firefox)', false, String(err.message).split('\n')[0]);
    continue;
  }
  for (const sc of SCALES) {
    tag = `${bname} ${browser.version()} ${sc.name}: `;
    const shoot = bname === 'chrome' && sc.deviceScaleFactor === 1;
    const shot = async (page, name) => {
      if (!shoot) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      const file = path.join(SHOTS, `${name}.png`);
      await page.screenshot({ path: file });
      shots.push(path.resolve(file));
    };
    const context = await browser.newContext({ viewport: sc.viewport, deviceScaleFactor: sc.deviceScaleFactor });
    await context.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
    const csp = [];
    await context.exposeBinding('__reportCsp', (_s, v) => csp.push(v));
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => window.__reportCsp(`${e.violatedDirective} ${e.blockedURI || 'inline'}`));
    });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await login(page);

    // ── first load: the old layout keys are removed, Three columns ──────────
    await page.evaluate(() => {
      localStorage.removeItem('pht:grid');
      localStorage.setItem('pht:layout', JSON.stringify({ cols: [{ w: 1, wins: ['weather', 'today'], h: [1, 1] }, { w: 2, wins: ['history'], h: [1] }], away: {} }));
      localStorage.setItem('pht:cols', '[0.2,0.5,0.3]');
      localStorage.setItem('pht:minimized', '["history"]');
    });
    await page.reload({ waitUntil: 'networkidle' });
    await ready(page);
    const oldKeys = await page.evaluate(() => ['pht:layout', 'pht:cols', 'pht:minimized'].filter((k) => localStorage.getItem(k) !== null));
    check('the old layout keys are ignored and removed; the first load is Three columns with AI Wire and Learned', oldKeys.length === 0 && eq(await rects(page, true), PRESETS.thirds), `${oldKeys} ${J(await rects(page, true))}`);
    // A four-window layout saved before Learned existed, with room left.
    const before = { today: [0, 0, 4, 10], history: [4, 0, 4, 10], weather: [8, 0, 4, 4], wire: [8, 4, 4, 3] };
    await page.evaluate((v) => localStorage.setItem('pht:grid', v), J({ rects: before, minimized: [] }));
    await page.reload({ waitUntil: 'networkidle' });
    await ready(page);
    check('a layout saved before Learned keeps its windows; Learned takes the free spot', eq(await rects(page, true), { ...before, learned: [8, 7, 4, 3] }), J(await rects(page, true)));
    // The four-window default from before Learned fills the grid.
    await page.evaluate((v) => localStorage.setItem('pht:grid', v), J({ rects: { today: [0, 0, 4, 10], history: [4, 0, 4, 10], weather: [8, 0, 4, 5], wire: [8, 5, 4, 5] }, minimized: [] }));
    await page.reload({ waitUntil: 'networkidle' });
    await ready(page);
    check('…a full one from before Learned becomes the default', eq(await rects(page, true), PRESETS.thirds), J(await rects(page, true)));
    await page.evaluate((v) => localStorage.setItem('pht:grid', v), J({ rects: THIRDS, minimized: [] }));
    await page.reload({ waitUntil: 'networkidle' });
    await ready(page);
    check('…and one with no room left becomes the default', eq(await rects(page, true), PRESETS.thirds), J(await rects(page, true)));
    await baseline(page);
    const tb = await page.locator('.taskbar').boundingBox();
    const wb = await page.locator('#win-today').boundingBox();
    check('the grid fills the desk above the taskbar with 10px gaps', Math.abs(wb.x - 10) <= 1 && Math.abs(wb.y - 10) <= 1 && Math.abs(tb.y - (wb.y + wb.height) - 10) <= 1.5, `${J(wb)} taskbar ${tb.y}`);
    check('grid lines hidden at rest', (await ghost(page)).lines === '0' && !(await ghost(page)).shown);
    const handles = await page.locator('#win-history .rh').evaluateAll((els) => els.map((e) => [e.dataset.dir, getComputedStyle(e).cursor]));
    check(
      'every edge and corner is a handle with its resize cursor, the size grip drawn bottom-right',
      eq(handles.map((x) => x[0]).sort(), ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']) &&
        handles.every(([d, c]) => c === { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' }[d]) &&
        (await page.locator('#win-history .rh-se.win-sizegrip').evaluate((e) => getComputedStyle(e).backgroundImage)).includes('gradient'),
      J(handles),
    );
    check('title bars show the move cursor', (await page.locator('#win-today .title-bar').evaluate((e) => getComputedStyle(e).cursor)) === 'move');

    // ── resize from the bottom edge, then move into the free spot ────────────
    let g = await geo(page);
    await resizeBy(page, 'weather', 's', 0, -5);
    check('dragging the bottom edge up 5 cells: Weather is 4 × 5', eq((await rects(page)).weather, [8, 0, 4, 5]), J(await rects(page)));
    {
      const from = await barPt(page, 'weather');
      const seen = await drag(page, from, { x: from.x, y: from.y + 5 * g.ch }, () => ghost(page));
      check('mid-move: grid lines show, the outline is on the free spot below', seen.shown && seen.lines === '1' && seen.kind === 'free' && eq(seen.rect, [8, 5, 4, 5]) && seen.msg === '', J(seen));
      check('released in a free spot: it snaps there', eq((await rects(page)).weather, [8, 5, 4, 5]), J(await rects(page)));
      check('…and the grid lines and outline are gone', !(await ghost(page)).shown && (await ghost(page)).lines === '0');
    }

    // ── bad drop: landing partly taken, pointer not over a window ───────────
    {
      // Grab Weather near the right end of its title bar and put the pointer
      // in the free cells above it: the window's landing spot overlaps History.
      const from = await barPt(page, 'weather', 50);
      const to = cellPt(g, 10, 1);
      const seen = await drag(page, from, to, async () => {
        const s = await ghost(page);
        if (s.kind === 'bad') await shot(page, 'grid-bad-drop-red');
        return s;
      });
      check('a taken spot with the pointer over no window: red outline and the prototype message', seen.kind === 'bad' && seen.msg === 'Spot taken: drop on a window to swap, or shrink one first', J(seen));
      check('…release reverts', eq((await rects(page)).weather, [8, 5, 4, 5]), J(await rects(page)));
    }

    // ── swap: pointer over another window ───────────────────────────────────
    {
      const from = await barPt(page, 'today');
      const to = cellPt(g, 6, 5);
      const seen = await drag(page, from, to, async () => {
        const s = await ghost(page);
        if (s.kind === 'swap') await shot(page, 'grid-swap-green');
        return s;
      });
      check('pointer over History: green outline on History, "Release to swap"', seen.kind === 'swap' && seen.msg === 'Release to swap' && eq(seen.rect, [4, 0, 4, 10]), J(seen));
      const r = await rects(page);
      check('…release swaps the two rects', eq(r.today, [4, 0, 4, 10]) && eq(r.history, [0, 0, 4, 10]), J(r));
      check('…and it is saved', eq((await stored(page)).rects, { ...r, ...PARKED }), J(await stored(page)));
    }

    // ── Escape cancels a move ───────────────────────────────────────────────
    {
      const from = await barPt(page, 'weather');
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x, from.y - 4 * g.ch, { steps: 8 });
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await sleep(200);
      check('Escape during a move puts it back', eq((await rects(page)).weather, [8, 5, 4, 5]), J(await rects(page)));
    }

    // ── every edge and corner, out one cell and back ────────────────────────
    {
      const MID = { today: [0, 0, 3, 3], history: [9, 7, 3, 3], weather: [4, 3, 4, 4] };
      await setGrid(page, MID);
      g = await geo(page);
      const out = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] };
      const grown = { n: [4, 2, 4, 5], s: [4, 3, 4, 5], e: [4, 3, 5, 4], w: [3, 3, 5, 4], ne: [4, 2, 5, 5], nw: [3, 2, 5, 5], se: [4, 3, 5, 5], sw: [3, 3, 5, 5] };
      for (const [dir, [dx, dy]] of Object.entries(out)) {
        await resizeBy(page, 'weather', dir, dx, dy);
        const a = (await rects(page)).weather;
        await resizeBy(page, 'weather', dir, -dx, -dy);
        const b = (await rects(page)).weather;
        check(`the ${dir} handle resizes by a cell, snapped, and back`, eq(a, grown[dir]) && eq(b, MID.weather), `${J(a)} then ${J(b)}`);
      }
    }

    // ── neighbor clamping and the 3 × 3 minimum ──────────────────────────────
    {
      await setGrid(page, { today: [0, 0, 3, 10], history: [4, 0, 4, 10], weather: [8, 0, 4, 10] });
      g = await geo(page);
      const p = await center(page, '#win-today .rh-e');
      const seen = await drag(page, p, { x: p.x + 3 * g.cw, y: p.y }, () => ghost(page));
      check('pulling Today\'s east edge 3 cells into History stops at History (outline too)', eq((await rects(page)).today, [0, 0, 4, 10]) && eq(seen.rect, [0, 0, 4, 10]), `${J(await rects(page))} outline ${J(seen.rect)}`);
      await resizeBy(page, 'today', 'se', 2, 1);
      check('a corner into a neighbor: clamped on that side only', eq((await rects(page)).today, [0, 0, 4, 10]), J(await rects(page)));
      await resizeBy(page, 'history', 'w', -2, 0);
      check('History\'s west edge stops at Today too', eq((await rects(page)).history, [4, 0, 4, 10]), J(await rects(page)));
      await resizeBy(page, 'today', 'e', -5, 0);
      check('dragging far in stops at 3 wide', eq((await rects(page)).today, [0, 0, 3, 10]), J(await rects(page)));
      await resizeBy(page, 'today', 'n', 0, 9);
      check('…and 3 tall', eq((await rects(page)).today, [0, 7, 3, 3]), J(await rects(page)));
      await resizeBy(page, 'today', 'n', 0, -1);
      check('from the minimum, one cell back out grows it one cell straight away', eq((await rects(page)).today, [0, 6, 3, 4]), J(await rects(page)));
    }

    // ── double-click fill ────────────────────────────────────────────────────
    {
      await setGrid(page, { today: [0, 0, 4, 10], history: [4, 0, 8, 3], weather: [8, 5, 4, 3] });
      await page.dblclick('#win-weather .title-bar-text');
      await sleep(200);
      check('double-click grows up to History and down to the bottom', eq((await rects(page)).weather, [8, 3, 4, 7]), J(await rects(page)));
      await page.click('#win-history .min-btn');
      await page.dblclick('#win-weather .title-bar-text');
      await sleep(200);
      check('…and with History minimized, the full height', eq((await rects(page)).weather, [8, 0, 4, 10]), J(await rects(page)));
    }

    // ── presets, persistence ─────────────────────────────────────────────────
    for (const p of ['wide', 'stack', 'quad', 'thirds']) {
      await preset(page, p);
      check(`Start ▸ Layouts ▸ ${p}: the prototype's rects with AI Wire and Learned, every window showing`, eq(await rects(page, true), PRESETS[p]), J(await rects(page, true)));
      const wb = await page.evaluate(overflowIn, 'wire');
      check(`…AI Wire fits in ${p}`, wb.length === 0, wb.join(' | '));
      const lb = await page.evaluate(overflowIn, 'learned');
      check(`…Learned fits in ${p}`, lb.length === 0, lb.join(' | '));
      await page.mouse.move(5, 5);
      await sleep(150);
      await shot(page, `grid-preset-${p}`);
    }
    await preset(page, 'quad');
    await page.reload({ waitUntil: 'networkidle' });
    await ready(page);
    check('the layout persists across a reload', eq(await rects(page, true), PRESETS.quad), J(await rects(page, true)));
    await startMenu(page, 'reset-layout');
    check('Reset layout is Three columns (AI Wire under Weather)', eq(await rects(page, true), PRESETS.thirds), J(await rects(page, true)));
    {
      // The submenu by keyboard: ArrowDown to Layouts, ArrowRight, Enter.
      await page.click('.start-btn');
      await page.focus('.menu-layouts');
      await page.keyboard.press('ArrowRight');
      const focused = await page.evaluate(() => document.activeElement?.dataset.preset);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await sleep(250);
      check('Layouts ▸ by keyboard: ArrowRight opens it, Enter applies', focused === 'thirds' && eq(await rects(page, true), PRESETS.wide) && /History wide/.test(await liveText(page)), `${focused} ${J(await rects(page, true))}`);
      await page.click('.task-wire');
      check('AI Wire minimizes from the taskbar like the others', (await rects(page, true)).wire === null && (await page.getAttribute('.task-wire', 'aria-pressed')) === 'false');
      await page.click('.task-wire');
      await sleep(150);
      check('…and comes back to its saved rect', eq((await rects(page, true)).wire, PRESETS.wide.wire), J(await rects(page, true)));
      await page.click('.task-learned');
      check('Learned minimizes from the taskbar like the others', (await rects(page, true)).learned === null && (await page.getAttribute('.task-learned', 'aria-pressed')) === 'false');
      await page.click('.task-learned');
      await sleep(150);
      check('…and comes back to its saved rect', eq((await rects(page, true)).learned, PRESETS.wide.learned), J(await rects(page, true)));
      await baseline(page);
    }

    // ── minimize and restore: the four paths ─────────────────────────────────
    g = await geo(page);
    {
      await page.click('.task-weather');
      check('a minimized window is hidden and its taskbar button up', (await rects(page)).weather === null && (await page.getAttribute('.task-weather', 'aria-pressed')) === 'false');
      await page.reload({ waitUntil: 'networkidle' });
      await ready(page);
      check('minimized persists across a reload', (await rects(page)).weather === null);
      await page.click('.task-weather');
      await sleep(150);
      check('restore 1: its saved rect, still free', eq((await rects(page)).weather, [8, 0, 4, 10]));
    }
    {
      await page.click('.task-weather');
      const from = await barPt(page, 'today');
      await drag(page, from, { x: from.x + 8 * g.cw, y: from.y });
      check('a minimized window frees its cells: Today moves into them', eq((await rects(page)).today, [8, 0, 4, 10]), J(await rects(page)));
      await page.click('.task-weather');
      await sleep(150);
      check('…restored, it takes the free 4 × 10 spot', eq((await rects(page)).weather, [0, 0, 4, 10]), J(await rects(page)));
      // Saved spot taken; free: a 3 × 5 spot and an 8 × 5 one. Same size wins
      // (top-left first) over the largest free rect.
      await setGrid(page, { today: [0, 0, 4, 10], history: [4, 0, 5, 5], weather: [8, 0, 4, 5] }, ['weather']);
      await page.click('.task-weather');
      await sleep(150);
      check('restore 2: saved rect taken, the first free spot of the same size (not the largest)', eq((await rects(page)).weather, [4, 5, 4, 5]), J(await rects(page)));
      await baseline(page);
    }
    {
      await page.click('.task-weather');
      await resizeBy(page, 'history', 'e', 1, 0);
      await page.click('.task-weather');
      await sleep(150);
      check('restore 3: no 4 × 10 spot, the largest free rect (3 × 10)', eq((await rects(page)).weather, [9, 0, 3, 10]) && eq((await rects(page)).history, [4, 0, 5, 10]), J(await rects(page)));
      await baseline(page);
    }
    {
      await page.click('.task-weather');
      await resizeBy(page, 'history', 'e', 2, 0);
      check('(History now covers all but 2 columns)', eq((await rects(page)).history, [4, 0, 6, 10]), J(await rects(page)));
      await page.click('.task-weather');
      await sleep(150);
      check('restore 4: nothing 3 × 3 free, so Three columns (AI Wire and Learned stay minimized)', eq(await rects(page, true), { ...PRESETS.thirds, wire: null, learned: null }), J(await rects(page, true)));
      await baseline(page);
    }

    // ── keyboard: Alt+arrows, Alt+Shift+arrows, Enter ────────────────────────
    {
      const url = page.url();
      await page.focus('#win-weather .title-bar');
      await page.keyboard.press('Alt+ArrowLeft');
      await sleep(150);
      let r = await rects(page);
      check('Alt+Left bumps into History: they swap, and it is announced', eq(r.weather, [4, 0, 4, 10]) && eq(r.history, [8, 0, 4, 10]) && (await liveText(page)) === 'Weather swapped places with History.', `${J(r)} "${await liveText(page)}"`);
      await page.keyboard.press('Alt+Shift+ArrowUp');
      await sleep(150);
      check('Alt+Shift+Up: one cell shorter, announced', eq((await rects(page)).weather, [4, 0, 4, 9]) && (await liveText(page)) === 'Weather is 4 by 9 cells.', `${J(await rects(page))} "${await liveText(page)}"`);
      await page.keyboard.press('Alt+ArrowDown');
      await sleep(150);
      check('Alt+Down into free space: moves one cell, announced', eq((await rects(page)).weather, [4, 1, 4, 9]) && (await liveText(page)) === 'Weather moved to column 5, row 2.', `${J(await rects(page))} "${await liveText(page)}"`);
      await page.keyboard.press('Alt+Shift+ArrowRight');
      await sleep(150);
      check('Alt+Shift+Right into History: clamped, nothing changes, announced', eq((await rects(page)).weather, [4, 1, 4, 9]) && /can't be resized/.test(await liveText(page)), `"${await liveText(page)}"`);
      await page.keyboard.press('Alt+ArrowDown');
      await sleep(150);
      check('Alt+Down at the bottom edge: stays, announced', eq((await rects(page)).weather, [4, 1, 4, 9]) && /can't move down/.test(await liveText(page)), `"${await liveText(page)}"`);
      await page.keyboard.press('Enter');
      await sleep(150);
      check('Enter fills vertically, announced', eq((await rects(page)).weather, [4, 0, 4, 10]) && /fills the free space/.test(await liveText(page)), `"${await liveText(page)}"`);
      check('focus stays on the title bar; no navigation (Alt+arrows are not Back/Forward)', (await page.evaluate(() => document.activeElement?.closest('.win')?.id)) === 'win-weather' && page.url() === url);
      await baseline(page);
    }

    // ── Firefox protections ──────────────────────────────────────────────────
    {
      const prevented = await page.evaluate(() => {
        const fire = (el, type) => !el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
        const bar = document.querySelector('#win-today .title-bar-text');
        const h = document.querySelector('#win-today .rh-se');
        const ds = new DragEvent('dragstart', { bubbles: true, cancelable: true });
        return { barDown: fire(bar, 'mousedown'), handleDown: fire(h, 'mousedown'), dragstart: !bar.dispatchEvent(ds) };
      });
      check('title bars and handles cancel mousedown and dragstart', prevented.barDown && prevented.handleDown && prevented.dragstart, J(prevented));
      const from = await barPt(page, 'weather');
      await page.evaluate(() => {
        window.__pid = null;
        document.addEventListener('pointerdown', (e) => (window.__pid = e.pointerId), { once: true, capture: true });
      });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x - 30, from.y + 20, { steps: 8 });
      const during = await page.evaluate(() => ({
        selectstart: !document.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true })),
        selected: window.getSelection().toString(),
        snapping: document.getElementById('desktop').classList.contains('snapping'),
      }));
      await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: window.__pid })));
      await sleep(100);
      const after = await page.evaluate(() => document.getElementById('desktop').classList.contains('snapping'));
      await page.mouse.up();
      check('during a drag selectstart is cancelled and nothing is selected', during.snapping && during.selectstart && during.selected === '', J(during));
      check('pointercancel ends the drag (as the prototype does: the landing is kept)', !after && eq((await rects(page)).weather, [8, 0, 4, 10]) && !(await ghost(page)).shown, J(await rects(page)));
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x, from.y + 30, { steps: 4 });
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await sleep(100);
      const blurEnded = !(await page.evaluate(() => document.getElementById('desktop').classList.contains('snapping')));
      await page.mouse.up();
      check('a window blur ends the drag', blurEnded && !(await ghost(page)).shown);
      await page.evaluate(() => document.addEventListener('pointerdown', (e) => (window.__pid = e.pointerId), { once: true, capture: true }));
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x, from.y + 30, { steps: 4 });
      await page.evaluate(() =>
        document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: window.__pid, pointerType: 'mouse', buttons: 0, clientX: 10, clientY: 10 })),
      );
      await sleep(100);
      const noButtonEnded = !(await page.evaluate(() => document.getElementById('desktop').classList.contains('snapping')));
      await page.mouse.up();
      check('a mouse move with no button down (released outside the page) ends the drag', noButtonEnded && !(await ghost(page)).shown);
      await baseline(page);
    }

    // ── contents at 3 × 3, 4 × 10, 12 × 3 and full width ─────────────────────
    {
      const SIZES = {
        '3x3': (n, o) => ({ [n]: [0, 0, 3, 3], [o[0]]: [3, 0, 4, 10], [o[1]]: [7, 0, 5, 10] }),
        '4x10': (n, o) => ({ [n]: [0, 0, 4, 10], [o[0]]: [4, 0, 4, 10], [o[1]]: [8, 0, 4, 10] }),
        '12x3': (n, o) => ({ [n]: [0, 0, 12, 3], [o[0]]: [0, 3, 6, 7], [o[1]]: [6, 3, 6, 7] }),
        full: (n, o) => ({ [n]: [0, 0, 12, 10], [o[0]]: [0, 0, 4, 10], [o[1]]: [4, 0, 4, 10] }),
      };
      for (const n of WINDOWS) {
        // Two others share the grid; the rest are parked minimized.
        const others = WINDOWS.filter((x) => x !== n).slice(0, 2);
        for (const [size, make] of Object.entries(SIZES)) {
          await setGrid(page, make(n, others), size === 'full' ? others : []);
          await sleep(150);
          const bad = await page.evaluate(overflowIn, n);
          const hgt = (await page.locator(`#win-${n}`).boundingBox()).height;
          let extra = '';
          let ok = bad.length === 0;
          if (n === 'today') {
            const leds = await page.locator('.strip[data-slug="stretch"] .meter .led').count();
            const compact = await page.locator('.deck.compact').count();
            const want = hgt < 600 || size === '3x3' ? 7 : 14;
            ok = ok && leds === want && compact === (hgt < 600 ? 1 : 0);
            extra = `${leds} LEDs, compact ${compact}, ${Math.round(hgt)}px`;
            if (size === '3x3') {
              const sc = await page.locator('.strips').evaluate((e) => e.scrollHeight > e.clientHeight && getComputedStyle(e).overflowY === 'auto');
              ok = ok && sc;
              extra += `, strips scroll ${sc}`;
            }
          } else if (n === 'history') {
            const cols = await page.locator('.win-history .mrow[data-slug="stretch"] .led').count();
            const title = await page.locator('#title-history').textContent();
            const days = Number(/last (\d+) days/.exec(title)?.[1]);
            ok = ok && (days === 30 ? cols === 32 : cols === days) && (size === 'full' || size === '4x10' ? days === 30 : true);
            extra = `${cols} columns, "${title}"`;
          } else if (n === 'wire') {
            // The story always shows with its buttons in view; the past list
            // only in a tall window; a short one clips the excerpt.
            const w = await page.evaluate(() => {
              const feed = document.querySelector('.wire-feed').getBoundingClientRect();
              const inView = (sel) => {
                const r = document.querySelector(sel).getBoundingClientRect();
                return r.height > 0 && r.top >= feed.top - 1 && r.bottom <= feed.bottom + 1;
              };
              const past = document.querySelector('.wire-past');
              return {
                title: inView('.wire-title'),
                read: inView('.wire-read'),
                skip: inView('.wire-skip'),
                past: getComputedStyle(past).display !== 'none',
                clipped: document.querySelector('.wire-paper').classList.contains('clip-excerpt'),
              };
            });
            const tall = hgt >= 400;
            ok = ok && w.title && w.read && w.skip && w.past === tall && w.clipped === hgt < 340;
            extra = `${Math.round(hgt)}px, ${J(w)}`;
          } else if (n === 'learned') {
            // The search and the count always in view; the month line only
            // in a window 230px or taller; the paper holding the list.
            const l = await page.evaluate(() => {
              const body = document.querySelector('#win-learned .win-body').getBoundingClientRect();
              const inView = (sel) => {
                const r = document.querySelector(sel).getBoundingClientRect();
                return r.height > 0 && r.top >= body.top - 1 && r.bottom <= body.bottom + 1 && r.right <= body.right + 1;
              };
              return {
                search: inView('.learned-search'),
                count: inView('.learned-count'),
                paper: document.querySelector('.learned-paper').getBoundingClientRect().height,
                month: getComputedStyle(document.querySelector('.learned-month')).display !== 'none',
                entries: document.querySelectorAll('.learned-list li[data-date]').length,
              };
            });
            ok = ok && l.search && l.count && l.paper >= 40 && l.month === hgt >= 230 && l.entries > 0;
            extra = `${Math.round(hgt)}px, ${J(l)}`;
          } else {
            const rows = await page.locator('.wx-day').count();
            ok = ok && rows === (size === '3x3' || size === '12x3' ? 3 : 7) && (rows === 3 ? (await page.locator('.wx-day').first().getAttribute('class')).includes('today') : true);
            extra = `${rows} days`;
          }
          check(`${n} at ${size}: contents fit, nothing clipped or scrolling sideways (${extra})`, ok, bad.join(' | '));
          if (n === 'weather' && size === '3x3') await shot(page, 'grid-weather-3x3');
          if (n === 'wire') await shot(page, `grid-wire-${size}`);
          if (n === 'learned') await shot(page, `grid-learned-${size}`);
        }
      }
      await setGrid(page, { today: [0, 0, 4, 4], history: [4, 0, 8, 10], weather: [0, 4, 4, 6] });
      check('Today at 4 × 4: J-card in view, compact', (await page.evaluate(overflowIn, 'today')).length === 0 && (await page.locator('.deck.compact').count()) === 1);
      await shot(page, 'grid-today-4x4');
      await baseline(page);
    }

    check('no page errors', errors.length === 0, errors.join(' | '));
    check('no CSP violations', csp.length === 0, csp.join(' | '));
    await page.evaluate(() => localStorage.removeItem('pht:grid'));
    await context.close();
  }
  await browser.close();
}

if (shots.length) {
  console.log('\nscreenshots:');
  for (const s of shots) console.log(`  ${s}`);
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
