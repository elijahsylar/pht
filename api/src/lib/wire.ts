import { createHash } from 'node:crypto';
import { z } from 'zod';

// AI Wire, the pure half: the config's shape, URL and title normalisation,
// parsing (RSS, Atom, GitHub release feeds, a listing page's links, the HN
// Algolia JSON, robots.txt), merging duplicates, the career gate, and scoring. No network, no DB, no clock — `now` is passed in.
// The fetching and the daily pick are in wireService.ts. Nothing here or there
// calls an AI model: the choice is arithmetic over the numbers below.

// ── Config (src/config/wire.json, or the file named by WIRE_CONFIG) ──────────

const source = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(80),
  url: z.string().url().startsWith('https://'),
  weight: z.number(),
});

const feed = source.extend({
  // feed: RSS/Atom. github-releases: a GitHub releases.atom, one item per day.
  // page: an index page with no feed; only its links (title, date, the
  // listing's own blurb) are read, never an article.
  kind: z.enum(['feed', 'github-releases', 'page']).default('feed'),
  // page: the path prefix of article links, e.g. "/news/".
  linkPrefix: z.string().startsWith('/').optional(),
  // github-releases: the product name for the item title.
  product: z.string().min(1).max(40).optional(),
  // Everything this source publishes is about Claude/Anthropic, so it counts
  // as AI context for keywords that need one.
  aiContext: z.boolean().default(false),
  // Fetch at most this often (hours). 0 = on every refresh.
  minIntervalHours: z.number().min(0).max(168).default(0),
  // Everything this source publishes belongs to this tier tag even when no
  // keyword names it (Anthropic's own pages are about Anthropic). The other
  // rules — exclusions, competitors — still apply.
  tag: z.string().min(1).max(40).optional(),
});

const keywordGroup = z.object({ name: z.string().min(1), keywords: z.array(z.string().min(1)).min(1) });

