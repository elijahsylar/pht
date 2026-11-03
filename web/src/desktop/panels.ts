import type { Habit, Schedule } from '../lib/api';
import { addDays, shortDate } from '../lib/dates';
import { WEEKDAY_LONG, WEEKDAY_SHORT, describeSchedule, isDue, sameSchedule } from '../lib/schedule';
import { h, nextId } from '../lib/dom';
import { slugify } from '../lib/routes';
import { confirmDialog, errorDialog, progressBar, promptDialog } from '../ui/chrome';
import type { Ctx } from '../ui/context';
import { openFloat, recenter, type FloatWindow } from './float';
import { WALLPAPERS, type Wallpaper } from './wallpaper';

const RAMP_MAX = 120;
const LABEL_MAX = 80;

// ── Schedule picker (Info and Setup) ─────────────────────────────────────
// Every day, every other day (today on, or today off), or chosen days of the
// week. Saving applies from today on; earlier days keep the schedule they
// had, so past streaks never change. `habit()` is the habit being edited.
export interface SchedulePicker {
  el: HTMLElement;
  // Show the habit's saved schedule, unless an edit is in progress.
  sync(force?: boolean): void;
}

export function schedulePicker(
  ctx: Ctx,
  habit: () => { id: number; label: string; schedule: Schedule } | null,
  onSaved: (text: string) => void,
): SchedulePicker {
  const name = nextId('schedule');
  const radio = (value: Schedule['kind'], text: string) => {
    const id = `${name}-${value}`;
    const input = h('input', { type: 'radio', name, id, value, className: `schedule-${value}` });
    return { input, row: h('div', { className: 'field-row' }, input, h('label', { htmlFor: id, text })) };
  };
  const daily = radio('daily', 'Every day');
  const eod = radio('every_other_day', 'Every other day');
  const week = radio('weekdays', 'On these days:');
  const eodId = nextId('eod');
  const eodWhen = h(
    'select',
    { id: eodId, className: 'schedule-eod', attrs: { 'aria-label': 'Every other day, starting' } },
    h('option', { value: 'today', text: 'today is a day on' }),
    h('option', { value: 'tomorrow', text: 'today is a rest day' }),
  );
  // Monday first, the way a week reads.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const dayBoxes = order.map((d) => {
    const id = `${name}-d${d}`;
    const input = h('input', { type: 'checkbox', id, value: String(d), className: 'schedule-day' });
    return { d, input, el: h('span', { className: 'field-row' }, input, h('label', { htmlFor: id, text: WEEKDAY_SHORT[d], title: WEEKDAY_LONG[d] })) };
  });
  const days = h('fieldset', { className: 'schedule-days', attrs: { 'aria-label': 'Days of the week' } }, ...dayBoxes.map((b) => b.el));
  const now = h('p', { className: 'schedule-now' });
  const save = h('button', { type: 'submit', text: 'Save schedule', className: 'schedule-save', disabled: true });
  const form = h(
    'form',
    { className: 'schedule-form', attrs: { novalidate: '' } },
    now,
    daily.row,
    eod.row,
    h('div', { className: 'field-row' }, eodWhen),
    week.row,
    days,
    h('div', { className: 'schedule-actions' }, save),
  );
  let dirty = false;

  // The schedule the controls describe now; null when it is not a valid one.
  function chosen(): Schedule | null {
    const today = ctx.today();
    if (eod.input.checked) return { kind: 'every_other_day', anchor: eodWhen.value === 'today' ? today : addDays(today, 1) };
    if (week.input.checked) {
      const picked = dayBoxes.filter((b) => b.input.checked).map((b) => b.d).sort((a, b) => a - b);
      return picked.length ? { kind: 'weekdays', days: picked } : null;
    }
    return { kind: 'daily' };
  }
  // Every other day with the same rhythm is the same schedule, whatever its anchor.
  function unchanged(a: Schedule, b: Schedule): boolean {
    if (a.kind === 'every_other_day' && b.kind === 'every_other_day') return isDue(a, ctx.today()) === isDue(b, ctx.today());
    return sameSchedule(a, b);
  }
  function refresh() {
    const cur = habit();
    const pick = chosen();
    eodWhen.disabled = !eod.input.checked;
    days.disabled = !week.input.checked;
    save.disabled = !cur || !pick || unchanged(pick, cur.schedule);
  }
  function sync(force = false) {
    const cur = habit();
    if (!cur) return;
    now.textContent = `Now: ${describeSchedule(cur.schedule)}${cur.schedule.kind === 'every_other_day' ? (isDue(cur.schedule, ctx.today()) ? ' (on today)' : ' (rest today)') : ''}`;
    if (dirty && !force) return refresh();
    const s = cur.schedule;
    daily.input.checked = s.kind === 'daily';
    eod.input.checked = s.kind === 'every_other_day';
    week.input.checked = s.kind === 'weekdays';
    eodWhen.value = s.kind === 'every_other_day' && !isDue(s, ctx.today()) ? 'tomorrow' : 'today';
    const on = new Set(s.kind === 'weekdays' ? s.days : [1, 2, 3, 4, 5]);
    for (const b of dayBoxes) b.input.checked = on.has(b.d);
    dirty = false;
    refresh();
  }
  form.addEventListener('change', () => {
    dirty = true;
    refresh();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = habit();
    const pick = chosen();
    if (!cur || !pick || save.disabled) return;
    save.disabled = true;
    const r = await ctx.guard(
      () => ctx.api.patchHabit(cur.id, { schedule: pick, scheduleFrom: ctx.today() }),
      "Couldn't save the schedule",
    );
    if (!r) return refresh();
    dirty = false;
    onSaved(`${cur.label}: ${describeSchedule(r.schedule)} from today. Earlier days keep their old schedule.`);
    await ctx.store.load(ctx.store.state.date, ctx.store.state.view);
  });
  return { el: h('fieldset', { className: 'schedule' }, h('legend', { text: 'Schedule' }), form), sync };
}

