import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { addDays } from '../src/lib/dates.js';
import {
  EXCERPT_MAX,
  allowedHosts,
  canonicalUrl,
  classify,
  cleanUrl,
  makeExcerpt,
  mergeDuplicates,
  normalizeTitle,
  parseFeed,
  parseGithubReleases,
  parseHn,
  parseIndexPage,
  rank,
  robotsAllows,
  score,
  titleHash,
  wireConfigSchema,
  type Candidate,
} from '../src/lib/wire.js';
import {
  FETCHED_KEY,
  createWireService,
  fetchAllowed,
  loadWireConfig,
  startWireSchedule,
  type WireService,
} from '../src/lib/wireService.js';
import { createFakeStore, type FakeStore } from './fakeStore.js';
import { NOW, TODAY, bearer, fullJwt, useApp } from './helpers.js';
import {
  WIRE_FULL_CONFIG as FULL,
  WIRE_TEST_CONFIG as CFG,
  atom,
  daysAgo,
  fakeWireFetch,
  ghReleases,
  hn,
  hoursAgo,
  rss,
  type Answer,
} from './wireFixture.js';

const T = NOW.getTime();
const quiet = () => undefined;

// Nothing in this file may reach the network: the real fetch fails the test.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real network used in a test');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// The standard day of news (see the scores in "ranks what passes"):
//   A  lab, Claude Code, 1 day old, also on HN with 300 points (tracking-param URL)
//   B  lab, 2 days old, AI engineering from its excerpt only
//   C  letter, Anthropic (Claude, with coding as context) + AI engineering,
//      3 days old, also on another site with the same title (60 points)
//   D  lab, AI engineering, 4 days old, one math word in its excerpt (allowed)
//   E  HN only, a coding agent, 80 points (tier B needs 75 on HN)
// and things that must never appear: a 31-day-old post, an off-topic post, a
// chip in a title, a math-heavy excerpt, a competitor's tool, Claude Monet, an
// HN tier-B story under 75 points, a non-AI HN story, an Ask HN with no link,
// an HN story under 30 points.
function day(now: number) {
  return {
    'https://lab.test/rss.xml': rss([
      {
        title: 'Claude Code hooks in practice',
        link: 'https://lab.test/blog/hooks?utm_source=rss&utm_medium=feed',
        date: daysAgo(now, 1),
        description: '<p>We report new <b>Claude Code</b> hooks &amp; methods.</p>',
      },
      { title: 'Lab model card', link: 'https://lab.test/blog/card', date: daysAgo(now, 2), description: 'Notes on prompt engineering for the new release.' },
      { title: 'Context engineering notes', link: 'https://lab.test/blog/notes', date: daysAgo(now, 4), description: 'A short proof sketch, and why it is hard.' },
      { title: 'Ancient Claude Code post', link: 'https://lab.test/blog/old', date: daysAgo(now, 31), description: 'Old.' },
      { title: 'Lab holiday party', link: 'https://lab.test/blog/party', date: daysAgo(now, 1), description: 'Cake.' },
      { title: 'A new chip for Claude Code', link: 'https://lab.test/blog/chip', date: daysAgo(now, 1), description: 'Silicon.' },
      {
        title: 'Agentic coding, formally',
        link: 'https://lab.test/blog/formal',
        date: daysAgo(now, 1),
        description: 'A theorem and its proof, with the mathematics spelled out.',
      },
    ]),
    'https://letter.test/atom.xml': atom([
      {
        title: 'Agentic coding with Claude',
        link: 'https://letter.test/p/agentic-claude',
        date: daysAgo(now, 3),
        description: 'How to pair with <em>Claude</em> on real code.',
      },
      { title: 'Cursor tips for agentic coding', link: 'https://letter.test/p/cursor', date: daysAgo(now, 2), description: 'Rules files.' },
    ]),
    'https://hn.test/': hn([
      { title: 'Claude Code hooks in practice', url: 'http://www.lab.test/blog/hooks/?fbclid=abc#top', points: 300, date: hoursAgo(now, 20) },
      { title: 'Show HN: A coding agent for kettles', url: 'https://kettle.test/', points: 80, date: daysAgo(now, 1) },
      { title: 'Agentic Coding with Claude!', url: 'https://mirror.test/agentic-claude', points: 60, date: daysAgo(now, 3) },
      { title: 'Gardening tips', url: 'https://garden.test/', points: 500, date: daysAgo(now, 1) },
      { title: 'Ask HN: Claude?', url: null, points: 400, date: daysAgo(now, 1) },
      { title: 'A small Claude Code thing', url: 'https://small.test/', points: 29, date: daysAgo(now, 1) },
      { title: 'Claude Monet at the Met', url: 'https://monet.test/', points: 400, date: daysAgo(now, 1) },
      { title: 'Agentic coding at small shops', url: 'https://shops.test/', points: 50, date: daysAgo(now, 1) },
    ]),
  } as Record<string, Answer>;
}

// What the gate turns away in day(): left unserved once every passing story
// has been served.
const DAY_REJECTS = [
  'A new chip for Claude Code',
  'Agentic coding at small shops',
  'Agentic coding, formally',
  'Claude Monet at the Met',
  'Cursor tips for agentic coding',
  'Gardening tips',
  'Lab holiday party',
];

function service(store: FakeStore, answers: Record<string, Answer | (() => Answer)>, now = () => T, config = CFG) {
  const net = fakeWireFetch(answers);
  const wire = createWireService(store, { fetch: net.fetch, now, config: () => config, log: quiet });
  return { wire, calls: net.calls };
}