export const wireConfigSchema = z.object({
  lookbackDays: z.number().int().min(1).max(90),
  timeoutMs: z.number().int().min(500).max(30_000),
  maxBytes: z.number().int().min(10_000).max(20_000_000),
  weights: z.object({
    popularity: z.number(),
    recency: z.number(),
  }),
  // A story must match a tier or it is never a candidate. `tag` is what the
  // Wire window shows; `weight` is added to the score (tier A highest).
  // `contextKeywords` count only when the same item also names one of the
  // tier's `context` terms (or its source is marked aiContext): "Claude" alone
  // may be a person. Context is looked for after every tier's contextKeywords
  // are taken out of the text, so none of them can vouch for itself.
  tiers: z
    .array(
      z.object({
        tag: z.string().min(1).max(40),
        tier: z.enum(['A', 'B']),
        weight: z.number(),
        keywords: z.array(z.string().min(1)),
        contextKeywords: z.array(z.string().min(1)).default([]),
        context: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1),
  // A story whose link is on one of these hosts (or a subdomain) counts as
  // having AI context, like an aiContext source: an HN post of anthropic.com.
  contextHosts: z.array(z.string().min(1)).default([]),
  // Competitors' developer tools: a story centred on one is rejected unless
  // tier A (Claude/Anthropic) is also a main subject.
  competitors: z.array(z.string().min(1)),
  // Hard rejects: one keyword in the title, or two in the excerpt.
  exclude: z.array(keywordGroup),
  hackerNews: source.extend({
    queries: z.array(z.object({ query: z.string().min(1), minPoints: z.number().int().min(0) })).min(1).max(16),
    // An HN story that only reaches tier B needs this many points.
    tierBMinPoints: z.number().int().min(0),
  }),
  feeds: z.array(feed).max(60),
});

export type WireConfig = z.infer<typeof wireConfigSchema>;
export type FeedSource = WireConfig['feeds'][number];

// Every host the service may contact: exactly the hosts in the config.
export function allowedHosts(cfg: WireConfig): Set<string> {
  return new Set(
    [cfg.hackerNews.url, ...cfg.feeds.map((f) => f.url)].map((u) => new URL(u).hostname),
  );
}

// ── Candidates ──────────────────────────────────────────────────────────────

export interface Candidate {
  // The link to open: the original minus tracking parameters and fragment.
  url: string;
  // The dedupe key (canonicalUrl) and its SHA-256.
  canonicalUrl: string;
  urlHash: string;
  title: string;
  titleHash: string;
  // Display name ("OpenAI", "Hacker News · example.com") and config id.
  source: string;
  sourceId: string;
  publishedAt: Date;
  // ≤ EXCERPT_MAX characters, from the feed's own description; never page text.
  excerpt: string | null;
  // HN points when the story was on Hacker News.
  points: number | null;
}

export const EXCERPT_MAX = 400;
export const TITLE_MAX = 300;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Query parameters that only say where a click came from.
const TRACKING = new Set([
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'igshid',
  'mc_cid', 'mc_eid', 'mkt_tok', '_hsenc', '_hsmi', 'hsctatracking', 'ref', 'ref_src', 'ref_url',
  'source', 'src', 'cmpid', 'cmp', 'campaign', 'r', 's', 'si', 'spm', 'share', 'publication_id',
  'post_id', 'isfreemail', 'triedredirect', 'triedRedirect', 'via', 'trk', 'rss', 'feed',
]);
const isTracking = (k: string) => /^utm_/i.test(k) || /^at_/i.test(k) || TRACKING.has(k.toLowerCase());

// The link with tracking parameters and the fragment removed, or null when it
// is not an http(s) URL.
export function cleanUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (isTracking(k)) u.searchParams.delete(k);
  return u.toString();
}

// The dedupe key: https, lowercase host without www. or m., no default port,
// no duplicate or trailing slashes, no index.html, the remaining query sorted;
// arXiv abs/pdf links reduced to the unversioned abs id.
export function canonicalUrl(raw: string): string | null {
  const clean = cleanUrl(raw);
  if (!clean) return null;
  const u = new URL(clean);
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  let path = u.pathname.replace(/\/{2,}/g, '/').replace(/\/index\.html?$/i, '/');
  if (host === 'arxiv.org' || host === 'export.arxiv.org') {
    const m = /^\/(?:abs|pdf)\/(.+?)(?:v\d+)?(?:\.pdf)?$/.exec(path);
    if (m) return `https://arxiv.org/abs/${m[1]}`;
  }
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const params = [...u.searchParams.entries()].sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
  const query = params.length ? `?${new URLSearchParams(params)}` : '';
  return `https://${host}${path}${query}`;
}

// Titles as a reader would compare them: case, accents, punctuation, "Show
// HN:" prefixes, bracketed tags like [pdf] and trailing " | Site" or " - Site"
// suffixes all ignored.
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^(show|ask|tell|launch) hn\s*[:–-]\s*/, '')
    .replace(/\s+[|–—-]\s+[^|–—-]{1,40}$/, '')
    .replace(/[[(][^\])]{0,20}[\])]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const titleHash = (title: string) => sha256(normalizeTitle(title));

// ── Text from feeds ─────────────────────────────────────────────────────────

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', aacute: 'á', oacute: 'ó', uuml: 'ü',
  ouml: 'ö', auml: 'ä', ccedil: 'ç', ntilde: 'ñ', iacute: 'í', uacute: 'ú', szlig: 'ß', times: '×',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const unCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

