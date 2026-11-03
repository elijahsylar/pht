import { ApiError, type Article, type Wire } from '../lib/api';
import { h } from '../lib/dom';
import type { Ctx } from '../ui/context';

// AI Wire: one career-focused article a day, printed on fanfold teletype
// paper — its tier as a small tag line ("CLAUDE CODE", "ANTHROPIC", "AI
// ENGINEERING"), the source and date line, the title, the excerpt (the
// feed's own description), Read and Next ▸ with "3 more in queue" beside it —
// with the last seven days below, read ones ticked. Next records the article
// as served for good and brings the next best that qualifies; at 0 it is
// disabled. `]` presses it while focus is in the window. The API
// chooses the article (GET /api/article) and every device gets the same one;
// this window never fetches anything else. Read is a real link opening in a
// new tab with rel="noopener noreferrer"; clicking it also marks the article
// read.
//
// Like Weather, its problems are a line in the window, never a dialog; only a
// 401 goes back to Login. It adapts to its size: in a short window the past
// list goes, then the excerpt is cut to a few lines, then dropped.

// Below these heights (px) the window sheds parts, in this order.
const PAST_H = 400;
const EXCERPT_H = 340;
const TINY_H = 170;
// At or below this width (px) the tractor-feed margins narrow.
const NARROW_W = 300;