// ── Info ──────────────────────────────────────────────────────────────────
// One active habit: current/best/total, its last 14 days, the next milestone,
// the ramp text, Rename and Retire. Read from the shared store, so it follows
// checks made on the desktop while it is open.
export function openInfoWindow(ctx: Ctx, id: number, opener: HTMLElement | null, onClose: () => void): FloatWindow | null {
  const habit0 = ctx.store.state.today?.habits.find((x) => x.id === id);
  if (!habit0) return null;
  // The caller closes any other Info first: there is one at a time.
  const win = openFloat({ key: 'info', title: habit0.label, className: 'info-window', opener, onClose, isPhone: ctx.isPhone });
  win.body.dataset.habitId = String(id);

  const stat = (label: string, cls: string) => {
    const v = h('span', { className: 'stat-value' });
    return { v, el: h('div', { className: `stat ${cls}` }, v, h('span', { className: 'stat-label', text: label })) };
  };
  const cur = stat('current', 'current');
  const bst = stat('best', 'best');
  const tot = stat('total', 'total');
  const boxes = h('div', { className: 'meter info-meter', attrs: { role: 'img' } });
  const milestoneText = h('p', { className: 'milestone-text' });
  const barSlot = h('div', { className: 'milestone-bar' });

  const rampId = nextId('ramp');
  const ramp = h('input', {
    type: 'text',
    id: rampId,
    className: 'ramp-input',
    value: habit0.rampText ?? '',
    maxLength: RAMP_MAX,
    placeholder: 'e.g. 5 minutes, then 10',
    autocomplete: 'off',
  });
  const saveRamp = h('button', { type: 'button', text: 'Save', className: 'ramp-save', disabled: true });
  // What the field last showed from the server; anything else is an edit.
  let shownRamp = habit0.rampText ?? '';
  const rampDirty = () => document.activeElement === ramp || ramp.value.trim() !== shownRamp;
  ramp.addEventListener('input', () => {
    saveRamp.disabled = ramp.value.trim() === shownRamp;
  });
  saveRamp.addEventListener('click', async () => {
    saveRamp.disabled = true;
    const r = await ctx.guard(() => ctx.api.patchHabit(id, { rampText: ramp.value }), "Couldn't save the ramp");
    if (!r) {
      saveRamp.disabled = false;
      return;
    }
    const live = ctx.store.state.today?.habits.find((x) => x.id === id);
    if (live) live.rampText = r.rampText;
    shownRamp = r.rampText ?? '';
    ramp.value = shownRamp;
    status.textContent = 'Ramp saved';
  });

  const rename = h('button', { type: 'button', text: 'Rename…', className: 'rename-btn' });
  rename.addEventListener('click', async () => {
    const live = ctx.store.state.today?.habits.find((x) => x.id === id);
    if (!live) return;
    const label = await promptDialog('Rename habit', 'New name:', live.label, LABEL_MAX);
    if (label === null || !label.trim() || label.trim() === live.label) return;
    const r = await ctx.guard(() => ctx.api.patchHabit(id, { label: label.trim() }), "Couldn't rename");
    if (r) {
      status.textContent = 'Renamed';
      await ctx.store.load(ctx.store.state.date);
    }
  });

  const retire = h('button', { type: 'button', text: 'Retire…', className: 'retire-btn' });
  retire.addEventListener('click', async () => {
    const live = ctx.store.state.today?.habits.find((x) => x.id === id);
    if (!live) return;
    const ok = await confirmDialog(
      'Retire habit',
      `Retire "${live.label}"? It leaves the desktop, and its history is kept. You can bring it back from Start → Retired habits.`,
      'Retire',
    );
    if (!ok) return;
    const r = await ctx.guard(() => ctx.api.patchHabit(id, { retired: true }), "Couldn't retire");
    if (r) {
      win.close();
      await ctx.store.load(ctx.store.state.date);
    }
  });

  const status = h('p', { className: 'status-bar-field', attrs: { role: 'status' } });
  const picker = schedulePicker(
    ctx,
    () => ctx.store.state.today?.habits.find((x) => x.id === id) ?? null,
    (t) => (status.textContent = t),
  );
  win.body.replaceChildren(
    h('fieldset', { className: 'stats-set' }, h('legend', { text: 'Streak' }), h('div', { className: 'stat-row' }, cur.el, bst.el, tot.el)),
    h('fieldset', null, h('legend', { text: 'Last 14 days' }), boxes),
    h('fieldset', { className: 'milestone' }, h('legend', { text: 'Next milestone' }), milestoneText, barSlot),
    h(
      'fieldset',
      { className: 'ramp' },
      h('legend', { text: 'Ramp' }),
      h('label', { htmlFor: rampId, className: 'ramp-help', text: 'How this habit grows over time:' }),
      h('div', { className: 'field-row ramp-row' }, ramp, saveRamp),
    ),
    picker.el,
    h('div', { className: 'info-actions' }, rename, retire),
    h('div', { className: 'status-bar' }, status),
  );

  function paint() {
    const habit = ctx.store.state.today?.habits.find((x) => x.id === id);
    if (!habit) {
      // Retired elsewhere: Info is for active habits.
      win.close();
      return;
    }
    win.setTitle(habit.label);
    cur.v.textContent = String(habit.streak);
    bst.v.textContent = String(habit.best);
    tot.v.textContent = String(habit.totalDone);
    const hist = ctx.store.state.history;
    const row = hist?.habits.find((x) => x.id === id);
    const flags = row ? row.done.slice(-14) : [];
    const dues = row?.due ? row.due.slice(-14) : flags.map(() => true);
    const dates = hist ? hist.dates.slice(-14) : [];
    boxes.replaceChildren(
      ...flags.map((on, i) =>
        h('span', {
          className: `led${on ? ' on' : ''}${dues[i] ? '' : ' rest'}${dates[i] === ctx.store.state.date ? ' today' : ''}`,
          title: `${shortDate(dates[i])}: ${dues[i] ? '' : 'rest day, '}${on ? 'done' : 'not done'}`,
          dataset: { date: dates[i], on: String(on), due: String(dues[i]) },
        }),
      ),
    );
    const dueN = dues.filter(Boolean).length;
    boxes.setAttribute('aria-label', `Last 14 days: ${flags.filter((on, i) => on && dues[i]).length} of ${dueN} due days done`);
    picker.sync();
    const { next, progress } = habit.milestone;
    milestoneText.textContent = `${next} days — ${progress} done, ${next - progress} to go`;
    barSlot.replaceChildren(progressBar(progress / next, `${progress} of ${next} days`));
    // A half-typed ramp is never replaced.
    if (!rampDirty()) {
      shownRamp = habit.rampText ?? '';
      ramp.value = shownRamp;
    }
  }
  const unsub = ctx.store.subscribe(() => (win.isOpen() ? paint() : unsub()));
  paint();
  return win;
}

