import { wireConfigSchema, type WireConfig } from '../src/lib/wire.js';

// AI Wire test fixtures: a small config over invented hosts, feed bodies built
// from item lists, and a fetch stand-in that answers by URL and records every
// call. Nothing here touches the network.

export const WIRE_TEST_CONFIG: WireConfig = wireConfigSchema.parse({
  lookbackDays: 30,
  timeoutMs: 1000,
  maxBytes: 200_000,
  weights: { popularity: 4, recency: 6 },
  tiers: [
    { tag: 'Claude Code', tier: 'A', weight: 12, keywords: ['claude code'] },
    {
      tag: 'Anthropic',
      tier: 'A',
      weight: 10,
      keywords: ['anthropic', 'model context protocol'],
      contextKeywords: ['claude', 'mcp'],
      context: ['ai', 'llm', 'model', 'coding', 'api'],
    },
    {
      tag: 'AI engineering',
      tier: 'B',
      weight: 4,
      keywords: ['agentic coding', 'prompt engineering', 'context engineering', 'coding agent', 'coding agents'],
      contextKeywords: ['evals', 'code review', 'careers'],
      context: ['ai', 'llm'],
    },
  ],
  contextHosts: ['anthropic.test'],
  competitors: ['cursor', 'copilot', 'codex'],
  exclude: [
    { name: 'Math', keywords: ['mathematics', 'theorem', 'proof', 'proofs'] },
    { name: 'Chips', keywords: ['chip', 'chips', 'gpu', 'nvidia'] },
    { name: 'Business', keywords: ['raises', 'ipo'] },
  ],
  hackerNews: {
    id: 'hn',
    name: 'Hacker News',
    url: 'https://hn.test/api/v1/search',
    weight: 0,
    queries: [
      { query: 'Claude', minPoints: 30 },
      { query: 'agentic coding', minPoints: 75 },
    ],
    tierBMinPoints: 75,
  },
  feeds: [
    { id: 'lab', name: 'Test Lab', url: 'https://lab.test/rss.xml', weight: 8 },
    { id: 'letter', name: 'Test Letter', url: 'https://letter.test/atom.xml', weight: 6 },
  ],
});

// The same plus the two special kinds: an index page with no feed (fetched at
// most every 20 hours, robots.txt first) and a GitHub releases feed.
export const WIRE_FULL_CONFIG: WireConfig = wireConfigSchema.parse({
  ...WIRE_TEST_CONFIG,
  feeds: [
    ...WIRE_TEST_CONFIG.feeds,
    {
      id: 'news',
      name: 'Anthropic Test',
      url: 'https://www.anthropic.test/news',
      weight: 8,
      kind: 'page',
      linkPrefix: '/news/',
      aiContext: true,
      tag: 'Anthropic',
      minIntervalHours: 20,
    },
    {
      id: 'releases',
      name: 'Claude Code releases',
      url: 'https://gh.test/anthropics/claude-code/releases.atom',
      weight: 2,
      kind: 'github-releases',
      product: 'Claude Code',
      aiContext: true,
      tag: 'Claude Code',
    },
  ],
});

export interface FeedItem {
  title: string;
  link: string;
  date: string; // ISO instant
  description?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function rss(items: FeedItem[]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Lab</title>
${items
  .map(
    (i) => `<item><title>${esc(i.title)}</title><link>${esc(i.link)}</link>
<pubDate>${new Date(i.date).toUTCString()}</pubDate>
${i.description === undefined ? '' : `<description><![CDATA[${i.description}]]></description>`}</item>`,
  )
  .join('\n')}</channel></rss>`;
}

export function atom(items: FeedItem[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Letter</title>
<link rel="self" href="https://letter.test/atom.xml"/>
${items
  .map(
    (i) => `<entry><title type="html">${esc(i.title)}</title>
<link rel="replies" href="https://letter.test/comments"/><link rel="alternate" href="${esc(i.link)}"/>
<published>${i.date}</published>
${i.description === undefined ? '' : `<summary type="html">${esc(i.description)}</summary>`}</entry>`,
  )
  .join('\n')}</feed>`;
}

export interface HnItem {
  title: string;
  url: string | null;
  points: number;
  date: string;
  comments?: number;
}

export function hn(items: HnItem[]): string {
  return JSON.stringify({
    hits: items.map((i) => ({
      title: i.title,
      url: i.url,
      points: i.points,
      num_comments: i.comments ?? 10,
      created_at_i: Math.floor(Date.parse(i.date) / 1000),
    })),
  });
}

export type Answer = string | Error | { status: number; body?: string; headers?: Record<string, string> };

// A fetch that answers by host (first match of the URL's start), records
// every URL it was asked for, and fails any host it was not given.
export function fakeWireFetch(answers: Record<string, Answer | (() => Answer)>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(answers).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    const raw = answers[key];
    const a = typeof raw === 'function' ? raw() : raw;
    if (a instanceof Error) throw a;
    if (typeof a === 'string') return new Response(a, { status: 200 });
    return new Response(a.body ?? '', { status: a.status, headers: a.headers });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const hoursAgo = (now: number, h: number) => new Date(now - h * 3_600_000).toISOString();
export const daysAgo = (now: number, d: number) => hoursAgo(now, d * 24);

export interface ReleaseItem {
  version: string;
  date: string; // ISO instant
  notes: string; // HTML, as GitHub renders it
}

// A GitHub releases.atom: one entry per release, notes as escaped HTML.
export function ghReleases(items: ReleaseItem[], repo = 'https://gh.test/anthropics/claude-code'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
<id>tag:gh.test,2008:${repo}/releases</id>
<link type="text/html" rel="alternate" href="${repo}/releases"/>
<title>Release notes from claude-code</title>
${items
  .map(
    (i) => `<entry><id>tag:gh.test,2008:Repository/1/${i.version}</id><updated>${i.date}</updated>
<link rel="alternate" type="text/html" href="${repo}/releases/tag/${i.version}"/>
<title>${esc(i.version)}</title>
<content type="html">${esc(i.notes)}</content></entry>`,
  )
  .join('\n')}</feed>`;
}
