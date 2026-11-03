import { describe, expect, it } from 'vitest';
import { parseRoute, pathFor, slugify, type Route } from './routes';

describe('routes', () => {
  it('round-trips the desktop and Info', () => {
    const all: Route[] = [{ name: 'desktop' }, { name: 'info', id: 12 }, { name: 'day', date: '2026-10-13' }];
    for (const r of all) expect(parseRoute(pathFor(r))).toEqual(r);
    expect(pathFor({ name: 'desktop' })).toBe('/');
  });

  it('tolerates a trailing slash and rejects anything else', () => {
    expect(parseRoute('/habit/7/')).toEqual({ name: 'info', id: 7 });
    expect(parseRoute('')).toEqual({ name: 'desktop' });
    // The one-window paths are gone: the desktop shows everything.
    expect(parseRoute('/history')).toBeNull();
    expect(parseRoute('/setup')).toBeNull();
    expect(parseRoute('/habit/0')).toBeNull();
    expect(parseRoute('/habit/abc')).toBeNull();
    expect(parseRoute('/habit/3/x')).toBeNull();
    expect(parseRoute('/journal')).toBeNull();
    expect(parseRoute('/day/2026-10-13/')).toEqual({ name: 'day', date: '2026-10-13' });
    expect(parseRoute('/day/2026-02-30')).toBeNull();
    expect(parseRoute('/day/20261013')).toBeNull();
    expect(parseRoute('/day/')).toBeNull();
  });
});

describe('slugify', () => {
  it('matches the API slug rule', () => {
    expect(slugify('Go for a walk')).toBe('go-for-a-walk');
    expect(slugify('  Read 1 page!! ')).toBe('read-1-page');
    expect(slugify('Café au lait')).toBe('cafe-au-lait');
    expect(slugify('🌊')).toBe('');
    const long = slugify('a very long habit name that keeps going and going and going');
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });
});
