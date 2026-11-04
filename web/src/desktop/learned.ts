import { ApiError, type Learned } from '../lib/api';
import { longDate, shortDate } from '../lib/dates';
import { h } from '../lib/dom';
import type { Ctx } from '../ui/context';

// Learned: every "What new thing did I learn today?" entry (SIDE B of the
// Today deck), newest first, as date + text on the lined J-card paper, with a
// search box, the total, and "Learned something N days this month". An entry
// in the backfill window is a button that opens its day in the Today deck;
// an older one is read-only. Fifty at a time, "More…" for the next fifty.
//
// Like Weather and AI Wire, its problems are a line in the window, never a
// dialog; only a 401 goes back to Login. It adapts to its size: a short
// window drops the month line, then the search shrinks to fit.

export const LEARNED_PAGE = 50;
const SEARCH_DEBOUNCE_MS = 300;
// Below these heights (px) the window sheds parts.
const MONTH_H = 230;
const NARROW_W = 300;

export interface LearnedWindow {
  load(): Promise<void>;
  fit(w: number, h: number): void;
}

export function mountLearned(ctx: Ctx, body: HTMLElement, onUnauthorized: () => void, setTitle: (t: string) => void): LearnedWindow {
  const search = h('input', {
    type: 'search',
    className: 'learned-search',
    placeholder: 'Search…',
    autocomplete: 'off',
    attrs: { 'aria-label': 'Search what you learned' },
  });
  const count = h('p', { className: 'learned-count', attrs: { 'aria-live': 'polite' } });
  const month = h('p', { className: 'learned-month' });
  const list = h('ol', { className: 'notes-list learned-list', attrs: { 'aria-label': 'Learned, newest first' } });
  const more = h('button', { type: 'button', className: 'learned-more', text: 'More…', hidden: true });
  const paper = h('div', { className: 'jcard-paper learned-paper', tabIndex: 0, attrs: { role: 'region', 'aria-label': 'Learned entries' } }, list, more);
  const msg = h('p', { className: 'learned-msg', attrs: { role: 'status' }, hidden: true });
  const deck = h('div', { className: 'learned-deck' }, h('div', { className: 'learned-head' }, search, count), month, msg, paper);
  body.replaceChildren(deck);

  let entries: Learned[] = [];
  let total = 0;
  let query = '';
  let seq = 0;

  function say(text: string, state: string) {
    msg.textContent = text;
    msg.dataset.state = state;
    msg.hidden = !text;
  }

  function failed(err: unknown) {
    if (err instanceof ApiError && err.kind === 'unauthorized') return onUnauthorized();
    say(err instanceof ApiError && err.kind === 'network' ? "Can't reach PHT" : "Couldn't load what you learned", 'error');
  }

  const inWindow = (date: string) => date >= ctx.store.earliest() && date <= ctx.store.state.date;

  function item(e: Learned) {
    const date = h('span', { className: 'note-date', text: shortDate(e.date) });
    const text = h('span', { className: 'note-line', text: e.text });
    if (ctx.store.state.date && inWindow(e.date)) {
      const btn = h(
        'button',
        {
          type: 'button',
          className: 'learned-entry',
          // The visible date and text are the name; the title adds the action.
          title: `Open ${longDate(e.date)} in Today`,
        },
        date,
        text,
      );
      btn.addEventListener('click', () => ctx.openDay(e.date));
      return h('li', { dataset: { date: e.date } }, btn);
    }
    return h(
      'li',
      { className: 'read-only', title: 'Older than 30 days: read-only', dataset: { date: e.date } },
      date,
      text,
    );
  }

  function paint() {
    list.replaceChildren(...entries.map(item));
    if (!entries.length) {
      list.append(h('li', { className: 'empty', text: query ? `Nothing learned matches "${query}".` : 'Nothing learned yet. SIDE B of Today is for it.' }));
    }
    more.hidden = entries.length >= total;
    count.textContent = query ? `${total} found` : `${total} ${total === 1 ? 'entry' : 'entries'}`;
    setTitle(query ? `Learned — ${total} found` : 'Learned');
  }

  async function load(): Promise<void> {
    const mine = ++seq;
    const today = ctx.today();
    const first = `${today.slice(0, 8)}01`;
    try {
      const [page, thisMonth] = await Promise.all([
        ctx.api.learned({ q: query || undefined, limit: LEARNED_PAGE, offset: 0 }),
        ctx.api.learned({ from: first, to: today, limit: 1 }),
      ]);
      if (mine !== seq) return;
      entries = page.entries;
      total = page.total;
      const n = thisMonth.total;
      month.textContent = `Learned something ${n} ${n === 1 ? 'day' : 'days'} this month`;
      say('', 'ok');
      paint();
    } catch (err) {
      if (mine === seq) failed(err);
    }
  }

  more.addEventListener('click', async () => {
    const mine = seq;
    more.disabled = true;
    try {
      const page = await ctx.api.learned({ q: query || undefined, limit: LEARNED_PAGE, offset: entries.length });
      if (mine !== seq) return;
      entries = [...entries, ...page.entries];
      total = page.total;
      paint();
    } catch (err) {
      failed(err);
    } finally {
      more.disabled = false;
    }
  });

  let searchTimer: number | undefined;
  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = search.value.trim();
      void load();
    }, SEARCH_DEBOUNCE_MS);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      window.clearTimeout(searchTimer);
      query = search.value.trim();
      void load();
    }
  });

  // SIDE B saved something: show it. A new day or a reload: the buttons'
  // window moved.
  let followTimer: number | undefined;
  ctx.store.subscribe((c) => {
    if (c.kind === 'learned') {
      window.clearTimeout(followTimer);
      followTimer = window.setTimeout(() => void load(), SEARCH_DEBOUNCE_MS);
    } else if (c.kind === 'load') {
      paint();
    }
  });

  month.textContent = '';
  count.textContent = '';
  list.replaceChildren(h('li', { className: 'empty', text: 'Loading…' }));
  return {
    load,
    fit(w, hgt) {
      const phone = ctx.isPhone();
      deck.classList.toggle('no-month', !phone && hgt < MONTH_H);
      deck.classList.toggle('narrow', w <= NARROW_W);
    },
  };
}

