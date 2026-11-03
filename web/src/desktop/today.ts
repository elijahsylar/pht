import type { TodayHabit } from '../lib/api';
import { longDate, shortDate } from '../lib/dates';
import { h, nextId } from '../lib/dom';
import type { Change } from '../state/store';
import type { Ctx } from '../ui/context';

const NOTE_MAX = 280;
const LEARNED_MAX = 500;
const NOTE_DEBOUNCE_MS = 800;
const METER_FULL = 14;
const METER_SHORT = 7;
// Below this window height (px) the deck goes compact: shorter strips and
// keys, 7-LED meters, the strip list scrolling above a J-card that stays.
export const TODAY_COMPACT_H = 600;
// At or below this width the meters show 7 LEDs.
const METER_NARROW_W = 350;

export interface TodayWindow {
  // The note field, for the N shortcut.
  note: HTMLInputElement;
  // SIDE B: "What new thing did I learn today?"
  learned: HTMLInputElement;
  // The TODAY LCD, which the all-done moment takes over for a few seconds.
  lcd: HTMLElement;
  flashLcd(text: string, ms: number): void;
  // Flush an unsaved note and learned entry now (leaving the day, logging
  // off, midnight).
  flushNote(): Promise<void>;
  // An edit is in progress in either J-card: a refresh must not replace it.
  noteDirty(): boolean;
  // Phone ↔ desktop: meters change length.
  relayout(): void;
  // The window is now `w` × `h` px.
  fit(w: number, h: number): void;
}

// Moving the deck between days is the desktop's job (it owns the URL).
export interface DayNav {
  // Show the day `days` away from the one showing, within the window.
  step(days: number): void;
  toToday(): void;
}

