import { ApiError, type Api } from '../lib/api';
import { h, nextId } from '../lib/dom';
import { isMilestone, keyAction } from '../lib/keys';
import { addDays } from '../lib/dates';
import { WINDOWS, type WindowName } from '../lib/layout';
import { PREF, readPref, writePref } from '../lib/prefs';
import { parseRoute } from '../lib/routes';
import { BACKFILL_DAYS, createDeskStore } from '../state/store';
import { confirmDialog, errorDialog, unreachableDialog } from '../ui/chrome';
import type { Ctx } from '../ui/context';
import { closeAllFloats, topFloat, type FloatWindow } from './float';
import { dragDebugWanted, mountDragDebug } from './dragDebug';
import { mountHistory } from './history';
import { PRESET_LABELS, PRESET_NAMES } from '../lib/grid';
import { createSnapDesk } from './snapgrid';
import { openDisplayWindow, openHelpWindow, openInfoWindow, openRetiredWindow, openSetupWindow } from './panels';
import { mountToday } from './today';
import { applyDisplay, readDisplay, saveDisplay, wallpaperLayer } from './wallpaper';
import { mountWeather } from './weather';
import { mountLearned } from './learned';
import { mountWire } from './wire';

// The desktop: five windows (Today, History, Learned, Weather, AI Wire) on a 12 × 10 snap grid
// above a 98 taskbar (see snapgrid.ts): moved by their title bars, resized by
// any edge or corner, never overlapping. Each window's contents adapt to its
// size (`fit`, from a ResizeObserver).
// Floating windows (Info, Setup, Retired habits, Display Properties, help)
// open above the row and never take a slot. Below 900px the four stack and
// the taskbar keeps only Start and the clock.

const PHONE_QUERY = '(max-width: 899px)';
const REFRESH_MIN_MS = 30_000;
const SPLASH_MS = 1000;
const ALL_DONE_FLASH_MS = 2600;
const TITLES: Record<WindowName, string> = {
  today: 'Today',
  history: 'History',
  learned: 'Learned',
  weather: 'Weather',
  wire: 'AI Wire',
};

export interface DesktopDeps {
  api: Api;
  zone: string;
  today(): string;
  // Show the splash: only right after a fresh login, never on a reload.
  splash: boolean;
  // The session is over (401, or Log Off finished): show Login.
  onSessionEnd(): void;
}