// Feed markup → plain text: CDATA unwrapped, entities decoded (twice, since
// descriptions are often escaped HTML), tags and scripts dropped, whitespace
// collapsed.
export function plainText(s: string): string {
  let t = decodeEntities(unCdata(s));
  t = t.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');
  t = decodeEntities(t);
  return t.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

// At most EXCERPT_MAX characters, cut at a word with an ellipsis.
export function makeExcerpt(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const chars = [...t];
  if (chars.length <= EXCERPT_MAX) return t;
  const cut = chars.slice(0, EXCERPT_MAX - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > EXCERPT_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

const clip = (s: string, n: number) => ([...s].length <= n ? s : `${[...s].slice(0, n - 1).join('')}…`);

// ── Parsers ─────────────────────────────────────────────────────────────────

// The inner XML of the first <name> element in `block` (any of `names`).
function inner(block: string, names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(`<${name.replace(':', '\\:')}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${name.replace(':', '\\:')}>)`, 'i');
    const m = re.exec(block);
    if (m && m[1] !== undefined && m[1].trim()) return m[1];
  }
  return null;
}

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null;
};

// The item's link: RSS <link>text</link>, else Atom's alternate (or rel-less)
// <link href>, else a permalink <guid>.
function itemLink(block: string): string | null {
  const text = inner(block, ['link']);
  if (text && /^\s*(<!\[CDATA\[)?\s*https?:/i.test(text)) return plainText(text);
  for (const m of block.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attr(m[0], 'rel');
    const href = attr(m[0], 'href');
    if (href && (rel === null || rel === 'alternate')) return href.trim();
  }
  const guid = /<guid\b([^>]*)>([\s\S]*?)<\/guid>/i.exec(block);
  if (guid && !/isPermaLink\s*=\s*["']false/i.test(guid[1])) {
    const g = plainText(guid[2]);
    if (/^https?:\/\//i.test(g)) return g;
  }
  return null;
}

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const t = Date.parse(plainText(s));
  return Number.isFinite(t) ? new Date(t) : null;
}

export interface SourceRef {
  id: string;
  name: string;
}

// Builds a candidate, or null when it lacks a usable link, title or date.
export function makeCandidate(
  src: SourceRef,
  fields: { link: string | null; title: string | null; published: Date | null; description: string | null; points?: number | null },
): Candidate | null {
  if (!fields.link || !fields.title || !fields.published) return null;
  const url = cleanUrl(fields.link);
  const canonical = canonicalUrl(fields.link);
  const title = clip(plainText(fields.title), TITLE_MAX);
  if (!url || !canonical || !title || !normalizeTitle(title)) return null;
  return {
    url,
    canonicalUrl: canonical,
    urlHash: sha256(canonical),
    title,
    titleHash: titleHash(title),
    source: src.name,
    sourceId: src.id,
    publishedAt: fields.published,
    excerpt: fields.description ? makeExcerpt(plainText(fields.description)) : null,
    points: fields.points ?? null,
  };
}

// RSS 2.0, RSS 1.0 and Atom. Items that cannot
// be read are skipped; a body with no items at all throws (= the source failed).
export function parseFeed(xml: string, src: SourceRef): Candidate[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const blocks = [
    ...body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...body.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]);
  if (!blocks.length && !/<(rss|feed|rdf:RDF)\b/i.test(body)) throw new Error('not a feed');
  const out: Candidate[] = [];
  for (const b of blocks) {
    const c = makeCandidate(src, {
      link: itemLink(b),
      title: inner(b, ['title']),
      published: parseDate(inner(b, ['pubDate', 'published', 'dc:date', 'updated', 'issued'])),
      description: inner(b, ['description', 'summary', 'content:encoded', 'content']),
    });
    if (c) out.push(c);
  }
  return out;
}

// A GitHub releases.atom → one item per UTC day: the day's releases grouped
// ("Claude Code v2.1.299–v2.1.300 (2 releases)"), linked to the day's first
// release so the item keeps its URL as more patches land, with each release's
// headline (the first line of its notes) as the excerpt. Nothing else of the
// notes is kept.
export function parseGithubReleases(xml: string, src: SourceRef & { product?: string }): Candidate[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (!/<feed\b/i.test(body)) throw new Error('not a feed');
  const releases: { version: string; link: string; at: Date; headline: string }[] = [];
  for (const m of body.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const b = m[1];
    const version = plainText(inner(b, ['title']) ?? '');
    const link = itemLink(b);
    const at = parseDate(inner(b, ['updated', 'published']));
    if (!version || !link || !at) continue;
    const content = decodeEntities(unCdata(inner(b, ['content', 'summary']) ?? ''));
    // The headline: the first bullet, else the first paragraph that is not
    // the "What's changed" heading.
    const li = /<li\b[^>]*>([\s\S]*?)<\/li>/i.exec(content);
    const para = [...content.matchAll(/<(?:p|h\d)\b[^>]*>([\s\S]*?)<\/(?:p|h\d)>/gi)]
      .map((m) => plainText(m[1]))
      .find((t) => t && !/^what'?s changed:?$/i.test(t));
    const headline = li ? plainText(li[1]) : (para ?? '');
    releases.push({ version, link, at, headline });
  }
  const days = new Map<string, typeof releases>();
  for (const r of releases) {
    const day = r.at.toISOString().slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), r]);
  }
  const product = src.product ?? src.name;
  const out: Candidate[] = [];
  for (const group of days.values()) {
    group.sort((a, b) => a.at.getTime() - b.at.getTime());
    const first = group[0];
    const last = group[group.length - 1];
    const title =
      group.length === 1 ? `${product} ${first.version}` : `${product} ${first.version}–${last.version} (${group.length} releases)`;
    const c = makeCandidate(src, {
      link: first.link,
      title,
      published: last.at,
      description: group
        .filter((r) => r.headline)
        .map((r) => `${r.version}: ${r.headline}`)
        .join(' · '),
    });
    if (c) out.push(c);
  }
  return out;
}

// A listing page with no feed → its article links: every <a href> under
// `linkPrefix`, its title (a heading, a "title" span, else the image's alt
// text), its date (<time datetime>, else the time's text) and the listing's
// own blurb (a <p> inside the link). Undated links are left out, as the
// 30-day rule cannot be applied to them. No article page is ever fetched.
export function parseIndexPage(html: string, src: SourceRef & { url: string; linkPrefix?: string }): Candidate[] {
  const prefix = src.linkPrefix ?? '/';
  const out: Candidate[] = [];
  const seen = new Set<string>();
  let links = 0;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1], 'href');
    if (!href) continue;
    let abs: URL;
    try {
      abs = new URL(href, src.url);
    } catch {
      continue;
    }
    const base = new URL(src.url);
    if (abs.hostname !== base.hostname || !abs.pathname.startsWith(prefix) || abs.pathname.length <= prefix.length) continue;
    links += 1;
    const key = abs.pathname.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    const a = m[2];
    const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(a);
    const span = /<span\b[^>]*class\s*=\s*"[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(a);
    const img = /<img\b[^>]*>/i.exec(a);
    const title = heading ? plainText(heading[1]) : span ? plainText(span[1]) : img ? (attr(img[0], 'alt') ?? '').trim() : '';
    const time = /<time\b([^>]*)>([\s\S]*?)<\/time>/i.exec(a);
    const when = time ? (attr(time[1], 'datetime') ?? plainText(time[2])) : null;
    const published = when ? listingDate(when) : embeddedDate(html, abs.pathname.slice(prefix.length).replace(/\/+$/, ''));
    const blurb = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(a);
    if (!title || !published) continue;
    const c = makeCandidate(src, { link: abs.toString(), title, published, description: blurb ? blurb[1] : null });
    if (c) {
      seen.add(key);
      out.push(c);
    }
  }
  if (!links) throw new Error(`no ${prefix} links on the page`);
  return out;
}