// ── Setup ─────────────────────────────────────────────────────────────────
// Add a habit and set the order. Changes reload the desktop.
export function openSetupWindow(ctx: Ctx, opener: HTMLElement | null): void {
  const win = openFloat({ key: 'setup', title: 'Setup', className: 'setup-window', opener, isPhone: ctx.isPhone });
  if (win.body.dataset.ready) return;
  win.body.dataset.ready = '1';
  win.body.replaceChildren(h('p', { className: 'loading', text: 'Loading…' }));
  let busy = false;
  const status = h('p', { className: 'status-bar-field', attrs: { role: 'status' } });

  // The habit the Schedule section edits, kept across reloads.
  let scheduleFor: number | null = null;
  let latest: Habit[] = [];

  async function load() {
    const habits = await ctx.guard(() => ctx.api.habits());
    if (!habits || !win.isOpen()) return;
    latest = habits;
    render(habits);
    recenter(win);
  }

  async function change(fn: () => Promise<unknown>, failTitle: string, done: string) {
    if (busy) return;
    busy = true;
    win.body.classList.add('busy');
    const ok = await ctx.guard(fn, failTitle);
    busy = false;
    win.body.classList.remove('busy');
    if (!win.isOpen()) return;
    await load();
    if (ok !== undefined) status.textContent = done;
    await ctx.store.load(ctx.store.state.date);
  }

  // Moving one habit rewrites `sort` as 1..n for every habit whose position
  // changed, so equal or gapped sort values can never make the order stick.
  function move(active: Habit[], index: number, delta: -1 | 1) {
    const order = [...active];
    const [item] = order.splice(index, 1);
    order.splice(index + delta, 0, item);
    void change(
      async () => {
        for (let i = 0; i < order.length; i += 1) {
          if (order[i].sort !== i + 1) await ctx.api.patchHabit(order[i].id, { sort: i + 1 });
        }
        return true;
      },
      "Couldn't reorder",
      `Moved "${item.label}" ${delta < 0 ? 'up' : 'down'}`,
    );
  }

  function render(all: Habit[]) {
    const active = all.filter((x) => !x.retiredAt);
    const labelId = nextId('new-label');
    const label = h('input', { type: 'text', id: labelId, maxLength: LABEL_MAX, autocomplete: 'off', className: 'new-label' });
    const add = h('button', { type: 'submit', text: 'Add', className: 'add-btn' });
    const form = h(
      'form',
      { className: 'add-form', attrs: { novalidate: '' } },
      h('label', { htmlFor: labelId, text: 'Name:' }),
      h('div', { className: 'field-row' }, label, add),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = label.value.trim();
      const slug = slugify(name);
      if (!name || !slug) {
        await errorDialog('Add habit', 'Give the habit a name with at least one letter or digit.');
        return;
      }
      const clash = all.find((x) => x.slug === slug);
      if (clash) {
        await errorDialog('Add habit', `A habit with the id "${slug}" already exists${clash.retiredAt ? ' (retired — bring it back from Start → Retired habits)' : ''}.`);
        return;
      }
      void change(() => ctx.api.createHabit({ slug, label: name }), "Couldn't add the habit", `Added "${name}"`);
    });

    const list = h(
      'ul',
      { className: 'setup-list active-list', attrs: { 'aria-label': 'Active habits' } },
      ...active.map((habit, i) =>
        h(
          'li',
          { className: 'setup-row', dataset: { slug: habit.slug } },
          h('span', { className: 'setup-label', text: habit.label }),
          h('button', {
            type: 'button',
            className: 'move-up',
            text: '▲',
            attrs: { 'aria-label': `Move ${habit.label} up` },
            disabled: i === 0,
            on: { click: () => move(active, i, -1) },
          }),
          h('button', {
            type: 'button',
            className: 'move-down',
            text: '▼',
            attrs: { 'aria-label': `Move ${habit.label} down` },
            disabled: i === active.length - 1,
            on: { click: () => move(active, i, 1) },
          }),
        ),
      ),
    );
    win.body.replaceChildren(
      h('fieldset', null, h('legend', { text: 'Add a habit' }), form),
      h('fieldset', null, h('legend', { text: 'Order' }), list),
      scheduleField(active),
      zoneField(),
      h('div', { className: 'status-bar' }, status),
    );
  }

  // Each habit's schedule: pick the habit, then the days.
  function scheduleField(active: Habit[]): HTMLElement | string {
    if (!active.length) return '';
    if (!active.some((x) => x.id === scheduleFor)) scheduleFor = active[0].id;
    const id = nextId('schedule-habit');
    const select = h(
      'select',
      { id, className: 'schedule-habit' },
      ...active.map((x) => h('option', { value: String(x.id), text: `${x.label} — ${describeSchedule(x.schedule)}`, selected: x.id === scheduleFor })),
    );
    select.value = String(scheduleFor);
    const picker = schedulePicker(
      ctx,
      () => latest.find((x) => x.id === scheduleFor && !x.retiredAt) ?? null,
      (t) => {
        status.textContent = t;
        void load();
      },
    );
    select.addEventListener('change', () => {
      scheduleFor = Number(select.value);
      picker.sync(true);
    });
    picker.sync(true);
    return h(
      'div',
      { className: 'setup-schedule' },
      h('div', { className: 'field-row' }, h('label', { htmlFor: id, text: 'Habit:' }), select),
      picker.el,
    );
  }

  // The app time zone: where every day starts and ends, for the deck, History,
  // the clock and the API. Saving restarts the desktop, which reads it once.
  function zoneField(): HTMLElement {
    const id = nextId('zone');
    const zones = timeZones(ctx.zone);
    const select = h(
      'select',
      { id, className: 'zone-select' },
      ...zones.map((z) => h('option', { value: z, text: z.replace(/_/g, ' '), selected: z === ctx.zone })),
    );
    select.value = ctx.zone;
    const set = h('button', { type: 'submit', text: 'Set', className: 'zone-set' });
    const form = h(
      'form',
      { className: 'zone-form', attrs: { novalidate: '' } },
      h('label', { htmlFor: id, text: 'Time zone:' }),
      h('div', { className: 'field-row' }, select, set),
      h('p', { className: 'zone-note', text: `Days start and end at midnight here. Now: ${ctx.zone.replace(/_/g, ' ')}.` }),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const zone = select.value;
      if (busy || zone === ctx.zone) return;
      busy = true;
      const ok = await ctx.guard(() => ctx.api.setTimezone(zone), "Couldn't set the time zone");
      busy = false;
      if (ok) {
        status.textContent = `Time zone set to ${zone.replace(/_/g, ' ')}. Restarting…`;
        await ctx.restart();
      }
    });
    return h('fieldset', null, h('legend', { text: 'Time zone' }), form);
  }

  void load();
}