// Only an http(s) link is ever put in an href.
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const stamp = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${iso}T00:00:00Z`)).toUpperCase();

export interface WireWindow {
  load(): Promise<void>;
  fit(w: number, h: number): void;
  // Next ▸, for the `]` key.
  next(): Promise<void>;
}

export function mountWire(ctx: Ctx, body: HTMLElement, onUnauthorized: () => void, setTitle: (t: string) => void): WireWindow {
  const tag = h('p', { className: 'wire-tag' });
  const meta = h('p', { className: 'wire-meta' });
  const title = h('h3', { className: 'wire-title' });
  const excerpt = h('p', { className: 'wire-excerpt' });
  const read = h('a', {
    className: 'wire-btn wire-read',
    text: 'Read',
    target: '_blank',
    rel: 'noopener noreferrer',
  });
  const skip = h('button', { type: 'button', className: 'wire-btn wire-skip wire-next', text: 'Next ▸', title: 'Next article ( ] )' });
  const queueLine = h('span', { className: 'wire-queue', attrs: { 'aria-live': 'polite' } });
  const actions = h('div', { className: 'wire-actions' }, read, skip, queueLine);
  const msg = h('p', { className: 'wire-msg', attrs: { role: 'status' } });
  const story = h('article', { className: 'wire-story', attrs: { 'aria-live': 'polite' } }, tag, meta, title, excerpt, actions);
  const pastList = h('ol', { className: 'wire-past-list' });
  const past = h(
    'section',
    { className: 'wire-past', attrs: { 'aria-label': 'Past articles, last 7 days' } },
    h('p', { className: 'wire-past-head', text: '-- PAST 7 DAYS --' }),
    pastList,
  );
  const paper = h('div', { className: 'wire-paper' }, msg, story, past);
  body.replaceChildren(h('div', { className: 'wire-feed' }, paper));

  let data: Wire | null = null;
  let busy = false;

  function say(text: string, state: string) {
    msg.textContent = text;
    msg.dataset.state = state;
    msg.hidden = !text;
  }

  function paintStory(a: Article | null) {
    story.hidden = !a;
    if (!a) return;
    const href = safeHref(a.url);
    const main = a.topics?.[0] ?? '';
    tag.textContent = main.toUpperCase();
    tag.hidden = !main;
    meta.textContent = `${a.source.toUpperCase()} · ${stamp(a.publishedAt.slice(0, 10))}`;
    title.textContent = a.title;
    excerpt.textContent = a.excerpt ?? '';
    excerpt.hidden = !a.excerpt;
    if (href) read.href = href;
    else read.removeAttribute('href');
    read.textContent = a.read ? 'Read ✓' : 'Read';
    read.setAttribute('aria-label', `Read "${a.title}" (opens in a new tab)${a.read ? ', already read' : ''}`);
    story.classList.toggle('is-read', a.read);
    story.dataset.date = a.date;
  }

  function paintPast(list: Article[]) {
    pastList.replaceChildren(
      ...list.map((a) => {
        const href = safeHref(a.url);
        const link = h('a', {
          className: 'wire-past-link',
          text: a.title,
          target: '_blank',
          rel: 'noopener noreferrer',
          attrs: { 'aria-label': `${a.title}, ${stamp(a.date)}${a.read ? ', read' : ''} (opens in a new tab)` },
        });
        if (href) link.href = href;
        link.addEventListener('click', () => void markRead(a.date));
        return h(
          'li',
          { className: `wire-past-item${a.read ? ' read' : ''}`, dataset: { date: a.date, read: String(a.read) } },
          h('span', { className: 'wire-tick', text: a.read ? '✓' : '·', attrs: { 'aria-hidden': 'true' } }),
          h('span', { className: 'wire-past-date', text: stamp(a.date), attrs: { 'aria-hidden': 'true' } }),
          link,
        );
      }),
    );
    if (!list.length) pastList.append(h('li', { className: 'empty', text: 'Nothing on the wire yet.' }));
  }

  function paint() {
    if (!data) return;
    if (data.status === 'no-signal' || !data.article) say('NO SIGNAL TODAY', 'no-signal');
    else say('', 'ok');
    paintStory(data.article);
    paintPast(data.past);
    const queue = data.article ? (data.queue ?? 0) : 0;
    queueLine.textContent = `${queue} more in queue`;
    queueLine.dataset.queue = String(queue);
    queueLine.hidden = !data.article;
    skip.disabled = busy || !data.article || queue === 0;
    skip.setAttribute('aria-label', `Next article, ${queue} more in queue`);
    setTitle(data.article ? `AI Wire — ${stamp(data.date)}` : 'AI Wire');
  }

  // Problems are a line in the window, never a dialog.
  function failed(err: unknown): void {
    if (err instanceof ApiError && err.kind === 'unauthorized') return onUnauthorized();
    if (err instanceof ApiError && err.kind === 'network') say("CAN'T REACH PHT", 'offline');
    else if (err instanceof ApiError && err.status === 409) say('NOTHING ELSE ON THE WIRE TODAY', 'exhausted');
    else say('THE WIRE IS DOWN', 'error');
  }

  async function markRead(date: string) {
    try {
      const r = await ctx.api.readArticle(date);
      if (!data) return;
      if (data.article?.date === date) data.article = r.article;
      data.past = data.past.map((p) => (p.date === date ? r.article : p));
      paint();
    } catch (err) {
      failed(err);
    }
  }

  read.addEventListener('click', (e) => {
    // No link (a URL that is not http(s)): nothing to open, nothing to mark.
    if (!read.hasAttribute('href') || !data?.article) {
      e.preventDefault();
      return;
    }
    void markRead(data.article.date);
  });

  async function next() {
    if (busy || !data?.article || skip.disabled) return;
    busy = true;
    skip.disabled = true;
    say('NEXT…', 'busy');
    try {
      const r = await ctx.api.skipArticle(data.article.date);
      data.article = r.article;
      data.queue = r.queue;
      busy = false;
      paint();
    } catch (err) {
      busy = false;
      // 409: nothing else qualifies after all.
      if (err instanceof ApiError && err.status === 409 && data) {
        data.queue = 0;
        paint();
      } else {
        skip.disabled = !data?.article;
      }
      failed(err);
    }
  }
  skip.addEventListener('click', () => void next());

  let seq = 0;
  async function load() {
    const mine = ++seq;
    try {
      const w = await ctx.api.article(ctx.today());
      if (mine !== seq) return;
      data = w;
      paint();
    } catch (err) {
      if (mine === seq) failed(err);
    }
  }

  say('WAITING FOR THE WIRE…', 'loading');
  story.hidden = true;
  paintPast([]);
  return {
    load,
    next,
    fit(w, hgt) {
      const phone = ctx.isPhone();
      paper.classList.toggle('no-past', !phone && hgt < PAST_H);
      paper.classList.toggle('clip-excerpt', !phone && hgt < EXCERPT_H);
      paper.classList.toggle('tiny', !phone && hgt < TINY_H);
      paper.classList.toggle('narrow', w <= NARROW_W);
    },
  };
}