describe('URLs and titles', () => {
  it('strips tracking parameters and fragments, and normalises host and path', () => {
    const variants = [
      'https://lab.test/blog/alignment',
      'https://lab.test/blog/alignment/',
      'http://www.lab.test/blog/alignment?utm_source=rss&utm_medium=feed',
      'https://LAB.test/blog//alignment/?fbclid=abc&gclid=1#comments',
      'https://m.lab.test/blog/alignment?ref=hn&mc_cid=1',
      'https://lab.test:443/blog/alignment/index.html',
    ];
    const keys = new Set(variants.map((v) => canonicalUrl(v)));
    expect([...keys]).toEqual(['https://lab.test/blog/alignment']);
    // Real query parameters stay, in a fixed order.
    expect(canonicalUrl('https://x.test/a?b=2&a=1&utm_x=9')).toBe('https://x.test/a?a=1&b=2');
    expect(cleanUrl('https://x.test/a?id=7&utm_source=x#frag')).toBe('https://x.test/a?id=7');
    // arXiv versions and the pdf link are the same paper.
    expect(canonicalUrl('http://arxiv.org/abs/2610.00001v2')).toBe('https://arxiv.org/abs/2610.00001');
    expect(canonicalUrl('https://arxiv.org/pdf/2610.00001v1.pdf')).toBe('https://arxiv.org/abs/2610.00001');
    // Only http(s), and never with credentials in it.
    expect(canonicalUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalUrl('ftp://x.test/a')).toBeNull();
    expect(cleanUrl('https://user:pw@x.test/')).toBeNull();
  });

  it('normalises titles so the same story matches across sites', () => {
    const same = ['Agentic coding with Claude', 'Agentic Coding with Claude!', 'Show HN: Agentic coding with Claude', 'Agentic coding with Claude [pdf]', 'Agentic coding with Claude | The Letter', 'Agéntic coding with Claude'];
    expect(new Set(same.map(titleHash)).size).toBe(1);
    expect(normalizeTitle('Claude & agents')).toBe('claude and agents');
    expect(titleHash('Agentic coding with Claude')).not.toBe(titleHash('Agentic coding with Copilot'));
  });
});