// The "PHT-6" deck: one channel strip per active habit — a latching key, the
// name (opens Info), a 14-LED meter of the last 14 days (7 on a phone, in a
// narrow window or a short one) and a red 7-segment streak counter — and two
// cassette J-cards: SIDE A, the day's note, and under it SIDE B, what was
// learned that day. A short window makes the deck compact.
//
// It shows today, or a past day up to 30 back (◀ ▶ beside the date, [ and ]):
// then the deck turns amber, the LCD says "EDITING OCT 13", and the keys, the
// meters' ring and both J-cards all work on that day.
//
// Drawn from the shared store. Strips are rebuilt only when the habit list
// itself changes (ids, order, labels); a check updates the existing elements,
// so nothing is replaced under the user's finger.
export function mountToday(ctx: Ctx, body: HTMLElement, setTitle: (t: string) => void, nav: DayNav): TodayWindow {
  const { store } = ctx;

  const dateLine = h('div', { className: 'deck-date' });
  const prevBtn = h('button', { type: 'button', className: 'day-step day-prev', text: '◀', title: 'Previous day ( [ )', attrs: { 'aria-label': 'Previous day' } });
  const nextBtn = h('button', { type: 'button', className: 'day-step day-next', text: '▶', title: 'Next day ( ] )', attrs: { 'aria-label': 'Next day' } });
  const backBtn = h('button', { type: 'button', className: 'back-today', text: 'Back to today', hidden: true });
  prevBtn.addEventListener('click', () => nav.step(-1));
  nextBtn.addEventListener('click', () => nav.step(1));
  backBtn.addEventListener('click', () => nav.toToday());
  const lcd = h('div', { className: 'lcd today-lcd', attrs: { role: 'status', 'aria-live': 'off' } });
  const strips = h('ul', { className: 'strips', attrs: { 'aria-label': 'Habits' } });
  const noteId = nextId('note');
  const sideLabel = h('label', { className: 'jcard-side', htmlFor: noteId });
  const note = h('input', {
    type: 'text',
    id: noteId,
    className: 'note-input',
    maxLength: NOTE_MAX,
    placeholder: 'One line for today…',
    autocomplete: 'off',
    disabled: true,
  });
  const learnedId = nextId('learned');
  const sideBLabel = h('label', { className: 'jcard-side', htmlFor: learnedId });
  const learned = h('input', {
    type: 'text',
    id: learnedId,
    className: 'learned-input',
    maxLength: LEARNED_MAX,
    placeholder: 'What new thing did I learn today?',
    autocomplete: 'off',
    disabled: true,
  });
  const status = h('p', { className: 'status-bar-field today-status', attrs: { role: 'status' } });

  const deck = h(
    'div',
    { className: 'deck' },
    h(
      'div',
      { className: 'deck-head' },
      h(
        'div',
        { className: 'brand' },
        h('span', { className: 'brand-name', text: 'PHT-6' }),
        h('div', { className: 'day-nav', attrs: { role: 'group', 'aria-label': 'Day' } }, prevBtn, dateLine, nextBtn),
      ),
      h('div', { className: 'deck-lcd' }, lcd, backBtn),
    ),
    strips,
    h('div', { className: 'jcard jcard-a' }, sideLabel, note),
    h('div', { className: 'jcard jcard-b' }, sideBLabel, learned),
  );
  body.replaceChildren(deck, h('div', { className: 'status-bar' }, status));

  // ── J-card autosave ──────────────────────────────────────────────────────
  // Debounced while typing, flushed on blur, Enter, Log Off and midnight. Only
  // the latest value is sent, only if it differs from what is saved, and
  // always to the date the field belongs to. The same for both sides.
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

  function jcardField(
    input: HTMLInputElement,
    o: {
      // Save `text` for `date`; the saved value, or undefined when it failed.
      put: (date: string, text: string) => Promise<string | undefined>;
      saving: string;
      saved: string;
      failed: string;
    },
  ) {
    let date = '';
    let saved = '';
    let timer: number | undefined;
    let inFlight: Promise<void> | null = null;

    async function save(): Promise<void> {
      window.clearTimeout(timer);
      timer = undefined;
      if (inFlight) await inFlight;
      const text = clean(input.value);
      const forDate = date;
      if (!forDate || text === saved) return;
      ctx.status(o.saving);
      inFlight = (async () => {
        const r = await o.put(forDate, text);
        if (r !== undefined) {
          if (forDate === date) saved = r;
          ctx.status(o.saved);
        } else {
          ctx.status(o.failed);
        }
      })();
      await inFlight;
      inFlight = null;
    }

    input.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void save(), NOTE_DEBOUNCE_MS);
    });
    input.addEventListener('blur', () => void save());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
    });

    const dirty = () =>
      document.activeElement === input || timer !== undefined || inFlight !== null || clean(input.value) !== saved;

    return {
      dirty,
      async flush() {
        if (!input.disabled && (timer !== undefined || clean(input.value) !== saved)) await save();
        else if (inFlight) await inFlight;
      },
      // The field now belongs to `view`: take that day's saved value, unless
      // an edit to this same day is in progress.
      take(view: string, value: string) {
        if (view !== date) {
          date = view;
          saved = value;
          input.value = saved;
        } else if (!dirty()) {
          saved = value;
          input.value = saved;
        }
        input.disabled = false;
      },
    };
  }

  const sideA = jcardField(note, {
    put: async (date, line) => {
      const r = await ctx.guard(() => ctx.api.putNote(date, line), "Couldn't save the note");
      if (!r) return undefined;
      store.noteSaved(date, r.line);
      return r.line ?? '';
    },
    saving: 'Saving note…',
    saved: 'Note saved',
    failed: 'Note not saved',
  });
  const sideB = jcardField(learned, {
    put: async (date, text) => {
      const r = await ctx.guard(() => ctx.api.putLearned(date, text), "Couldn't save what you learned");
      if (!r) return undefined;
      store.learnedSaved(date, r.text);
      return r.text ?? '';
    },
    saving: 'Saving SIDE B…',
    saved: 'SIDE B saved',
    failed: 'SIDE B not saved',
  });

  const noteDirty = () => sideA.dirty() || sideB.dirty();

  // ── strips ─────────────────────────────────────────────────────────────────
  interface Strip {
    li: HTMLLIElement;
    key: HTMLButtonElement;
    keyText: HTMLSpanElement;
    name: HTMLButtonElement;
    meter: HTMLDivElement;
    seg: HTMLDivElement;
    segVal: HTMLSpanElement;
    segGhost: HTMLSpanElement;
  }
  let built = '';
  let lcdOverride: string | null = null;
  let lcdTimer: number | undefined;
  const byId = new Map<number, Strip>();

  function strip(habit: TodayHabit): Strip {
    const keyText = h('span', { className: 'key-text' });
    const key = h(
      'button',
      { type: 'button', className: 'key', dataset: { habitId: String(habit.id) } },
      h('span', { className: 'lamp', attrs: { 'aria-hidden': 'true' } }),
      keyText,
    );
    key.addEventListener('click', () => store.toggle(habit.id));
    const name = h('button', {
      type: 'button',
      className: 'habit-name',
      text: habit.label,
      title: `About ${habit.label}`,
    });
    name.addEventListener('click', () => ctx.openInfo(habit.id, name));
    const meter = h('div', { className: 'meter', attrs: { role: 'img' } });
    const segGhost = h('span', { className: 'seg-ghost', attrs: { 'aria-hidden': 'true' } });
    const segVal = h('span', { className: 'seg-val', attrs: { 'aria-hidden': 'true' } });
    const seg = h('div', { className: 'seg7', attrs: { role: 'img' } }, segGhost, segVal);
    const li = h(
      'li',
      { className: 'strip', dataset: { habitId: String(habit.id), slug: habit.slug } },
      key,
      name,
      meter,
      seg,
    );
    return { li, key, keyText, name, meter, seg, segVal, segGhost };
  }

  let compact = false;
  let narrow = false;
  function paint() {
    const t = store.state.today;
    const hist = store.state.history;
    if (!t) return;
    const { view, date: today } = store.state;
    const past = view !== today;
    const dayWord = shortDate(view).toUpperCase();
    const sig = t.habits.map((x) => `${x.id}:${x.label}`).join('|');
    if (sig !== built) {
      built = sig;
      byId.clear();
      const els = t.habits.map((habit) => {
        const s = strip(habit);
        byId.set(habit.id, s);
        return s.li;
      });
      strips.replaceChildren(...els);
      if (!t.habits.length) {
        strips.append(h('li', { className: 'empty', text: 'No habits yet. Add one from Start → Setup.' }));
      }
    }

    const n = ctx.isPhone() || compact || narrow ? METER_SHORT : METER_FULL;
    for (const habit of t.habits) {
      const s = byId.get(habit.id);
      if (!s) continue;
      // A rest day (the schedule leaves it out): REST, dimmed, still checkable.
      const rest = habit.due === false;
      s.li.classList.toggle('done', habit.done);
      s.li.classList.toggle('rest', rest);
      s.key.setAttribute('aria-pressed', String(habit.done));
      const when = past ? `on ${longDate(view)}` : 'today';
      s.key.setAttribute('aria-label', `${habit.label}: done ${when}${rest ? ` (rest day ${when})` : ''}`);
      s.keyText.textContent = habit.done ? 'DONE' : rest ? 'REST' : past ? dayWord : 'TODAY';

      // LEDs: lit = done that day, dark = missed, hatched = a rest day (not
      // missed); today's has the amber ring.
      const row = hist?.habits.find((x) => x.id === habit.id);
      const flags = row ? row.done.slice(-n) : [];
      const dues = row?.due ? row.due.slice(-n) : flags.map(() => true);
      const dates = hist ? hist.dates.slice(-n) : [];
      const leds = flags.map((on, i) =>
        h('span', {
          className: `led${on ? ' on' : ''}${dues[i] ? '' : ' rest'}${dates[i] === today ? ' today' : ''}${past && dates[i] === view ? ' viewing' : ''}`,
          dataset: { date: dates[i], on: String(on), due: String(dues[i]) },
        }),
      );
      s.meter.replaceChildren(...leds);
      const doneN = flags.filter((on, i) => on && dues[i]).length;
      const dueN = dues.filter(Boolean).length;
      const restN = flags.length - dueN;
      s.meter.setAttribute(
        'aria-label',
        `Last ${flags.length} days: ${doneN} of ${dueN} due days done${restN ? `, ${restN} rest ${restN === 1 ? 'day' : 'days'}` : ''}`,
      );
      s.meter.title = `${dates.length ? shortDate(dates[0]) : ''} – today: ${doneN} of ${dueN} due${restN ? ` · ${restN} rest` : ''}`;

      const digits = habit.streak >= 100 ? 3 : 2;
      s.segVal.textContent = String(habit.streak).padStart(digits, '0');
      s.segGhost.textContent = '8'.repeat(digits);
      s.seg.classList.toggle('zero', habit.streak === 0);
      s.seg.setAttribute('aria-label', `Streak ${habit.streak} ${habit.streak === 1 ? 'day' : 'days'}`);
    }

    deck.classList.toggle('editing', past);
    // Counts are of the habits due that day: a rest day is not owed.
    const doneN = t.dueDone ?? t.doneCount;
    const dueN = t.dueCount ?? t.total;
    const restN = t.total - dueN;
    const rests = restN ? `, ${restN} resting` : '';
    lcd.textContent = lcdOverride ?? (past ? `EDITING ${dayWord}` : `TODAY ${doneN}/${dueN}`);
    lcd.setAttribute(
      'aria-label',
      past ? `Editing ${longDate(view)}: ${doneN} of ${dueN} done${rests}` : `Today ${doneN} of ${dueN} done${rests}`,
    );
    setTitle(past ? `${shortDate(view)} (${doneN}/${dueN})` : `Today (${doneN}/${dueN})`);
  }

  // The date line, the stepper's limits, the J-card's side and Back to today.
  function paintDay() {
    const { view, date: today } = store.state;
    dateLine.textContent = longDate(view);
    sideLabel.textContent = `SIDE A · ${shortDate(view)}`;
    note.placeholder = view === today ? 'One line for today…' : `One line for ${shortDate(view)}…`;
    sideBLabel.textContent = 'SIDE B · LEARNED';
    learned.placeholder = view === today ? 'What new thing did I learn today?' : `What new thing did I learn on ${shortDate(view)}?`;
    prevBtn.disabled = view <= store.earliest();
    nextBtn.disabled = view >= today;
    backBtn.hidden = view === today;
  }

  // Both J-cards now belong to the deck's day.
  function takeNote() {
    const st = store.state;
    sideA.take(st.view, st.today?.note ?? '');
    sideB.take(st.view, st.today?.learned ?? '');
  }

  function onChange(c: Change) {
    const st = store.state;
    if (c.kind === 'load' || c.kind === 'view') {
      paintDay();
      takeNote();
    }
    // A key with its request out shows it (and ignores presses: the store
    // allows one request per habit at a time).
    if ((c.kind === 'toggle' || c.kind === 'rollback' || c.kind === 'confirmed') && c.date === st.view) {
      byId.get(c.habitId)?.key.classList.toggle('busy', c.kind === 'toggle');
    }
    if (c.kind !== 'notes' && c.kind !== 'learned') paint();
  }
  store.subscribe(onChange);

  return {
    note,
    learned,
    lcd,
    flashLcd(text, ms) {
      window.clearTimeout(lcdTimer);
      lcdOverride = text;
      lcd.classList.add('flash');
      paint();
      lcdTimer = window.setTimeout(() => {
        lcdOverride = null;
        lcd.classList.remove('flash');
        paint();
      }, ms);
    },
    flushNote: async () => {
      await Promise.all([sideA.flush(), sideB.flush()]);
    },
    noteDirty,
    relayout: paint,
    fit(w, hgt) {
      const c = !ctx.isPhone() && hgt < TODAY_COMPACT_H;
      const nw = w <= METER_NARROW_W;
      deck.classList.toggle('compact', c);
      if (c === compact && nw === narrow) return;
      compact = c;
      narrow = nw;
      paint();
    },
  };
}