// Every IANA zone this browser knows, with `current` always among them.
function timeZones(current: string): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    /* an older browser: just the current one */
  }
  return all.includes(current) ? all : [current, ...all];
}

// ── Retired habits ────────────────────────────────────────────────────────
export function openRetiredWindow(ctx: Ctx, opener: HTMLElement | null): void {
  const win = openFloat({ key: 'retired', title: 'Retired habits', className: 'retired-window', opener, isPhone: ctx.isPhone });
  if (win.body.dataset.ready) return;
  win.body.dataset.ready = '1';
  win.body.replaceChildren(h('p', { className: 'loading', text: 'Loading…' }));
  const status = h('p', { className: 'status-bar-field', attrs: { role: 'status' } });

  async function load() {
    const habits = await ctx.guard(() => ctx.api.habits());
    if (!habits || !win.isOpen()) return;
    const retired = habits.filter((x) => x.retiredAt);
    win.body.replaceChildren(
      retired.length
        ? h(
            'ul',
            { className: 'setup-list retired-list', attrs: { 'aria-label': 'Retired habits' } },
            ...retired.map((habit) =>
              h(
                'li',
                { className: 'setup-row', dataset: { slug: habit.slug } },
                h('span', { className: 'setup-label', text: habit.label }),
                h('button', {
                  type: 'button',
                  className: 'unretire-btn',
                  text: 'Unretire',
                  on: {
                    click: async () => {
                      const r = await ctx.guard(() => ctx.api.patchHabit(habit.id, { retired: false }), "Couldn't unretire");
                      if (!r) return;
                      await ctx.store.load(ctx.store.state.date);
                      await load();
                      status.textContent = `"${habit.label}" is back on the desktop`;
                    },
                  },
                }),
              ),
            ),
          )
        : h('p', { className: 'empty', text: 'No retired habits.' }),
      h('div', { className: 'status-bar' }, status),
    );
    recenter(win);
  }
  void load();
}