// A featured link may carry no date of its own; the page's embedded data
// (Next.js) usually has `"publishedOn":"2026-10-13"` just before the slug.
function embeddedDate(html: string, slug: string): Date | null {
  if (!slug) return null;
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`publishedOn\\\\?"\\s*:\\s*\\\\?"(\\d{4}-\\d{2}-\\d{2})[^{}]{0,200}?\\{[^{}]{0,80}?current\\\\?"\\s*:\\s*\\\\?"${esc}\\\\?"`).exec(html);
  return m ? listingDate(m[1]) : null;
}

// "2026-10-15" or "Oct 15, 2026" → noon UTC that day, so no zone moves it
// to a neighbouring date.
function listingDate(s: string): Date | null {
  const t = s.trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  const ms = iso ? Date.parse(`${iso[1]}T12:00:00Z`) : Date.parse(`${t} 12:00 UTC`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

// robots.txt: may `ua` fetch `path`? The group naming our agent token, else
// the * group; the longest matching Allow/Disallow wins, Allow on a tie.
// Wildcards (* and a trailing $) are honoured.
export function robotsAllows(robots: string, ua: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (key === 'allow' || key === 'disallow') && value) current.rules.push({ allow: key === 'allow', pattern: value });
    }
  }
  const token = ua.toLowerCase().split('/')[0];
  const group =
    groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a))) ?? groups.find((g) => g.agents.includes('*'));
  if (!group) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    const re = new RegExp(
      `^${r.pattern
        .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\\\$$/, '$')}`,
    );
    if (!re.test(path)) continue;
    if (!best || r.pattern.length > best.len || (r.pattern.length === best.len && r.allow)) {
      best = { allow: r.allow, len: r.pattern.length };
    }
  }
  return best ? best.allow : true;
}