describe('parsing', () => {
  it('reads RSS: link, date, and a plain-text excerpt from the description', () => {
    const [c] = parseFeed(day(T)['https://lab.test/rss.xml'] as string, { id: 'lab', name: 'Test Lab' });
    expect(c).toMatchObject({
      title: 'Claude Code hooks in practice',
      url: 'https://lab.test/blog/hooks',
      source: 'Test Lab',
      excerpt: 'We report new Claude Code hooks & methods.',
    });
    expect(c.publishedAt.getTime()).toBe(Math.floor((T - 86_400_000) / 1000) * 1000);
  });

  it('reads Atom: the alternate link, not self or replies', () => {
    const [c] = parseFeed(day(T)['https://letter.test/atom.xml'] as string, { id: 'letter', name: 'L' });
    expect(c.url).toBe('https://letter.test/p/agentic-claude');
    expect(c.excerpt).toBe('How to pair with Claude on real code.');
  });

  it('keeps the excerpt within 400 characters, cut at a word', () => {
    const long = `${'word '.repeat(200)}end`;
    const e = makeExcerpt(long) as string;
    expect([...e].length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(e.endsWith('word…')).toBe(true);
    expect(makeExcerpt('short')).toBe('short');
    expect(makeExcerpt('   ')).toBeNull();
    const [c] = parseFeed(rss([{ title: 't', link: 'https://lab.test/x', date: daysAgo(T, 1), description: `<p>${long}</p>` }]), { id: 'lab', name: 'L' });
    expect([...(c.excerpt as string)].length).toBeLessThanOrEqual(EXCERPT_MAX);
  });

  it("takes linked HN stories with at least the query's points, excerpt from HN numbers", () => {
    const json = JSON.parse(day(T)['https://hn.test/'] as string);
    expect(parseHn(json, CFG, 30).map((c) => c.title)).toEqual([
      'Claude Code hooks in practice',
      'Show HN: A coding agent for kettles',
      'Agentic Coding with Claude!',
      'Gardening tips',
      'Claude Monet at the Met',
      'Agentic coding at small shops',
    ]);
    expect(parseHn(json, CFG, 75)).toHaveLength(4);
    expect(parseHn(json, CFG, 30)[1]).toMatchObject({
      points: 80,
      source: 'Hacker News · kettle.test',
      excerpt: '80 points and 10 comments on Hacker News.',
    });
  });

  it('refuses a body that is not a feed', () => {
    expect(() => parseFeed('<html><body>hi</body></html>', { id: 'lab', name: 'L' })).toThrow();
    expect(() => parseGithubReleases('<html></html>', { id: 'r', name: 'R' })).toThrow();
  });
});

describe('GitHub releases', () => {
  const notes = (first: string) =>
    `<h2>What's changed</h2><ul><li>${first}</li><li>Fixed a crash nobody should read about</li></ul>`;
  const feed = ghReleases([
    { version: 'v1.0.3', date: '2026-10-12T10:00:00Z', notes: '<p>Security fix for the sandbox.</p><p>More detail.</p>' },
    { version: 'v1.0.2', date: '2026-10-11T20:00:00Z', notes: notes('Added <code>/review</code> & hooks') },
    { version: 'v1.0.1', date: '2026-10-11T08:00:00Z', notes: notes('Added subagents') },
    { version: 'v1.0.0', date: '2026-10-10T08:00:00Z', notes: notes('First release') },
  ]);
  const src = { id: 'releases', name: 'Claude Code releases', product: 'Claude Code' };

  it("groups a day's patch releases into one item, linked to the day's first", () => {
    const list = parseGithubReleases(feed, src);
    expect(list.map((c) => c.title)).toEqual([
      'Claude Code v1.0.3',
      'Claude Code v1.0.1–v1.0.2 (2 releases)',
      'Claude Code v1.0.0',
    ]);
    const two = list[1];
    expect(two.url).toBe('https://gh.test/anthropics/claude-code/releases/tag/v1.0.1');
    expect(two.publishedAt.toISOString()).toBe('2026-10-11T20:00:00.000Z');
    expect(two.source).toBe('Claude Code releases');
  });

  it('keeps only each release headline: the first bullet, else the first paragraph', () => {
    const list = parseGithubReleases(feed, src);
    expect(list[1].excerpt).toBe('v1.0.1: Added subagents · v1.0.2: Added /review & hooks');
    expect(list[0].excerpt).toBe('v1.0.3: Security fix for the sandbox.');
    expect(list.map((c) => c.excerpt).join(' ')).not.toMatch(/crash|More detail/);
  });

  it('a later patch the same day keeps the item URL, so it is the same story', () => {
    const before = parseGithubReleases(ghReleases([{ version: 'v1.0.1', date: '2026-10-11T08:00:00Z', notes: notes('a') }]), src);
    const after = parseGithubReleases(
      ghReleases([
        { version: 'v1.0.2', date: '2026-10-11T20:00:00Z', notes: notes('b') },
        { version: 'v1.0.1', date: '2026-10-11T08:00:00Z', notes: notes('a') },
      ]),
      src,
    );
    expect(after[0].urlHash).toBe(before[0].urlHash);
    expect(mergeDuplicates([...before, ...after], 'hn')).toHaveLength(1);
  });
});

describe('index pages and robots.txt', () => {
  const page = `<!doctype html><html><body>
<a href="/news/featured-post"><h2 class="featuredTitle">Featured: Claude in the classroom</h2>
  <p class="body">We studied how &amp; why students use Claude.</p></a>
<a href="/news/second"><div class="meta"><time class="date">Oct 11, 2026</time></div><span class="PublicationList__title">Second post</span></a>
<a href="/news/second"><span class="PublicationList__title">Second post</span><time>Oct 11, 2026</time></a>
<a href="/news/third/"><img alt="Third post, by image" src="x.svg"/><time dateTime="2026-10-09">Oct 9, 2026</time></a>
<a href="/news/undated"><h3>No date anywhere</h3></a>
<a href="/careers/jobs"><h3>Jobs</h3><time dateTime="2026-10-10">x</time></a>
<a href="https://elsewhere.test/news/x"><h3>Elsewhere</h3><time dateTime="2026-10-10">x</time></a>
<a href="/news/"><h3>All news</h3><time dateTime="2026-10-10">x</time></a>
<script>self.__next_f.push([1,"{\\"publishedOn\\":\\"2026-10-12\\",\\"slug\\":{\\"_type\\":\\"slug\\",\\"current\\":\\"featured-post\\"}}"])</script>
</body></html>`;
  const src = { id: 'news', name: 'Anthropic Test', url: 'https://www.anthropic.test/news', linkPrefix: '/news/' };

  it('reads titles, links, dates and the listing blurb from the page only', () => {
    const list = parseIndexPage(page, src);
    expect(list.map((c) => [c.title, c.url, c.publishedAt.toISOString().slice(0, 10), c.excerpt])).toEqual([
      ['Featured: Claude in the classroom', 'https://www.anthropic.test/news/featured-post', '2026-10-12', 'We studied how & why students use Claude.'],
      ['Second post', 'https://www.anthropic.test/news/second', '2026-10-11', null],
      ['Third post, by image', 'https://www.anthropic.test/news/third/', '2026-10-09', null],
    ]);
  });

  it('dates at noon UTC, so no zone moves a listing to the day before', () => {
    const [, second] = parseIndexPage(page, src);
    expect(second.publishedAt.toISOString()).toBe('2026-10-11T12:00:00.000Z');
  });

  it('a page without any of its links is an error (the layout changed)', () => {
    expect(() => parseIndexPage('<html><a href="/blog/x">x</a></html>', src)).toThrow(/no \/news\/ links/);
  });

  it('honours robots.txt: our group over *, longest match wins, Allow on a tie', () => {
    const ua = 'PHT-AI-Wire/1.0 (personal reader)';
    expect(robotsAllows('User-Agent: *\nAllow: /\n', ua, '/news')).toBe(true);
    expect(robotsAllows('', ua, '/news')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /news\n', ua, '/news')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /news\n', ua, '/engineering')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow:\n', ua, '/news')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /\nAllow: /news\n', ua, '/news')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /\nAllow: /news\n', ua, '/careers')).toBe(false);
    expect(robotsAllows('User-agent: *\nAllow: /\n\nUser-agent: pht-ai-wire\nDisallow: /\n', ua, '/news')).toBe(false);
    expect(robotsAllows('User-agent: Googlebot\nUser-agent: pht-ai-wire\nDisallow: /news # no\n', ua, '/news')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /*.json$\n', ua, '/news')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /*.json$\n', ua, '/news/a.json')).toBe(false);
  });
});

describe('the career gate', () => {
  const v = (title: string, excerpt: string | null = null, extra: Partial<Candidate> = {}, cfg = CFG) =>
    classify({ title, excerpt, ...extra }, cfg);

  it('passes tier A: Claude Code, Anthropic, Claude and MCP with AI context', () => {
    expect(v('Claude Code hooks')).toEqual({ ok: true, topics: ['Claude Code'], tier: 'A', weight: 12 });
    expect(v('Anthropic hires a chef')).toMatchObject({ ok: true, topics: ['Anthropic'], tier: 'A' });
    expect(v('Model Context Protocol, explained')).toMatchObject({ ok: true, topics: ['Anthropic'] });
    expect(v('An MCP server for your API')).toMatchObject({ ok: true, topics: ['Anthropic'] });
    expect(v('Claude writes my API docs')).toMatchObject({ ok: true, topics: ['Anthropic'] });
  });

  it('passes tier B: AI-assisted engineering, ambiguous phrases only with AI context', () => {
    expect(v('Prompt engineering for teams')).toEqual({ ok: true, topics: ['AI engineering'], tier: 'B', weight: 4 });
    expect(v('Code review in the age of AI')).toMatchObject({ ok: true, topics: ['AI engineering'] });
    expect(v('Code review checklists')).toEqual({ ok: false, reason: '"code review" without AI context' });
    expect(v('Careers after the LLM')).toMatchObject({ ok: true, topics: ['AI engineering'] });
  });

  it('rejects "Claude" as a name in a story that is not about AI', () => {
    expect(v('Claude Monet at the Met')).toEqual({ ok: false, reason: '"claude" without AI context' });
    expect(v('Claude Shannon, a life', 'The father of information theory.')).toMatchObject({ ok: false });
    // Another context keyword cannot vouch for it.
    expect(v('Claude on careers', 'Evals and code review.')).toMatchObject({ ok: false });
  });

  it("never lets a keyword vouch for itself as context", () => {
    const cfg = wireConfigSchema.parse({
      ...CFG,
      tiers: [{ tag: 'Review', tier: 'B', weight: 1, keywords: [], contextKeywords: ['code review'], context: ['code'] }],
    });
    expect(v('Code review checklists', null, {}, cfg)).toMatchObject({ ok: false });
    expect(v('Code review of generated code', null, {}, cfg)).toMatchObject({ ok: true });
  });

  it("rejects a story centred on a competitor's tool", () => {
    expect(v('Cursor tips for agentic coding')).toEqual({ ok: false, reason: 'competitor: "cursor" in title' });
    expect(v('Agentic coding notes', 'Copilot for this, Copilot for that.')).toEqual({
      ok: false,
      reason: 'competitor: 2 matches in excerpt',
    });
    // One passing mention is not "centred on" it.
    expect(v('Agentic coding notes', 'Unlike Copilot.')).toMatchObject({ ok: true });
  });

  it('passes a comparison where Claude is also a main subject', () => {
    expect(v('Claude Code vs Cursor: a month of both')).toMatchObject({ ok: true, topics: ['Claude Code'] });
    expect(v('Anthropic and Copilot, side by side')).toMatchObject({ ok: true, topics: ['Anthropic'] });
    expect(v('Agentic coding tools compared', 'Claude, Cursor and Copilot; Claude wins, Claude stays.')).toMatchObject({
      ok: true,
      topics: ['Anthropic', 'AI engineering'],
    });
    expect(v('Agentic coding tools compared', 'Claude, Cursor and Copilot side by side.')).toMatchObject({ ok: false });
  });

  it('rejects an exclude word in the title, but needs two in the excerpt', () => {
    expect(v('A proof that Claude Code is fast')).toEqual({ ok: false, reason: 'Math: "proof" in title' });
    expect(v('Anthropic IPO filing')).toEqual({ ok: false, reason: 'Business: "ipo" in title' });
    expect(v('Claude Code on one GPU')).toEqual({ ok: false, reason: 'Chips: "gpu" in title' });
    expect(v('Claude Code notes', 'With one proof sketch.')).toMatchObject({ ok: true });
    expect(v('Claude Code notes', 'A proof and a theorem.')).toEqual({ ok: false, reason: 'Math: 2 matches in excerpt' });
    // Two words from different exclude groups are one each: not enough.
    expect(v('Claude Code notes', 'A proof sketch, run on a GPU.')).toMatchObject({ ok: true });
  });

  it('matches whole words only, case-insensitively', () => {
    expect(v('A chipper Claude Code release')).toMatchObject({ ok: true });
    expect(v('Waterproof Claude Code')).toMatchObject({ ok: true });
    expect(v('CLAUDE CODE IN CAPS')).toMatchObject({ ok: true });
    expect(v('Anthropics of the deep sea')).toEqual({ ok: false, reason: 'no tier' });
    expect(v('Cursors and carets in Claude Code')).toMatchObject({ ok: true });
  });

  it('orders tiers A before B, then by strength (a title match counts double), then config order', () => {
    expect(v('Agentic coding, prompt engineering, context engineering', 'Mentions Anthropic.')).toMatchObject({
      topics: ['Anthropic', 'AI engineering'],
      tier: 'A',
      weight: 10,
    });
    expect(v('Claude Code', 'Anthropic.').ok && v('Claude Code', 'Anthropic.')).toMatchObject({ topics: ['Claude Code', 'Anthropic'] });
    expect(v('Claude Code', 'Anthropic, Anthropic.')).toMatchObject({ topics: ['Claude Code', 'Anthropic'] });
    expect(v('Claude Code', 'Anthropic, Anthropic, Anthropic.')).toMatchObject({ topics: ['Anthropic', 'Claude Code'] });
  });

  it('needs 75 points for an HN story that only reaches tier B', () => {
    const hnStory = (points: number, title = 'Agentic coding at small shops') => v(title, null, { sourceId: 'hn', points });
    expect(hnStory(50)).toEqual({ ok: false, reason: 'HN tier B under 75 points' });
    expect(hnStory(75)).toMatchObject({ ok: true });
    expect(hnStory(30, 'Claude Code at small shops')).toMatchObject({ ok: true });
    // Only HN: a feed's tier B story has no points and passes.
    expect(v('Agentic coding at small shops', null, { sourceId: 'lab' })).toMatchObject({ ok: true });
  });

  it("a source's own tag and a link on a context host count, exclusions still apply", () => {
    const f = (title: string, extra: Partial<Candidate>) => v(title, null, extra, FULL);
    expect(f('Preparing for the midterms', { sourceId: 'news' })).toMatchObject({ ok: true, topics: ['Anthropic'] });
    expect(f('Preparing for the midterms', { sourceId: 'lab' })).toEqual({ ok: false, reason: 'no tier' });
    expect(f('Anthropic Test IPO', { sourceId: 'news' })).toMatchObject({ ok: false });
    expect(f('MCP for teams', { canonicalUrl: 'https://www.anthropic.test/news/mcp' })).toMatchObject({ ok: true });
    expect(f('MCP for teams', { canonicalUrl: 'https://other.test/mcp' })).toEqual({ ok: false, reason: '"mcp" without AI context' });
    expect(f('MCP for teams', { canonicalUrl: 'https://notanthropic.test/mcp' })).toMatchObject({ ok: false });
  });
});

describe('dedupe and scoring', () => {
  const all = (now: number): Candidate[] => {
    const d = day(now);
    return [
      ...parseFeed(d['https://lab.test/rss.xml'] as string, CFG.feeds[0]),
      ...parseFeed(d['https://letter.test/atom.xml'] as string, CFG.feeds[1]),
      ...parseHn(JSON.parse(d['https://hn.test/'] as string), CFG, 30),
    ];
  };

  it('merges the same story on two sites and tracking-param variants into one', () => {
    const merged = mergeDuplicates(all(T), CFG.hackerNews.id);
    const titles = merged.map((c) => c.title);
    expect(titles.filter((t) => t === 'Claude Code hooks in practice')).toHaveLength(1);
    expect(titles.filter((t) => /agentic coding with claude/i.test(t))).toHaveLength(1);
    // The publisher's own entry leads; HN contributes its points.
    const a = merged.find((c) => c.title === 'Claude Code hooks in practice') as Candidate;
    expect(a).toMatchObject({ source: 'Test Lab', points: 300, url: 'https://lab.test/blog/hooks' });
    const c = merged.find((x) => /agentic coding with claude/i.test(x.title)) as Candidate;
    expect(c).toMatchObject({ source: 'Test Letter', points: 60 });
  });

  it('ranks what passes the gate by score: popularity (log), source weight, recency, tier; drops >30 days', () => {
    const ranked = rank(mergeDuplicates(all(T), 'hn'), CFG, T);
    expect(ranked.map((c) => [c.title, c.topics])).toEqual([
      ['Claude Code hooks in practice', ['Claude Code']], //            8 + 4·log10(300) + 5.8 + 12 ≈ 35.7
      ['Agentic coding with Claude', ['Anthropic', 'AI engineering']], // 6 + 4·log10(60) + 5.4 + 10 ≈ 28.5
      ['Lab model card', ['AI engineering']], //                         8 + 5.6 + 4 ≈ 17.6
      ['Show HN: A coding agent for kettles', ['AI engineering']], //    4·log10(80) + 5.8 + 4 ≈ 17.4
      ['Context engineering notes', ['AI engineering']], //              8 + 5.2 + 4 ≈ 17.2
    ]);
    expect(ranked[0].score).toBeCloseTo(8 + 4 * Math.log10(300) + 6 * (29 / 30) + 12, 1);
    expect(ranked[1].score).toBeCloseTo(6 + 4 * Math.log10(60) + 6 * (27 / 30) + 10, 1);
    expect(ranked.map((c) => c.tier)).toEqual(['A', 'A', 'B', 'B', 'B']);
    // 31 days old is out; 29 days old is in.
    const old = all(T).find((c) => c.title === 'Ancient Claude Code post') as Candidate;
    expect(rank([old], CFG, T)).toEqual([]);
    expect(rank([{ ...old, publishedAt: new Date(T - 29 * 86_400_000) }], CFG, T)).toHaveLength(1);
  });

  it("adds the best tier's weight: tier A outranks a far more popular tier B story", () => {
    const base = parseHn(JSON.parse(hn([{ title: 'Claude Code tips', url: 'https://x.test/', points: 40, date: daysAgo(T, 1) }])), CFG)[0];
    const b = { ...base, title: 'Agentic coding tips', titleHash: 'b', urlHash: 'b', canonicalUrl: 'https://y.test/', points: 300 };
    expect(rank([b, base], CFG, T).map((c) => c.title)).toEqual(['Claude Code tips', 'Agentic coding tips']);
    expect(score(base, CFG, T, 12) - score(base, CFG, T, 4)).toBeCloseTo(8, 5);
  });

  it('log-scales popularity: ten times the points is a fixed step, not ten times the score', () => {
    const base = parseHn(JSON.parse(hn([{ title: 'AI x', url: 'https://x.test/', points: 100, date: daysAgo(T, 1) }])), CFG)[0];
    const s100 = score(base, CFG, T);
    const s1000 = score({ ...base, points: 1000 }, CFG, T);
    const s10000 = score({ ...base, points: 10000 }, CFG, T);
    expect(s1000 - s100).toBeCloseTo(4, 5);
    expect(s10000 - s1000).toBeCloseTo(4, 5);
  });
});

describe('the wire service', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = createFakeStore({ seed: true });
  });

  it('chooses the best story once per day; a second run changes nothing and fetches nothing', async () => {
    const { wire, calls } = service(store, day(T));
    const first = await wire.ensure(TODAY);
    expect(first).toMatchObject({ title: 'Claude Code hooks in practice', source: 'Test Lab', date: TODAY });
    expect(first?.url).toBe('https://lab.test/blog/hooks');
    const n = calls.length;
    expect(n).toBe(4); // HN (two queries), two feeds
    const again = await wire.ensure(TODAY);
    expect(again).toEqual(first);
    expect(calls.length).toBe(n);
    // A second process (the job CLI) agrees and fetches nothing either.
    const other = service(store, day(T));
    expect(await other.wire.ensure(TODAY)).toEqual(first);
    expect(other.calls).toHaveLength(0);
  });

  it('every outbound request is a GET with a timeout signal and manual redirects; HN asks per-query points', async () => {
    const { wire, calls } = service(store, day(T));
    await wire.ensure(TODAY);
    for (const c of calls) {
      expect(c.init?.signal).toBeInstanceOf(AbortSignal);
      expect(c.init?.redirect).toBe('manual');
      expect(c.init?.method ?? 'GET').toBe('GET');
    }
    expect(calls.map((c) => new URL(c.url).hostname).sort()).toEqual(['hn.test', 'hn.test', 'lab.test', 'letter.test']);
    const hnCalls = calls.filter((c) => c.url.includes('hn.test')).map((c) => new URL(c.url).searchParams);
    expect(hnCalls.map((p) => [p.get('query'), p.get('numericFilters')?.split(',')[1]])).toEqual([
      ['Claude', 'points>=30'],
      ['agentic coding', 'points>=75'],
    ]);
  });

  it('records the tier tags and the source on the served article, main one first', async () => {
    const { wire } = service(store, day(T));
    expect(await wire.ensure(TODAY)).toMatchObject({ topics: ['Claude Code'], sourceId: 'lab' });
    expect(await wire.skip(TODAY)).toMatchObject({ topics: ['Anthropic', 'AI engineering'], sourceId: 'letter' });
    expect((await store.getDailyArticle(TODAY))?.topics).toEqual(['Anthropic', 'AI engineering']);
  });

  it('Next moves to the next best, the passed one stays served, until nothing is left', async () => {
    const { wire } = service(store, day(T));
    await wire.ensure(TODAY);
    const order: string[] = [];
    for (;;) {
      const next = await wire.skip(TODAY);
      if (!next) break;
      order.push(next.title);
    }
    expect(order).toEqual(['Agentic coding with Claude', 'Lab model card', 'Show HN: A coding agent for kettles', 'Context engineering notes']);
    // Nothing that passes is left: the day keeps its last article. What
    // remains unserved is only what the gate turns away.
    expect((await store.getDailyArticle(TODAY))?.title).toBe('Context engineering notes');
    expect((await store.wirePool(new Date(0))).map((c) => c.title).sort()).toEqual(DAY_REJECTS);
  });

  it('counts the queue behind the day, and Next records each pass as a dud with source and tier', async () => {
    const { wire, calls } = service(store, day(T));
    await wire.ensure(TODAY);
    const fetched = calls.length;
    expect(await wire.queue()).toBe(4);
    await wire.skip(TODAY);
    expect(await wire.queue()).toBe(3);
    await wire.skip(TODAY);
    expect(await wire.queue()).toBe(2);
    expect(calls.length).toBe(fetched); // counting fetches nothing
    const duds = await store.listWireDuds('2000-01-01');
    expect(duds.map((d) => [d.title, d.sourceId, d.source, d.tier])).toEqual([
      ['Agentic coding with Claude', 'letter', 'Test Letter', 'Anthropic'],
      ['Claude Code hooks in practice', 'lab', 'Test Lab', 'Claude Code'],
    ]);
    // A re-pick after a rules change (wireJob --repick) is not a dud.
    await wire.skip(TODAY, { dud: false });
    expect(await store.listWireDuds('2000-01-01')).toHaveLength(2);
    expect(await wire.queue()).toBe(1);
  });

  it('never repeats across days, even under a different URL with the same title', async () => {
    const seen: string[] = [];
    for (let d = 0; d < 6; d += 1) {
      const now = T + d * 86_400_000;
      // The same news every day, plus the mirror of C under yet another URL;
      // after the first day the letter feed no longer carries C, so the
      // mirror arrives on its own and only its title can stop it.
      const answers = { ...day(T), ...(d > 0 ? { 'https://letter.test/atom.xml': atom([]) } : {}), 'https://hn.test/': hn([
        { title: 'Claude Code hooks in practice', url: 'http://www.lab.test/blog/hooks/?fbclid=abc#top', points: 300, date: hoursAgo(T, 20) },
        { title: 'Show HN: A coding agent for kettles', url: 'https://kettle.test/', points: 80, date: daysAgo(T, 1) },
        { title: 'AGENTIC CODING WITH CLAUDE', url: `https://mirror${d}.test/agentic`, points: 900, date: daysAgo(T, 2) },
      ]) };
      const { wire } = service(store, answers, () => now);
      const a = await wire.ensure(addDays(TODAY, d));
      if (a) seen.push(a.title.toLowerCase());
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((t) => t.includes('agentic coding with claude'))).toHaveLength(1);
  });

  it('falls back to what each source gave in the last 24 hours when it fails', async () => {
    await service(store, day(T)).wire.ensure(TODAY);
    // Two hours later, a new process: every source is down.
    const down: Record<string, Answer> = {
      'https://lab.test/rss.xml': new Error('ECONNRESET'),
      'https://letter.test/atom.xml': { status: 503 },
      'https://hn.test/': new Error('timeout'),
    };
    const later = service(store, down, () => T + 2 * 3_600_000);
    const tomorrow = addDays(TODAY, 1);
    const a = await later.wire.ensure(tomorrow);
    expect(a?.title).toBe('Agentic coding with Claude');
    expect(later.calls.length).toBeGreaterThan(0);
    // Past 24 hours with everything still down: no signal.
    const stale = service(store, down, () => T + 25 * 3_600_000);
    expect(await stale.wire.ensure(addDays(TODAY, 2))).toBeNull();
  });

  it('one failing source does not stop the others', async () => {
    const answers = { ...day(T), 'https://lab.test/rss.xml': { status: 500 } as Answer };
    const { wire } = service(store, answers);
    // Without the lab feed, A is HN's copy alone (no lab weight), so C leads
    // and A is next, under HN's name and link.
    expect((await wire.ensure(TODAY))?.title).toBe('Agentic coding with Claude');
    expect(await wire.skip(TODAY)).toMatchObject({
      title: 'Claude Code hooks in practice',
      source: 'Hacker News · lab.test',
      url: 'http://www.lab.test/blog/hooks/',
    });
  });

  it('fetches an index page at most every 20 hours, robots.txt first, and nothing but the listing', async () => {
    const listing = `<a href="/news/claude-for-teams"><h3>Claude for teams</h3><time dateTime="${new Date(T - 86_400_000).toISOString().slice(0, 10)}">x</time></a>`;
    const answers: Record<string, Answer> = {
      ...day(T),
      'https://www.anthropic.test/robots.txt': 'User-agent: *\nAllow: /\n',
      'https://www.anthropic.test/news': listing,
      'https://gh.test/': ghReleases([{ version: 'v9.9.9', date: new Date(T - 3_600_000).toISOString(), notes: '<ul><li>Added x</li></ul>' }]),
    };
    let now = T;
    const net = fakeWireFetch(answers);
    const wire = createWireService(store, { fetch: net.fetch, now: () => now, config: () => FULL, log: quiet });
    const pageCalls = () => net.calls.filter((c) => c.url.includes('anthropic.test')).map((c) => new URL(c.url).pathname);

    const r1 = await wire.refresh(true);
    expect(pageCalls()).toEqual(['/robots.txt', '/news']);
    expect(r1.find((r) => r.id === 'news')).toEqual({ id: 'news', ok: true, count: 1 });
    expect(await store.getSetting(`${FETCHED_KEY}news`)).toBe(String(T));
    now = T + 19 * 3_600_000;
    const r2 = await wire.refresh(true);
    expect(pageCalls()).toHaveLength(2);
    expect(r2.find((r) => r.id === 'news')).toMatchObject({ skipped: true });
    // Its stories from the last fetch are still in the pool meanwhile.
    expect((await store.wirePool(new Date(T - 1))).some((c) => c.title === 'Claude for teams')).toBe(true);
    now = T + 21 * 3_600_000;
    await wire.refresh(true);
    expect(pageCalls()).toEqual(['/robots.txt', '/news', '/robots.txt', '/news']);
    // The other sources were fetched every time.
    expect(net.calls.filter((c) => c.url.includes('lab.test'))).toHaveLength(3);
    // The page's and the releases' stories made it through the gate.
    const titles = (await store.wirePool(new Date(0))).map((c) => c.title);
    expect(titles).toEqual(expect.arrayContaining(['Claude for teams', 'Claude Code v9.9.9']));
  });

  it('a robots.txt that disallows the page stops the fetch; one that is missing allows it', async () => {
    const answers: Record<string, Answer> = {
      ...day(T),
      'https://www.anthropic.test/robots.txt': 'User-agent: *\nDisallow: /news\n',
      'https://www.anthropic.test/news': '<a href="/news/x"><h3>x</h3><time dateTime="2026-10-12">x</time></a>',
      'https://gh.test/': ghReleases([]),
    };
    const { wire, calls } = service(store, answers, () => T, FULL);
    const r = await wire.refresh(true);
    expect(r.find((x) => x.id === 'news')).toMatchObject({ ok: false, error: 'robots.txt disallows /news' });
    expect(calls.some((c) => new URL(c.url).pathname === '/news')).toBe(false);
    // Not fetched, so not marked: it is tried again on the next refresh.
    expect(await store.getSetting(`${FETCHED_KEY}news`)).toBeNull();

    answers['https://www.anthropic.test/robots.txt'] = { status: 404 };
    const again = service(store, answers, () => T, FULL);
    expect((await again.wire.refresh(true)).find((x) => x.id === 'news')).toMatchObject({ ok: true, count: 1 });
  });

  it('only contacts configured hosts, redirects included, and caps the size', async () => {
    const hosts = new Set(['lab.test']);
    const net = fakeWireFetch({
      'https://lab.test/away': { status: 302, headers: { location: 'https://evil.test/feed' } },
      'https://lab.test/moved': { status: 301, headers: { location: '/rss2.xml' } },
      'https://lab.test/rss2.xml': 'ok',
      'https://lab.test/big': 'x'.repeat(5000),
    });
    const o = { fetch: net.fetch, hosts, timeoutMs: 1000, maxBytes: 1000, accept: '*/*' };
    await expect(fetchAllowed('https://evil.test/feed', o)).rejects.toThrow(/not allowed/);
    await expect(fetchAllowed('http://lab.test/rss.xml', o)).rejects.toThrow(/not allowed/);
    await expect(fetchAllowed('https://lab.test/away', o)).rejects.toThrow(/not allowed: evil\.test/);
    expect(await fetchAllowed('https://lab.test/moved', o)).toBe('ok');
    await expect(fetchAllowed('https://lab.test/big', o)).rejects.toThrow(/too large/);
    expect(net.calls.map((c) => new URL(c.url).hostname).every((h) => h === 'lab.test')).toBe(true);
  });

  it('the shipped config: career tiers, the competitor list, no arXiv, hosts exactly the sources', () => {
    const cfg = loadWireConfig({});
    expect(cfg.tiers.map((t) => [t.tag, t.tier])).toEqual([
      ['Claude Code', 'A'],
      ['Anthropic', 'A'],
      ['AI engineering', 'B'],
    ]);
    expect(cfg.tiers[0].weight).toBeGreaterThan(cfg.tiers[2].weight);
    expect(cfg.tiers[1].weight).toBeGreaterThan(cfg.tiers[2].weight);
    expect(cfg.tiers[1].contextKeywords).toContain('claude');
    expect(cfg.competitors).toEqual(
      expect.arrayContaining(['cursor', 'github copilot', 'openai codex', 'gemini cli', 'windsurf', 'devin', 'replit agent']),
    );
    expect(cfg.exclude.map((e) => e.name)).toEqual(['Math & theorem proving', 'Business & funding', 'Chips & hardware']);
    const q = cfg.hackerNews.queries;
    expect(q.filter((x) => x.minPoints === 30).map((x) => x.query)).toEqual(['Claude', 'Anthropic', 'Claude Code', 'MCP']);
    expect(q.filter((x) => x.minPoints !== 30).every((x) => x.minPoints === 75)).toBe(true);
    expect(cfg.hackerNews.tierBMinPoints).toBe(75);
    const pages = cfg.feeds.filter((f) => f.kind === 'page');
    expect(pages.map((f) => f.url)).toEqual(['https://www.anthropic.com/engineering', 'https://www.anthropic.com/news']);
    expect(pages.every((f) => f.minIntervalHours >= 20)).toBe(true);
    expect(cfg.feeds.filter((f) => f.kind === 'github-releases').map((f) => f.url)).toEqual([
      'https://github.com/anthropics/claude-code/releases.atom',
    ]);
    expect(cfg.feeds.every((f) => f.url.startsWith('https://'))).toBe(true);
    expect([...allowedHosts(cfg)].some((h) => h.includes('arxiv'))).toBe(false);
    const sourceHosts = new Set([cfg.hackerNews.url, ...cfg.feeds.map((f) => f.url)].map((u) => new URL(u).hostname));
    expect([...allowedHosts(cfg)].sort()).toEqual([...sourceHosts].sort());
    // A broken WIRE_CONFIG falls back to the shipped list.
    const err = vi.spyOn(console, 'error').mockImplementation(quiet);
    expect(loadWireConfig({ WIRE_CONFIG: '/nonexistent/wire.json' }).feeds).toEqual(cfg.feeds);
    err.mockRestore();
  });

  it('never chooses a stored story from a source no longer configured (arXiv rows already in the table)', async () => {
    const paper = parseFeed(
      atom([{ title: 'Claude Code, a benchmark', link: 'http://arxiv.org/abs/2610.00001v2', date: daysAgo(T, 1), description: 'Evals.' }]),
      { id: 'arxiv', name: 'arXiv' },
    );
    expect(paper).toHaveLength(1);
    expect(rank(paper, CFG, T)).toEqual([]);
    await store.upsertWireCandidates(paper, new Date(T));
    const { wire } = service(store, { 'https://lab.test/rss.xml': rss([]), 'https://letter.test/atom.xml': atom([]), 'https://hn.test/': hn([]) });
    expect(await wire.ensure(TODAY)).toBeNull();
  });

  it('no signal when the sources answer but nothing passes the gate — never an off-topic fallback', async () => {
    const offTopic: Record<string, Answer> = {
      'https://lab.test/rss.xml': rss([
        { title: 'Lab holiday party', link: 'https://lab.test/blog/party', date: daysAgo(T, 1), description: 'Cake.' },
        { title: 'Claude Code, formally', link: 'https://lab.test/blog/formal', date: daysAgo(T, 1), description: 'A theorem, a proof.' },
      ]),
      'https://letter.test/atom.xml': atom([{ title: 'Copilot, deeply', link: 'https://letter.test/p/c', date: daysAgo(T, 1), description: 'x' }]),
      'https://hn.test/': hn([
        { title: 'Nvidia ships an AI GPU', url: 'https://gpu.test/', points: 2000, date: daysAgo(T, 1) },
        { title: 'Claude Monet, restored', url: 'https://monet.test/', points: 900, date: daysAgo(T, 1) },
      ]),
    };
    const { wire, calls } = service(store, offTopic);
    expect(await wire.ensure(TODAY)).toBeNull();
    expect(calls.length).toBe(4);
    expect(await store.getDailyArticle(TODAY)).toBeNull();
    expect(await wire.queue()).toBe(0);
  });

  it('the 03:30 job: nothing before, the day chosen after', async () => {
    const { wire } = service(store, day(T));
    await store.setSetting('app_timezone', 'UTC');
    const ensure = vi.spyOn(wire, 'ensure');
    const settle = () => new Promise((r) => setTimeout(r, 20));
    let stop = startWireSchedule(store, wire, () => Date.parse('2026-10-13T03:29:00Z'));
    await settle();
    stop();
    expect(ensure).not.toHaveBeenCalled();
    stop = startWireSchedule(store, wire, () => Date.parse('2026-10-13T03:30:00Z'));
    await settle();
    stop();
    expect(ensure).toHaveBeenCalledWith('2026-10-13');
  });
});

describe('/api/article', () => {
  const ctx = useApp();
  let wire: WireService;
  let app: ReturnType<typeof createApp>;
  let answers: Record<string, Answer>;
  beforeEach(() => {
    answers = day(T);
    const net = fakeWireFetch(answers);
    wire = createWireService(ctx.store, { fetch: net.fetch, config: () => CFG, log: quiet });
    app = createApp(ctx.store, { log: false, wire });
  });
  const get = (q = '') => request(app).get(`/api/article${q}`).set(bearer(fullJwt()));
  const post = (p: string, body: object = {}) => request(app).post(`/api/article/${p}`).set(bearer(fullJwt())).send(body);

  it("returns today's article with its tier tags and the queue, the same on every request", async () => {
    const res = await get(`?date=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: TODAY, status: 'ok', past: [], queue: 4 });
    expect(res.body.article).toEqual({
      date: TODAY,
      url: 'https://lab.test/blog/hooks',
      title: 'Claude Code hooks in practice',
      source: 'Test Lab',
      publishedAt: expect.any(String),
      excerpt: 'We report new Claude Code hooks & methods.',
      topics: ['Claude Code'],
      read: false,
    });
    expect((await get()).body.article).toEqual(res.body.article);
  });

  it('marks read, Next (skip) returns the queue, and lists the last 7 days with read flags', async () => {
    for (let d = 8; d >= 1; d -= 1) {
      const date = addDays(TODAY, -d);
      await ctx.store.insertDailyArticle({
        date,
        url: `https://lab.test/old/${d}`,
        title: `Old ${d}`,
        source: 'Test Lab',
        publishedAt: new Date(T - d * 86_400_000),
        excerpt: null,
        urlHash: `u${d}`,
        titleHash: `t${d}`,
        topics: ['Claude Code'],
        sourceId: 'lab',
      });
      if (d % 2) await ctx.store.markArticleRead(date);
    }
    const res = await get(`?date=${TODAY}`);
    expect(res.body.past.map((p: { title: string; read: boolean }) => [p.title, p.read])).toEqual([
      ['Old 1', true],
      ['Old 2', false],
      ['Old 3', true],
      ['Old 4', false],
      ['Old 5', true],
      ['Old 6', false],
      ['Old 7', true],
    ]);

    const read = await post('read', { date: TODAY });
    expect(read.status).toBe(200);
    expect(read.body.article.read).toBe(true);
    expect((await get(`?date=${TODAY}`)).body.article.read).toBe(true);

    const skip = await post('skip', { date: TODAY });
    expect(skip.status).toBe(200);
    expect(skip.body).toMatchObject({ article: { title: 'Agentic coding with Claude', read: false, topics: ['Anthropic', 'AI engineering'] }, queue: 3 });
    expect((await get(`?date=${TODAY}`)).body).toMatchObject({ article: { title: 'Agentic coding with Claude' }, queue: 3 });
    expect(await ctx.store.listWireDuds('2000-01-01')).toHaveLength(1);
    // Down to the last one: the queue reads 0, and one more Next is a 409.
    for (let i = 0; i < 3; i += 1) await post('skip', { date: TODAY });
    expect((await get(`?date=${TODAY}`)).body.queue).toBe(0);
    expect((await post('skip', { date: TODAY })).status).toBe(409);
  });

  it('a past day shows what it had and never chooses one, with no queue; skip there is refused', async () => {
    const old = addDays(TODAY, -5);
    const res = await get(`?date=${old}`);
    expect(res.body).toMatchObject({ status: 'no-signal', article: null, queue: 0 });
    expect(await ctx.store.getDailyArticle(old)).toBeNull();
    expect((await post('skip', { date: old })).status).toBe(409);
    expect((await post('read', { date: old })).status).toBe(404);
    expect((await get(`?date=${addDays(TODAY, 5)}`)).status).toBe(400);
    expect((await get('?date=2026-02-31')).status).toBe(400);
    expect((await post('skip', { date: TODAY, extra: 1 })).status).toBe(400);
  });

  it('says no-signal when nothing passes the gate', async () => {
    answers['https://lab.test/rss.xml'] = rss([
      { title: 'Lab holiday party', link: 'https://lab.test/blog/party', date: daysAgo(T, 1), description: 'Cake.' },
    ]);
    answers['https://letter.test/atom.xml'] = atom([]);
    answers['https://hn.test/'] = hn([{ title: 'Claude proves a theorem', url: 'https://math.test/', points: 3000, date: daysAgo(T, 1) }]);
    const res = await get(`?date=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'no-signal', article: null, queue: 0 });
  });

  it('says no-signal when every source fails and nothing is cached', async () => {
    for (const k of Object.keys(answers)) answers[k] = new Error('down');
    const res = await get(`?date=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'no-signal', article: null });
  });

  it('is open to the API token and closed without credentials', async () => {
    const token = await ctx.issueApiToken();
    expect((await request(app).get('/api/article').set(bearer(token))).status).toBe(200);
    expect((await request(app).get('/api/article')).status).toBe(401);
    expect((await request(app).post('/api/article/skip').send({})).status).toBe(401);
  });
});
