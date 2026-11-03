// Path ↔ what is open. The desktop is always there; a path can add Info for
// one habit on top of it, or put the Today deck on a past day.
//
//   /                   the desktop, Today on today
//   /day/YYYY-MM-DD     the desktop with Today on that day (backfilling)
//   /habit/:id          the desktop with Info for one habit open
//
// Whether a /day/ date is in the editable window is the desktop's call.

// The old one-window paths (/history, /setup) and anything else are replaced
// by /.

import { isIsoDate } from './dates';

export type Route = { name: 'desktop' } | { name: 'info'; id: number } | { name: 'day'; date: string };

export function parseRoute(path: string): Route | null {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (clean === '/' || clean === '') return { name: 'desktop' };
  const m = /^\/habit\/(\d{1,9})$/.exec(clean);
  if (m && Number(m[1]) > 0) return { name: 'info', id: Number(m[1]) };
  const d = /^\/day\/(\d{4}-\d{2}-\d{2})$/.exec(clean);
  if (d && isIsoDate(d[1])) return { name: 'day', date: d[1] };
  return null;
}

export function pathFor(route: Route): string {
  if (route.name === 'info') return `/habit/${route.id}`;
  if (route.name === 'day') return `/day/${route.date}`;
  return '/';
}

// Lowercase, digits and hyphens, at most 40 — the API's slug rule — derived
// from a label so adding a habit needs only a name.
export function slugify(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}
