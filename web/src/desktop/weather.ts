import { ApiError, type Forecast, type WeatherKind } from '../lib/api';
import { h } from '../lib/dom';
import type { Ctx } from '../ui/context';

// The Weather window: an LCD tuner with seven rows — day and its word (SUNNY,
// PARTLY, …), an icon, hi/lo °F and rain chance — today highlighted, and when
// the forecast was fetched. The data is pht-api's cached Open-Meteo copy
// (GET /api/weather); this window never talks to anyone else.
//
// It adapts to its window: rows compress in a short one, and below about four
// grid rows (or SHORT_H px) it shows today and the next two days only.
//
// It does not use ctx.guard for failures: weather is optional, so a problem is
// a line in the window, never a dialog. Only a 401 goes back to Login.

const SVG = 'http://www.w3.org/2000/svg';
// Below this many grid rows, or this many px, three days instead of seven.
const SHORT_ROWS = 4;
const SHORT_H = 330;
// Below this height (px) the rows are compressed.
const COMPACT_H = 560;
const SHORT_DAYS = 3;

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function cloud(cls: string, dx = 0, dy = 0): SVGElement {
  const g = el('g', { class: `wx-cloud ${cls}`, transform: `translate(${dx} ${dy})` });
  g.append(
    el('circle', { cx: 12, cy: 17, r: 5.5 }),
    el('circle', { cx: 18, cy: 13, r: 7 }),
    el('circle', { cx: 24.5, cy: 17, r: 5 }),
    el('rect', { x: 9, y: 16, width: 19, height: 6.5, rx: 3.2 }),
  );
  return g;
}

function sun(cx: number, cy: number, r: number): SVGElement {
  const g = el('g', { class: 'wx-sun' });
  g.append(el('circle', { cx, cy, r }));
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(a) * (r + 2.5);
    const y1 = cy + Math.sin(a) * (r + 2.5);
    const x2 = cx + Math.cos(a) * (r + 5.5);
    const y2 = cy + Math.sin(a) * (r + 5.5);
    g.append(el('line', { x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1) }));
  }
  return g;
}

// Original line-art icons, 34px, coloured by style.css (yellow sun and bolt,
// pale clouds, blue drops, a soft glow). Decorative: the word beside them
// carries the meaning.
export function weatherIcon(kind: WeatherKind): SVGElement {
  const svg = el('svg', { viewBox: '0 0 34 34', width: 34, height: 34, class: `wx-icon wx-${kind}`, 'aria-hidden': 'true', focusable: 'false' });
  switch (kind) {
    case 'sun':
      svg.append(sun(17, 17, 6.5));
      break;
    case 'part':
      svg.append(sun(12, 11, 5), cloud('', 4, 6));
      break;
    case 'cloud':
      svg.append(cloud('', -1, 2));
      break;
    case 'rain': {
      svg.append(cloud('', -1, -2));
      const drops = el('g', { class: 'wx-drops' });
      for (const [x, y] of [[11, 25], [17, 28], [23, 25]]) {
        drops.append(el('path', { d: `M${x} ${y}c-1.4 2-2.1 3.1-2.1 4a2.1 2.1 0 0 0 4.2 0c0-.9-.7-2-2.1-4z` }));
      }
      svg.append(drops);
      break;
    }
    case 'storm':
      svg.append(cloud('dark', -1, -3), el('path', { class: 'wx-bolt', d: 'M18 19l-5 8h4l-2 6 7-9h-4l2-5z' }));
      break;
    case 'fog': {
      const g = el('g', { class: 'wx-fog' });
      for (const [y, x1, x2] of [[10, 7, 27], [15, 4, 24], [20, 9, 30], [25, 5, 25]]) {
        g.append(el('line', { x1, y1: y, x2, y2: y }));
      }
      svg.append(g);
      break;
    }
  }
  return svg;
}

// `onDays` gets the number of days shown, for the title.
export function mountWeather(ctx: Ctx, body: HTMLElement, onUnauthorized: () => void, onDays: (n: number) => void) {
  const list = h('ol', { className: 'wx-days', attrs: { 'aria-label': '7-day forecast' } });
  const foot = h('p', { className: 'wx-updated' });
  const msg = h('p', { className: 'wx-msg', attrs: { role: 'status' } });
  const tuner = h('div', { className: 'tuner' }, h('div', { className: 'tuner-band', attrs: { 'aria-hidden': 'true' }, text: 'FM 88 · 92 · 96 · 100 · 104 · 108' }), msg, list, foot);
  body.replaceChildren(tuner);
  let short = false;
  let last: Forecast | null = null;

  const day3 = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${iso}T00:00:00Z`)).toUpperCase();
  const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ctx.zone });

  function show(f: Forecast) {
    last = f;
    msg.textContent = '';
    msg.hidden = true;
    const today = ctx.today();
    const from = Math.max(0, f.days.findIndex((d) => d.date === today));
    const days = short ? f.days.slice(from, from + SHORT_DAYS) : f.days;
    list.setAttribute('aria-label', `${days.length}-day forecast`);
    list.replaceChildren(
      ...days.map((d) =>
        h(
          'li',
          { className: `wx-day${d.date === today ? ' today' : ''}`, dataset: { date: d.date, kind: d.kind } },
          h('span', { className: 'wx-when' }, h('span', { className: 'wx-name', text: d.date === today ? 'TODAY' : day3(d.date) }), h('span', { className: 'wx-label', text: d.label })),
          weatherIcon(d.kind),
          h('span', { className: 'wx-temp', attrs: { 'aria-label': `high ${d.hi}°, low ${d.lo}°` } }, h('b', { text: `${d.hi}°` }), h('span', { text: ` / ${d.lo}°` })),
          h('span', { className: 'wx-rain', attrs: { 'aria-label': `rain ${d.rainPct ?? 0}%` }, text: d.rainPct === null ? '–' : `${d.rainPct}%` }),
        ),
      ),
    );
    foot.textContent = `Updated ${clock(f.updatedAt)}${f.stale ? ' · OFFLINE COPY' : ''}`;
    foot.classList.toggle('stale', f.stale);
    body.closest('.win')?.classList.toggle('wx-stale', f.stale);
  }

  function problem(text: string, state: string) {
    last = null;
    list.replaceChildren();
    foot.textContent = '';
    msg.hidden = false;
    msg.textContent = text;
    msg.dataset.state = state;
  }

  let seq = 0;
  async function load() {
    const mine = ++seq;
    try {
      const f = await ctx.api.weather();
      if (mine === seq) show(f);
    } catch (err) {
      if (mine !== seq) return;
      if (err instanceof ApiError && err.kind === 'unauthorized') return onUnauthorized();
      if (err instanceof ApiError && err.status === 503 && err.kind === 'http') return problem('WEATHER NOT CONFIGURED', 'unconfigured');
      if (err instanceof ApiError && err.kind === 'network') return problem("CAN'T REACH PHT", 'offline');
      problem('NO SIGNAL — FORECAST UNAVAILABLE', 'unavailable');
    }
  }

  problem('TUNING…', 'loading');
  return {
    load,
    // The window is `w` × `hgt` px and `rows` grid rows tall.
    fit(_w: number, hgt: number, rows: number) {
      const phone = ctx.isPhone();
      tuner.classList.toggle('compact', !phone && hgt < COMPACT_H);
      const s = !phone && (rows < SHORT_ROWS || hgt < SHORT_H);
      tuner.classList.toggle('short', s);
      if (s === short) return;
      short = s;
      onDays(s ? SHORT_DAYS : 7);
      if (last) show(last);
    },
  };
}