// ── Display Properties ────────────────────────────────────────────────────
// A preview monitor and the wallpaper list, the animation checkbox, and
// OK / Cancel / Apply. Only Apply and OK change the desktop and remember it.
export function openDisplayWindow(
  current: () => { wallpaper: Wallpaper; animate: boolean },
  apply: (v: { wallpaper: Wallpaper; animate: boolean }) => void,
  opener: HTMLElement | null,
  isPhone: () => boolean,
): void {
  const win = openFloat({ key: 'display', title: 'Display Properties', className: 'display-window', opener, isPhone });
  if (win.body.dataset.ready) return;
  win.body.dataset.ready = '1';
  let pick = current();

  const screen = h('div', { className: 'monitor-screen' });
  const monitor = h('div', { className: 'monitor', attrs: { 'aria-hidden': 'true' } }, screen, h('div', { className: 'monitor-stand' }));
  const listId = nextId('wp-list');
  const options = WALLPAPERS.map((w) =>
    h('li', {
      className: 'wp-option',
      id: `${listId}-${w.id}`,
      text: w.label,
      dataset: { wallpaper: w.id },
      attrs: { role: 'option' },
    }),
  );
  const list = h(
    'ul',
    { className: 'wp-list', id: listId, tabIndex: 0, attrs: { role: 'listbox', 'aria-label': 'Wallpaper' } },
    ...options,
  );
  const animId = nextId('animate');
  const anim = h('input', { type: 'checkbox', id: animId, className: 'animate-box' });
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ok = h('button', { type: 'button', className: 'default', text: 'OK', dataset: { act: 'ok' } });
  const cancel = h('button', { type: 'button', text: 'Cancel', dataset: { act: 'cancel' } });
  const applyBtn = h('button', { type: 'button', text: 'Apply', dataset: { act: 'apply' }, disabled: true });

  function sync() {
    screen.className = `monitor-screen wp-${pick.wallpaper}`;
    for (const o of options) {
      const on = o.dataset.wallpaper === pick.wallpaper;
      o.setAttribute('aria-selected', String(on));
      o.classList.toggle('selected', on);
    }
    list.setAttribute('aria-activedescendant', `${listId}-${pick.wallpaper}`);
    anim.checked = pick.animate;
    const saved = current();
    applyBtn.disabled = saved.wallpaper === pick.wallpaper && saved.animate === pick.animate;
  }
  options.forEach((o) =>
    o.addEventListener('click', () => {
      pick = { ...pick, wallpaper: o.dataset.wallpaper as Wallpaper };
      list.focus();
      sync();
    }),
  );
  list.addEventListener('keydown', (e) => {
    const i = WALLPAPERS.findIndex((w) => w.id === pick.wallpaper);
    let j = i;
    if (e.key === 'ArrowDown') j = Math.min(WALLPAPERS.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = WALLPAPERS.length - 1;
    else return;
    e.preventDefault();
    pick = { ...pick, wallpaper: WALLPAPERS[j].id };
    sync();
  });
  anim.addEventListener('change', () => {
    pick = { ...pick, animate: anim.checked };
    sync();
  });
  ok.addEventListener('click', () => {
    apply(pick);
    win.close();
  });
  cancel.addEventListener('click', () => win.close());
  applyBtn.addEventListener('click', () => {
    apply(pick);
    sync();
  });

  const hint =
    reduce || isPhone()
      ? h('p', { className: 'hint', text: reduce ? 'Motion is off: this device asks for reduced motion.' : 'No motion on a phone.' })
      : '';
  win.body.replaceChildren(
    monitor,
    h('fieldset', null, h('legend', { text: 'Wallpaper' }), list),
    h(
      'div',
      { className: 'field-row animate-row' },
      anim,
      h('label', { htmlFor: animId, text: 'Animate wallpaper (Synthwave)' }),
    ),
    hint,
    h('div', { className: 'dialog-buttons' }, ok, cancel, applyBtn),
  );
  sync();
}

// ── Keyboard help ─────────────────────────────────────────────────────────
export function openHelpWindow(opener: HTMLElement | null, isPhone: () => boolean): void {
  const win = openFloat({ key: 'help', title: 'Keyboard', className: 'help-window', opener, isPhone });
  if (win.body.dataset.ready) return;
  win.body.dataset.ready = '1';
  const row = (k: string, what: string) => h('tr', null, h('th', { attrs: { scope: 'row' } }, h('kbd', { text: k })), h('td', { text: what }));
  win.body.replaceChildren(
    h(
      'table',
      { className: 'keys-table' },
      h(
        'tbody',
        null,
        row('1 – 9', 'Check or uncheck that habit'),
        row('N', "Go to the day's note"),
        row('[  ]', 'Previous / next day (back 30 days)'),
        row(']', 'In AI Wire: the next article'),
        row('Alt + arrows', 'Move the focused window (on its title bar)'),
        row('?', 'This window'),
        row('Esc', 'Close a window or menu'),
      ),
    ),
    h('p', { className: 'hint', text: 'Keys are ignored while you type in a field.' }),
    h('div', { className: 'dialog-buttons' }, h('button', { type: 'button', className: 'default', text: 'OK', on: { click: () => win.close() } })),
  );
}