const hnHit = z.object({
  title: z.string().nullish(),
  url: z.string().nullish(),
  points: z.number().nullish(),
  num_comments: z.number().nullish(),
  created_at_i: z.number(),
});

const escapeRe = (k: string) => k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole words only: "chip" is not in "chipper", "proof" not in "waterproof",
// and a dotted name is one word, so "character" is not in "Character.ai" (a
// keyword may itself be dotted, like "llama.cpp").
const wordRe = (k: string, flags = '') =>
  new RegExp(`(?<![a-z0-9]|[a-z0-9]\\.)${escapeRe(k)}(?![a-z0-9]|\\.[a-z0-9])`, flags);

export function mentionsAny(text: string, keywords: readonly string[]): boolean {
  const t = text.toLowerCase();
  return keywords.some((k) => wordRe(k).test(t));
}

// `text` with every whole-word occurrence of `keywords` cut out.
export function stripMentions(text: string, keywords: readonly string[]): string {
  return keywords.reduce((t, k) => t.replace(wordRe(k, 'g'), ' | '), text.toLowerCase());
}

// How many times any of `keywords` occurs in `text`, as whole words.
export function countMentions(text: string, keywords: readonly string[]): number {
  const t = text.toLowerCase();
  return keywords.reduce((n, k) => n + (t.match(wordRe(k, 'g'))?.length ?? 0), 0);
}