export function mountDesktop(root: HTMLElement, deps: DesktopDeps): void {
  const { api } = deps;
  const phoneMq = window.matchMedia(PHONE_QUERY);
  const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isPhone = () => phoneMq.matches;
  let ended = false;
  let statusSink: (t: string) => void = () => undefined;
  const cleanups: (() => void)[] = [];
  const listen = <K extends keyof WindowEventMap>(t: Window, ev: K, fn: (e: WindowEventMap[K]) => void) => {
    t.addEventListener(ev, fn);
    cleanups.push(() => t.removeEventListener(ev, fn));
  };
  const listenDoc = <K extends keyof DocumentEventMap>(ev: K, fn: (e: DocumentEventMap[K]) => void) => {
    document.addEventListener(ev, fn);
    cleanups.push(() => document.removeEventListener(ev, fn));
  };

  function end() {
    if (ended) return;
    ended = true;
    for (const c of cleanups) c();
    closeAllFloats();
    deps.onSessionEnd();
  }

  // The standard request wrapper: 401 → Login; unreachable → Retry dialog;
  // anything else → an error dialog with the API's text.
  async function guard<T>(fn: () => Promise<T>, failTitle = 'PHT'): Promise<T | undefined> {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (ended) return undefined;
        if (err instanceof ApiError && err.kind === 'unauthorized') {
          api.logout();
          end();
          return undefined;
        }
        if (err instanceof ApiError && err.kind === 'network') {
          if (await unreachableDialog()) continue;
          statusSink("Can't reach PHT");
          return undefined;
        }
        await errorDialog(failTitle, err instanceof Error ? err.message : 'Something went wrong.');
        return undefined;
      }
    }
  }

  const store = createDeskStore({ api, guard });

  // ── wallpaper ────────────────────────────────────────────────────────────
  let display = readDisplay();
  applyDisplay(root, display);

  // ── live region and balloons ─────────────────────────────────────────────
  const live = h('div', { className: 'sr-only', id: 'live', attrs: { 'aria-live': 'polite', role: 'status' } });
  const balloons = h('div', { className: 'balloons' });
  function balloon(text: string) {
    const close = h('button', { type: 'button', className: 'balloon-close', attrs: { 'aria-label': 'Dismiss' } });
    const b = h('div', { className: 'balloon', dataset: { text } }, h('p', { className: 'balloon-text', text }), close);
    const remove = () => b.remove();
    close.addEventListener('click', remove);
    balloons.append(b);
    window.setTimeout(remove, 8000);
    announce(text);
  }
  function announce(text: string) {
    live.textContent = '';
    window.setTimeout(() => (live.textContent = text), 50);
  }

  // ── windows ──────────────────────────────────────────────────────────────
  interface Win {
    name: WindowName;
    root: HTMLElement;
    body: HTMLDivElement;
    title: HTMLDivElement;
    titleBar: HTMLDivElement;
    task: HTMLButtonElement;
  }
  const wins = WINDOWS.map((name): Win => {
    const titleId = `title-${name}`;
    const title = h('div', { className: 'title-bar-text', id: titleId, text: TITLES[name], attrs: { role: 'heading', 'aria-level': '2' } });
    const minBtn = h('button', { type: 'button', className: 'min-btn', attrs: { 'aria-label': `Minimize ${TITLES[name]}` } });
    minBtn.addEventListener('click', () => setMinimized(name, true));
    const body = h('div', { className: 'window-body win-body' });
    const titleBar = h('div', { className: 'title-bar' }, title, h('div', { className: 'title-bar-controls' }, minBtn));
    const winRoot = h(
      'section',
      {
        className: `window win win-${name}`,
        id: `win-${name}`,
        tabIndex: -1,
        attrs: { role: 'region', 'aria-labelledby': titleId },
      },
      titleBar,
      body,
    );
    const task = h('button', {
      type: 'button',
      className: `task-btn task-${name}`,
      text: TITLES[name],
      dataset: { window: name },
      attrs: { 'aria-controls': `win-${name}` },
    });
    task.addEventListener('click', () => setMinimized(name, !grid.isMinimized(name)));
    return { name, root: winRoot, body, title, titleBar, task };
  });
  const winOf = (n: WindowName) => wins[WINDOWS.indexOf(n)];

  // ── the context every window gets ────────────────────────────────────────
  let info: { id: number; win: FloatWindow } | null = null;
  let infoPushed = false;
  let infoFromPop = false;
  const ctx: Ctx = {
    api,
    store,
    zone: deps.zone,
    today: deps.today,
    guard,
    status: (t) => statusSink(t),
    openInfo: (id, opener) => showInfo(id, opener ?? null, true),
    balloon,
    isPhone,
    openDay: (date) => void showDay(date),
    restart: async () => {
      await today.flushNote();
      location.reload();
    },
  };

  const today = mountToday(
    ctx,
    winOf('today').body,
    (t) => {
      winOf('today').title.textContent = t;
      winOf('today').task.textContent = t;
      document.title = `${t} - PHT`;
    },
    {
      step: (n) => void showDay(addDays(dayTarget ?? store.state.view, n)),
      toToday: () => void showDay(store.state.date),
    },
  );
  statusSink = (t) => {
    const el = winOf('today').body.querySelector('.today-status');
    if (el) el.textContent = t;
  };
  const history = mountHistory(ctx, winOf('history').body, (days) => {
    winOf('history').title.textContent = `History — last ${days} days`;
  });
  const weather = mountWeather(
    ctx,
    winOf('weather').body,
    () => {
      api.logout();
      end();
    },
    (days) => (winOf('weather').title.textContent = `Weather — ${days} days`),
  );
  winOf('weather').title.textContent = 'Weather — 7 days';
  const wire = mountWire(
    ctx,
    winOf('wire').body,
    () => {
      api.logout();
      end();
    },
    (t) => (winOf('wire').title.textContent = t),
  );
  const learned = mountLearned(
    ctx,
    winOf('learned').body,
    () => {
      api.logout();
      end();
    },
    (t) => (winOf('learned').title.textContent = t),
  );

  // ── the snap grid ────────────────────────────────────────────────────────
  const desk = h('div', { className: 'desk' });
  const grid = createSnapDesk({
    root,
    desk,
    wins: wins.map((w) => ({ name: w.name, root: w.root, titleBar: w.titleBar, task: w.task })),
    titles: TITLES,
    isPhone,
    announce,
  });
  cleanups.push(() => grid.destroy());
  const setMinimized = (name: WindowName, on: boolean) => grid.setMinimized(name, on);

  // Each window's contents follow its size.
  const fitters: Record<WindowName, (w: number, hgt: number) => void> = {
    today: (w, hgt) => today.fit(w, hgt),
    history: (w, hgt) => history.fit(w, hgt),
    weather: (w, hgt) => weather.fit(w, hgt, isPhone() ? Infinity : grid.rectOf('weather')[3]),
    wire: (w, hgt) => wire.fit(w, hgt),
    learned: (w, hgt) => learned.fit(w, hgt),
  };
  const fitObserver = new ResizeObserver((entries) => {
    for (const e of entries) {
      const name = (e.target as HTMLElement).dataset.window as WindowName | undefined;
      if (!name) continue;
      const r = e.target.getBoundingClientRect();
      if (r.width > 0) fitters[name](r.width, r.height);
    }
  });
  for (const w of wins) {
    w.root.dataset.window = w.name;
    fitObserver.observe(w.root);
  }
  cleanups.push(() => fitObserver.disconnect());

  // ── taskbar, Start menu, clock ───────────────────────────────────────────
  const menuId = nextId('start-menu');
  const startBtn = h(
    'button',
    {
      type: 'button',
      className: 'start-btn',
      attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId },
    },
    h('span', { className: 'start-logo', attrs: { 'aria-hidden': 'true' } }),
    h('span', { text: 'Start' }),
  );
  const items: [string, string, () => void][] = [
    ['setup', 'Setup...', () => openSetupWindow(ctx, startBtn)],
    ['retired', 'Retired habits...', () => openRetiredWindow(ctx, startBtn)],
    [
      'display',
      'Display Properties...',
      () =>
        openDisplayWindow(
          () => display,
          (v) => {
            display = v;
            saveDisplay(v);
            applyDisplay(root, v);
          },
          startBtn,
          isPhone,
        ),
    ],
    ['layouts', 'Layouts', () => openSub()],
    ['reset-layout', 'Reset layout', () => preset('thirds')],
    ['logoff', 'Log Off...', () => void logOffAsk()],
  ];
  function preset(p: (typeof PRESET_NAMES)[number]) {
    grid.applyPreset(p);
    announce(`Layout: ${PRESET_LABELS[p]}.`);
  }
  const menuButtons = items.map(([key, label, run]) => {
    const b = h('button', {
      type: 'button',
      className: `menu-item menu-${key}`,
      text: label,
      tabIndex: -1,
      dataset: { item: key },
      attrs: { role: 'menuitem' },
    });
    b.addEventListener('click', () => {
      if (key === 'layouts') return run();
      closeMenu(false);
      run();
    });
    return b;
  });
  // Start ▸ Layouts: the presets, in a submenu to the right.
  const layoutsBtn = menuButtons[items.findIndex(([k]) => k === 'layouts')];
  const subId = nextId('layouts-menu');
  layoutsBtn.setAttribute('aria-haspopup', 'menu');
  layoutsBtn.setAttribute('aria-expanded', 'false');
  layoutsBtn.setAttribute('aria-controls', subId);
  layoutsBtn.append(h('span', { className: 'menu-arrow', text: '▸', attrs: { 'aria-hidden': 'true' } }));
  const subButtons = PRESET_NAMES.map((p) => {
    const b = h('button', {
      type: 'button',
      className: `menu-item menu-preset-${p}`,
      text: PRESET_LABELS[p],
      tabIndex: -1,
      dataset: { preset: p },
      attrs: { role: 'menuitem' },
    });
    b.addEventListener('click', () => {
      closeMenu(false);
      preset(p);
    });
    return b;
  });
  const sub = h(
    'div',
    { className: 'window start-sub', id: subId, hidden: true },
    h('ul', { attrs: { role: 'menu', 'aria-label': 'Layouts' } }, ...subButtons.map((b) => h('li', { attrs: { role: 'none' } }, b))),
  );
  layoutsBtn.parentElement?.classList.add('has-sub');
  function openSub(focus = true) {
    sub.hidden = false;
    layoutsBtn.setAttribute('aria-expanded', 'true');
    if (focus) subButtons[0].focus();
  }
  function closeSub(returnFocus: boolean) {
    if (sub.hidden) return;
    sub.hidden = true;
    layoutsBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus) layoutsBtn.focus();
  }
  layoutsBtn.addEventListener('pointerenter', () => openSub(false));
  for (const b of menuButtons) if (b !== layoutsBtn) b.addEventListener('pointerenter', () => closeSub(false));
  sub.addEventListener('keydown', (e) => {
    const i = subButtons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (j: number) => subButtons[(j + subButtons.length) % subButtons.length].focus();
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(subButtons.length - 1);
    else if (e.key === 'ArrowLeft' || e.key === 'Escape') closeSub(true);
    else if (e.key === 'Tab') {
      closeMenu(false);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  const menu = h(
    'div',
    { className: 'window start-menu', id: menuId, hidden: true },
    h('div', { className: 'start-banner', attrs: { 'aria-hidden': 'true' } }, h('b', { text: 'PHT' }), h('span', { text: '98' })),
    h(
      'ul',
      { attrs: { role: 'menu', 'aria-label': 'Start' } },
      ...menuButtons.map((b, i) =>
        h('li', { attrs: { role: 'none' }, className: i === menuButtons.length - 1 ? 'menu-last' : '' }, b),
      ),
    ),
  );
  layoutsBtn.parentElement?.append(sub);
  const menuOpen = () => !menu.hidden;
  function openMenu(focus: 'first' | 'last' = 'first') {
    menu.hidden = false;
    startBtn.setAttribute('aria-expanded', 'true');
    startBtn.classList.add('active');
    (focus === 'first' ? menuButtons[0] : menuButtons[menuButtons.length - 1]).focus();
  }
  function closeMenu(returnFocus: boolean) {
    if (menu.hidden) return;
    closeSub(false);
    menu.hidden = true;
    startBtn.setAttribute('aria-expanded', 'false');
    startBtn.classList.remove('active');
    if (returnFocus) startBtn.focus();
  }
  startBtn.addEventListener('click', () => (menuOpen() ? closeMenu(true) : openMenu()));
  startBtn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu(e.key === 'ArrowUp' ? 'last' : 'first');
    }
  });
  menu.addEventListener('keydown', (e) => {
    const i = menuButtons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (j: number) => menuButtons[(j + menuButtons.length) % menuButtons.length].focus();
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(menuButtons.length - 1);
    else if (e.key === 'Escape') closeMenu(true);
    else if ((e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') && document.activeElement === layoutsBtn) openSub();
    else if (e.key === 'Tab') {
      closeMenu(false);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  listenDoc('pointerdown', (e) => {
    if (menuOpen() && !menu.contains(e.target as Node) && !startBtn.contains(e.target as Node)) closeMenu(false);
  });

  const clock = h('span', { className: 'clock lcd', attrs: { 'aria-label': 'Time' } });
  const fmtClock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: deps.zone });
  function tick() {
    clock.textContent = fmtClock.format(new Date());
    // A desktop left open across midnight moves to the new day.
    if (store.state.date && deps.today() !== store.state.date) void rollover();
  }
  const clockTimer = window.setInterval(tick, 10_000);
  cleanups.push(() => window.clearInterval(clockTimer));
  tick();

  const taskbar = h(
    'div',
    { className: 'taskbar', attrs: { role: 'toolbar', 'aria-label': 'Taskbar' } },
    startBtn,
    h('span', { className: 'tb-sep', attrs: { 'aria-hidden': 'true' } }),
    h('div', { className: 'tasks' }, ...wins.map((w) => w.task)),
    h('div', { className: 'tray' }, clock),
  );

  // ── Info and the URL ─────────────────────────────────────────────────────
  const history_ = window.history;
  // /habit/:id is the desktop with Info open. Opening Info from the desktop
  // pushes that path, so Back closes it; closing it with × or Esc goes back.
  function showInfo(id: number, opener: HTMLElement | null, push: boolean) {
    if (info && info.id !== id) {
      infoFromPop = true; // replacing it: leave the URL to this call
      info.win.close();
      infoFromPop = false;
    }
    if (info && info.id === id) {
      info.win.root.focus();
      return;
    }
    const win = openInfoWindow(ctx, id, opener, () => {
      info = null;
      if (infoFromPop) return;
      if (infoPushed) {
        infoPushed = false;
        history_.back();
      } else {
        syncDayUrl();
      }
    });
    if (!win) {
      if (location.pathname !== '/') history_.replaceState(null, '', `/${location.search}`);
      return;
    }
    info = { id, win };
    if (push && location.pathname !== `/habit/${id}`) {
      history_.pushState(null, '', `/habit/${id}${location.search}`);
      infoPushed = true;
    }
  }
  listen(window, 'popstate', () => {
    const route = parseRoute(location.pathname);
    if (route?.name === 'info') {
      infoPushed = false;
      showInfo(route.id, null, false);
    } else {
      if (!route) history_.replaceState(null, '', `/${location.search}`);
      if (info) {
        infoFromPop = true;
        infoPushed = false;
        info.win.close();
        infoFromPop = false;
      }
      // The deck follows the URL: /day/… is that day, / is today.
      if (store.state.date) void showDay(route?.name === 'day' ? route.date : store.state.date);
    }
  });

  // ── the deck's day: /day/YYYY-MM-DD, / for today ─────────────────────────
  const inWindow = (d: string) => d <= store.state.date && d >= store.earliest();
  // Put the URL in step with the deck (replaceState: stepping through days
  // does not fill the Back history). Left alone while Info owns the URL.
  function syncDayUrl() {
    if (info) return;
    const { view, date } = store.state;
    const path = view === date ? '/' : `/day/${view}`;
    // The query (?debug=drag) stays: only the path follows the deck.
    if (location.pathname !== path) history_.replaceState(null, '', `${path}${location.search}`);
  }
  // Day changes run one at a time. dayTarget is the day the deck is heading
  // to, so quick presses step from there (three [ presses go back three
  // days, not one), and a change already superseded by a later press is
  // skipped instead of loaded.
  let dayTarget: string | null = null;
  let dayBusy: Promise<void> = Promise.resolve();
  async function showDay(date: string): Promise<void> {
    if (!store.state.date || !inWindow(date) || date === (dayTarget ?? store.state.view)) return;
    dayTarget = date;
    const run = dayBusy.then(async () => {
      if (dayTarget !== date) return;
      // What was typed belongs to the day it was typed on.
      await today.flushNote();
      if (await store.setView(date)) syncDayUrl();
    });
    dayBusy = run.catch(() => {});
    try {
      await run;
    } finally {
      if (dayTarget === date) dayTarget = null;
    }
  }

  // ── moments: all done, milestones ────────────────────────────────────────
  const seenMilestones = new Set<string>();
  store.subscribe((c) => {
    const st = store.state;
    // Only a check for today, made on a deck showing today: never a backfill.
    const forToday = c.kind === 'confirmed' && c.date === st.date && st.view === st.date;
    // "All" is every habit due today: a habit on a rest day is not waited for.
    if (forToday && c.done && st.today && st.today.dueCount > 0 && st.today.dueDone === st.today.dueCount) {
      const isStr = (v: unknown): v is string => typeof v === 'string';
      if (readPref(PREF.allDone, isStr, '') !== st.date) {
        writePref(PREF.allDone, st.date);
        today.flashLcd(`ALL ${st.today.dueCount} ✓`, ALL_DONE_FLASH_MS);
        balloon('All habits complete. Streaks safe.');
      }
    }
    if (c.kind === 'synced') {
      for (const m of c.milestones) {
        const key = `${st.date}:${m.habitId}:${m.streak}`;
        if (seenMilestones.has(key) || !isMilestone(m.streak)) continue;
        seenMilestones.add(key);
        balloon(`${m.label}: ${m.streak} days`);
      }
    }
  });

  // ── keyboard ─────────────────────────────────────────────────────────────
  listenDoc('keydown', (e) => {
    if (e.defaultPrevented || document.querySelector('.dialog-overlay')) return;
    if (e.key === 'Escape') {
      if (menuOpen()) closeMenu(true);
      else topFloat()?.close();
      return;
    }
    if (menuOpen()) return;
    const act = keyAction(e);
    if (!act) return;
    if (act.kind === 'toggle') {
      const habit = store.state.today?.habits[act.index];
      if (!habit) return;
      e.preventDefault();
      store.toggle(habit.id);
    } else if (act.kind === 'note') {
      if (today.note.disabled) return;
      e.preventDefault();
      if (grid.isMinimized('today')) setMinimized('today', false);
      today.note.focus();
    } else if (act.kind === 'step') {
      e.preventDefault();
      // `]` inside the AI Wire window is its Next ▸; everywhere else it steps the deck.
      if (act.days === 1 && winOf('wire').root.contains(document.activeElement)) return void wire.next();
      void showDay(addDays(dayTarget ?? store.state.view, act.days));
    } else {
      e.preventDefault();
      openHelpWindow(document.activeElement as HTMLElement | null, isPhone);
    }
  });

  // ── refresh on return, midnight ──────────────────────────────────────────
  let lastLoad = Date.now();
  let rolling = false;
  // A new day. A deck showing today moves on to the new today; a deck showing
  // a past day stays on it (it is mid-edit), unless that day has just left
  // the 30-day window, when it goes to the oldest day still in it.
  async function rollover() {
    if (rolling) return;
    rolling = true;
    // Anything typed for the old day goes to the old day first.
    await today.flushNote();
    lastLoad = Date.now();
    const next = deps.today();
    const was = store.state;
    let view = was.view === was.date ? next : was.view;
    if (view < addDays(next, -BACKFILL_DAYS)) view = addDays(next, -BACKFILL_DAYS);
    await store.load(next, view);
    syncDayUrl();
    void weather.load();
    void wire.load();
    void learned.load();
    rolling = false;
  }
  function onReturn() {
    if (ended || document.visibilityState !== 'visible') return;
    if (document.querySelector('.dialog-overlay')) return;
    const now = Date.now();
    if (now - lastLoad < REFRESH_MIN_MS) return;
    lastLoad = now;
    if (deps.today() !== store.state.date) return void rollover();
    // The same day: refresh, keeping the deck on whatever day it shows.
    if (store.pending() === 0) void store.load(store.state.date, store.state.view);
    void weather.load();
    void wire.load();
    void learned.load();
  }
  listenDoc('visibilitychange', onReturn);
  listen(window, 'focus', onReturn);

  // ── phone ↔ desktop, window size ─────────────────────────────────────────
  const onPhone = () => {
    grid.arrange();
    today.relayout();
    history.relayout();
  };
  phoneMq.addEventListener('change', onPhone);
  cleanups.push(() => phoneMq.removeEventListener('change', onPhone));

  // ── Log Off ──────────────────────────────────────────────────────────────
  async function logOffAsk() {
    const ok = await confirmDialog('Log Off PHT', 'Are you sure you want to log off? This ends the session on every device.', 'Log Off');
    if (ok) await logOff();
  }
  // End every browser session on the server, then here. If PHT can't be
  // reached this device is still logged off, and it says the others may not be.
  async function logOff() {
    await today.flushNote();
    try {
      await api.logoutEverywhere();
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'network') {
        await errorDialog(
          'Log Off',
          "Logged off on this device, but PHT couldn't be reached, so other devices may still be logged on.",
        );
      }
      // unauthorized: the session had already ended — nothing more to do.
    }
    end();
  }

  // ── mount ────────────────────────────────────────────────────────────────
  const route = parseRoute(location.pathname);
  if (!route) history_.replaceState(null, '', `/${location.search}`);
  // The page's one h1, for screen-reader heading navigation; the window
  // titles are the level-2 headings under it.
  const heading = h('h1', { className: 'sr-only', text: 'PHT' });
  root.replaceChildren(heading, wallpaperLayer(), desk, menu, taskbar, balloons, live);
  grid.arrange();
  if (dragDebugWanted()) cleanups.push(mountDragDebug({ layoutJson: grid.layoutJson, isPhone }));

  const splash =
    deps.splash && !reducedMq.matches
      ? h('div', { className: 'splash', attrs: { 'aria-hidden': 'true' } }, h('div', { className: 'splash-brand', text: 'PHT-6' }), h('div', { className: 'splash-sub', text: 'Personal Habit Tracker' }))
      : null;
  if (splash) {
    document.body.append(splash);
    window.setTimeout(() => splash.remove(), SPLASH_MS);
  }
  root.dataset.splash = splash ? 'shown' : 'skipped';

  void (async () => {
    statusSink('Loading…');
    const now = deps.today();
    // /day/… opens the deck on that day if it is still in the window.
    const asked = route?.name === 'day' ? route.date : now;
    const view = asked <= now && asked >= addDays(now, -BACKFILL_DAYS) ? asked : now;
    const ok = await store.load(now, view);
    lastLoad = Date.now();
    if (!ok || ended) return;
    statusSink('');
    if (route?.name === 'info') showInfo(route.id, null, false);
    else syncDayUrl();
  })();
  void weather.load();
  void wire.load();
  void learned.load();
}
