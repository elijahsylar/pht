import { dayLabel, shortDate } from '../lib/dates';
import { h } from '../lib/dom';
import type { Ctx } from '../ui/context';

const DAYS_PHONE = 7;
// The day columns follow the window's width (px): every day in the range (30
// plus the read-only day 31) from FULL_W, the last 14 from MID_W, else 7.
const FULL_W = 460;
const MID_W = 300;
// Below this height (px) the LEDs get shorter.
const SHORT_H = 460;

// History: an LED matrix, one row per active habit, today's column ringed in
// amber and the Mondays dated above; three LCD stats (30 days); and the
// range's notes on lined J-card paper filling the rest, newest first. Drawn
// from the shared store, so a check on Today lights its LED here at once.
//
// Every LED from today back 30 days is a toggle button that backfills that
// day (optimistic, rolled back on failure). The matrix shows one more day,
// dimmed and inert: day 31 is read-only. Above the matrix, each column's
// header opens that day in the Today deck. A narrow window shows the last 14
// or 7 days, a phone 7; at short heights the notes shrink first, then the
// window scrolls. `onDays` gets the number of days shown, for the title.
export function mountHistory(ctx: Ctx, body: HTMLElement, onDays: (n: number) => void): { relayout(): void; fit(w: number, h: number): void } {
  const { store } = ctx;
  const matrix = h('div', { className: 'matrix' });
  const stat = (cls: string, label: string) => {
    const value = h('span', { className: 'lcd-value' });
    const box = h(
      'div',
      { className: `lcd stat ${cls}`, attrs: { role: 'group', 'aria-label': label } },
      value,
      h('span', { className: 'lcd-label', text: label }),
    );
    return { box, value };
  };
  const pct = stat('stat-pct', '30-day completion');
  const best = stat('stat-best', 'Best live streak');
  const all = stat('stat-all', 'All-done days');
  const notes = h('ol', { className: 'notes-list', attrs: { 'aria-label': 'Notes, newest first' } });
  const paper = h('div', { className: 'jcard-paper', tabIndex: 0, attrs: { role: 'region', 'aria-label': 'Notes' } }, notes);

  const deck = h('div', { className: 'hist-deck' }, matrix, h('div', { className: 'stats' }, pct.box, best.box, all.box), paper);
  body.replaceChildren(deck);
  let width = Infinity;
  let shown = 0;
  onDays(ctx.isPhone() ? DAYS_PHONE : 30);

  function paintMatrix() {
    const hist = store.state.history;
    if (!hist) return;
    const want = ctx.isPhone() ? DAYS_PHONE : width >= FULL_W ? hist.dates.length : width >= MID_W ? 14 : 7;
    const n = Math.min(want, hist.dates.length);
    if (n !== shown) {
      shown = n;
      // The full range is 30 days and the read-only day 31 (and today).
      onDays(n === hist.dates.length ? 30 : n);
    }
    const dates = hist.dates.slice(-n);
    const { date: today, view } = store.state;
    const earliest = store.earliest();
    matrix.style.setProperty('--days', String(n));

    // A rebuild must not lose the keyboard's place on an LED or a header day.
    const was = document.activeElement as HTMLElement | null;
    const refocus = was && matrix.contains(was) ? `${was.className.split(' ')[0]}|${was.dataset.habitId ?? ''}|${was.dataset.date}` : null;

    // Header: a button per writable day (opens it in Today), the Mondays dated.
    const head = h('div', { className: 'mrow mhead', attrs: { role: 'group', 'aria-label': 'Open a day in Today' } }, h('span', { className: 'mlabel' }));
    dates.forEach((d, i) => {
      const monday = new Date(`${d}T00:00:00Z`).getUTCDay() === 1;
      // A label with fewer than three columns left would be cut off.
      const text = monday && n - i >= 3 ? shortDate(d).toUpperCase() : '';
      if (d < earliest) {
        head.append(h('span', { className: 'mday old', dataset: { date: d } }, h('span', { className: 'mdate', text, dataset: { text } })));
        return;
      }
      const b = h(
        'button',
        {
          type: 'button',
          className: `mday${d === view && view !== today ? ' viewing' : ''}`,
          title: `Open ${dayLabel(d)} in Today`,
          dataset: { date: d },
          attrs: { 'aria-label': `Open ${dayLabel(d)} in Today` },
        },
        h('span', { className: 'mdate', text, dataset: { text }, attrs: { 'aria-hidden': 'true' } }),
      );
      b.addEventListener('click', () => ctx.openDay(d));
      head.append(b);
    });

    const rows = hist.habits.map((habit) => {
      const flags = habit.done.slice(-n);
      // Rest days (due false) are drawn hatched: not done, but not missed.
      const dues = habit.due ? habit.due.slice(-n) : flags.map(() => true);
      const doneN = flags.filter((on, i) => on && dues[i]).length;
      const dueN = dues.filter(Boolean).length;
      return h(
        'div',
        {
          className: 'mrow',
          dataset: { habitId: String(habit.id), slug: habit.slug },
          attrs: { role: 'group', 'aria-label': `${habit.label}, last ${n} days: ${doneN} of ${dueN} due days done` },
        },
        h('span', { className: 'mlabel', text: habit.label, attrs: { 'aria-hidden': 'true' } }),
        ...flags.map((on, i) => {
          const d = dates[i];
          const rest = !dues[i];
          const cls = `led${on ? ' on' : ''}${rest ? ' rest' : ''}${d === today ? ' today' : ''}${d === view && view !== today ? ' viewing' : ''}`;
          const data = { habitId: String(habit.id), date: d, on: String(on), due: String(!rest) };
          const restWord = rest ? ' (rest day)' : '';
          // Day 31 and older: read-only, shown dimmed.
          if (d < earliest) {
            return h('span', { className: `${cls} old`, title: `${habit.label}, ${dayLabel(d)}${restWord}: read-only`, dataset: data, attrs: { 'aria-hidden': 'true' } });
          }
          const b = h('button', {
            type: 'button',
            className: cls,
            title: `${habit.label}, ${dayLabel(d)}${restWord}: ${on ? 'done' : 'not done'}`,
            dataset: data,
            attrs: { 'aria-pressed': String(on), 'aria-label': `${habit.label}, ${dayLabel(d)}${restWord}` },
          });
          b.addEventListener('click', () => store.toggle(habit.id, d));
          return b;
        }),
      );
    });
    matrix.replaceChildren(head, ...rows);
    fitDates();
    if (refocus) {
      const [cls, id, d] = refocus.split('|');
      const sel = id ? `button.${cls}[data-habit-id="${id}"][data-date="${d}"]` : `button.${cls}[data-date="${d}"]`;
      matrix.querySelector<HTMLElement>(sel)?.focus();
    }

    pct.value.textContent = `${hist.stats.completionPct}%`;
    best.value.textContent = String(hist.stats.bestLiveStreak);
    all.value.textContent = String(hist.stats.allDoneDays);
    pct.box.setAttribute('aria-label', `${hist.dates.length}-day completion: ${hist.stats.completionPct}%`);
    best.box.setAttribute('aria-label', `Best live streak: ${hist.stats.bestLiveStreak} days`);
    all.box.setAttribute('aria-label', `All habits done on ${hist.stats.allDoneDays} of the last ${hist.dates.length} days`);
  }

  // A Monday's date runs right over the next cells; one that would run past
  // the matrix (narrow cells near the end) is left out.
  function fitDates() {
    const right = matrix.getBoundingClientRect().right;
    for (const el of matrix.querySelectorAll<HTMLElement>('.mdate')) {
      el.textContent = el.dataset.text ?? '';
      if (el.textContent && el.getBoundingClientRect().right > right) el.textContent = '';
    }
  }

  function paintNotes() {
    const list = [...store.state.notes].reverse();
    notes.replaceChildren(
      ...list.map((n) =>
        h(
          'li',
          { dataset: { date: n.date } },
          h('span', { className: 'note-date', text: shortDate(n.date) }),
          h('span', { className: 'note-line', text: n.line }),
        ),
      ),
    );
    if (!list.length) notes.append(h('li', { className: 'empty', text: 'No notes in the last 30 days.' }));
  }

  store.subscribe((c) => {
    if (c.kind === 'notes') return paintNotes();
    paintMatrix();
    if (c.kind === 'load') paintNotes();
  });

  return {
    relayout: paintMatrix,
    fit(w, hgt) {
      deck.classList.toggle('short', !ctx.isPhone() && hgt < SHORT_H);
      const was = width >= FULL_W ? 2 : width >= MID_W ? 1 : 0;
      width = w;
      const now = width >= FULL_W ? 2 : width >= MID_W ? 1 : 0;
      if (now !== was) paintMatrix();
      else fitDates();
    },
  };
}