// One HN Algolia answer → link stories with at least `minPoints`. A story
// without an outside URL (Ask HN) has nothing to read and is left out. The
// excerpt is HN's own numbers, never the linked page. The gate decides later
// whether a story is on topic.
export function parseHn(json: unknown, cfg: WireConfig, minPoints = 0): Candidate[] {
  const hits = (json as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits)) throw new Error('no hits');
  const out: Candidate[] = [];
  for (const raw of hits) {
    const h = hnHit.safeParse(raw);
    if (!h.success || !h.data.url || !h.data.title) continue;
    const points = h.data.points ?? 0;
    if (points < minPoints) continue;
    let host = '';
    try {
      host = new URL(h.data.url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    const comments = h.data.num_comments ?? 0;
    const c = makeCandidate(
      { id: cfg.hackerNews.id, name: `${cfg.hackerNews.name} · ${host}` },
      {
        link: h.data.url,
        title: h.data.title,
        published: new Date(h.data.created_at_i * 1000),
        description: `${points} points and ${comments} comments on Hacker News.`,
        points,
      },
    );
    if (c) out.push(c);
  }
  return out;
}

// ── Merging and scoring ─────────────────────────────────────────────────────

// One candidate per story: two are the same story when their canonical URLs
// or their normalised titles match. The merged one keeps the publisher's own
// feed entry (link, name, description) over Hacker News's, the highest HN
// points and the earliest date.
export function mergeDuplicates(list: readonly Candidate[], hnId: string): Candidate[] {
  const groups: Candidate[][] = [];
  const byKey = new Map<string, number>();
  for (const c of list) {
    const gi = byKey.get(`u:${c.urlHash}`) ?? byKey.get(`t:${c.titleHash}`);
    const idx = gi ?? groups.push([]) - 1;
    groups[idx].push(c);
    byKey.set(`u:${c.urlHash}`, idx);
    byKey.set(`t:${c.titleHash}`, idx);
  }
  return groups.map((g) => {
    const lead = g.find((c) => c.sourceId !== hnId) ?? g[0];
    const points = g.reduce<number | null>((m, c) => (c.points === null ? m : Math.max(m ?? 0, c.points)), null);
    const publishedAt = new Date(Math.min(...g.map((c) => c.publishedAt.getTime())));
    const excerpt = lead.excerpt ?? g.find((c) => c.excerpt)?.excerpt ?? null;
    return { ...lead, points, publishedAt, excerpt };
  });
}

export function sourceWeight(cfg: WireConfig, sourceId: string): number {
  if (sourceId === cfg.hackerNews.id) return cfg.hackerNews.weight;
  return cfg.feeds.find((f) => f.id === sourceId)?.weight ?? 0;
}

// Only stories from a source still in the config: one dropped from it leaves
// rows in the table that are never chosen.
export const isConfiguredSource = (cfg: WireConfig, sourceId: string) =>
  sourceId === cfg.hackerNews.id || cfg.feeds.some((f) => f.id === sourceId);

export type Verdict =
  | { ok: true; topics: string[]; tier: 'A' | 'B'; weight: number }
  | { ok: false; reason: string };

// The career gate:
// 1. Exclusions: any exclude keyword in the title, or two in the excerpt.
// 2. Tiers: the story must match one. A contextKeyword ("claude", "mcp")
//    counts only with one of the tier's context terms elsewhere in the item,
//    or from a source marked aiContext.
// 3. Competitors: a story centred on a competitor's tool (named in the title,
//    or twice in the excerpt) is rejected unless tier A is a main subject too
//    (in the title, or at least as often in the excerpt when the competitor
//    is not in the title).
// 4. An HN story that only reaches tier B needs tierBMinPoints.
// Matched tiers come back as tags, tier A first, then by strength (a title
// match counts double), ties in config order; the first is the main one.
export function classify(
  c: Pick<Candidate, 'title' | 'excerpt'> & Partial<Pick<Candidate, 'sourceId' | 'points' | 'canonicalUrl'>>,
  cfg: WireConfig,
): Verdict {
  const excerpt = c.excerpt ?? '';
  for (const ex of cfg.exclude) {
    const hit = ex.keywords.find((k) => mentionsAny(c.title, [k]));
    if (hit) return { ok: false, reason: `${ex.name}: "${hit}" in title` };
    const n = countMentions(excerpt, ex.keywords);
    if (n >= 2) return { ok: false, reason: `${ex.name}: ${n} matches in excerpt` };
  }
  const src = cfg.feeds.find((f) => f.id === c.sourceId);
  let host = '';
  try {
    host = c.canonicalUrl ? new URL(c.canonicalUrl).hostname : '';
  } catch {
    host = '';
  }
  const hostContext = cfg.contextHosts.some((h) => host === h || host.endsWith(`.${h}`));
  const rest = stripMentions(`${c.title} \n ${excerpt}`, cfg.tiers.flatMap((t) => t.contextKeywords));
  const matched = cfg.tiers
    .map((t, i) => {
      const context = Boolean(src?.aiContext) || hostContext || mentionsAny(rest, t.context);
      const kws = context ? [...t.keywords, ...t.contextKeywords] : t.keywords;
      const inTitle = countMentions(c.title, kws);
      const inExcerpt = countMentions(excerpt, kws);
      // A source's own tag counts as one excerpt match.
      const own = src?.tag === t.tag ? 1 : 0;
      return { t, i, inTitle, inExcerpt, s: 2 * inTitle + inExcerpt + own };
    })
    .filter((m) => m.s > 0)
    .sort((a, b) => (a.t.tier === b.t.tier ? 0 : a.t.tier === 'A' ? -1 : 1) || b.s - a.s || a.i - b.i);
  if (!matched.length) {
    const bare = cfg.tiers.flatMap((t) => t.contextKeywords).find((k) => mentionsAny(`${c.title} ${excerpt}`, [k]));
    return { ok: false, reason: bare ? `"${bare}" without AI context` : 'no tier' };
  }
  const compTitle = cfg.competitors.find((k) => mentionsAny(c.title, [k]));
  const compExcerpt = countMentions(excerpt, cfg.competitors);
  if (compTitle || compExcerpt >= 2) {
    const a = matched.filter((m) => m.t.tier === 'A');
    const aMain = a.some((m) => m.inTitle > 0) || (!compTitle && a.reduce((n, m) => n + m.inExcerpt, 0) >= compExcerpt);
    if (!aMain) {
      return { ok: false, reason: compTitle ? `competitor: "${compTitle}" in title` : `competitor: ${compExcerpt} matches in excerpt` };
    }
  }
  const main = matched[0].t;
  if (c.sourceId === cfg.hackerNews.id && main.tier === 'B' && (c.points ?? 0) < cfg.hackerNews.tierBMinPoints) {
    return { ok: false, reason: `HN tier B under ${cfg.hackerNews.tierBMinPoints} points` };
  }
  return {
    ok: true,
    topics: matched.map((m) => m.t.tag),
    tier: main.tier,
    weight: Math.max(...matched.map((m) => m.t.weight)),
  };
}

// popularity (log10 of HN points) + source weight + recency (linear over the
// lookback window) + the weight of the best tier matched. Only stories that
// pass classify() are scored.
export function score(c: Candidate, cfg: WireConfig, now: number, tierWeight = 0): number {
  const w = cfg.weights;
  const popularity = c.points && c.points > 0 ? w.popularity * Math.log10(c.points) : 0;
  const ageDays = (now - c.publishedAt.getTime()) / 86_400_000;
  const recency = w.recency * Math.max(0, Math.min(1, 1 - ageDays / cfg.lookbackDays));
  return popularity + sourceWeight(cfg, c.sourceId) + recency + tierWeight;
}

export function withinLookback(c: Candidate, cfg: WireConfig, now: number): boolean {
  const t = c.publishedAt.getTime();
  // A day of slack for feeds that stamp tomorrow's date in another zone.
  return t >= now - cfg.lookbackDays * 86_400_000 && t <= now + 86_400_000;
}

export interface Ranked extends Candidate {
  topics: string[];
  tier: 'A' | 'B';
  score: number;
}

// The stories that pass the gate, best first: score, then newer, then URL,
// so the order is fully determined.
export function rank(list: readonly Candidate[], cfg: WireConfig, now: number): Ranked[] {
  const out: Ranked[] = [];
  for (const c of list) {
    if (!withinLookback(c, cfg, now) || !isConfiguredSource(cfg, c.sourceId)) continue;
    const v = classify(c, cfg);
    if (v.ok) out.push({ ...c, topics: v.topics, tier: v.tier, score: score(c, cfg, now, v.weight) });
  }
  return out.sort(
    (a, b) =>
      b.score - a.score ||
      b.publishedAt.getTime() - a.publishedAt.getTime() ||
      a.canonicalUrl.localeCompare(b.canonicalUrl),
  );
}
