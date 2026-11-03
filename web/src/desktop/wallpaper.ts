import { h } from '../lib/dom';
import { PREF, readPref, writePref } from '../lib/prefs';

// The desktop wallpaper: original CSS artwork only (style.css), chosen in
// Display Properties and remembered per device. Synthwave can animate — its
// floor grid scrolls toward the viewer with a CSS transform animation, no JS
// loop — and style.css turns that off under prefers-reduced-motion and on
// phones whatever the setting says.

export const WALLPAPERS = [
  { id: 'synthwave', label: 'Synthwave' },
  { id: 'memphis', label: 'Memphis' },
  { id: 'teal', label: 'Teal' },
] as const;
export type Wallpaper = (typeof WALLPAPERS)[number]['id'];

const isWallpaper = (v: unknown): v is Wallpaper => WALLPAPERS.some((w) => w.id === v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

export function readDisplay(): { wallpaper: Wallpaper; animate: boolean } {
  return {
    wallpaper: readPref(PREF.wallpaper, isWallpaper, 'synthwave'),
    animate: readPref(PREF.animate, isBool, false),
  };
}

export function saveDisplay(v: { wallpaper: Wallpaper; animate: boolean }): void {
  writePref(PREF.wallpaper, v.wallpaper);
  writePref(PREF.animate, v.animate);
}

// The layers every wallpaper draws into: sky (sun, stripes) and floor (grid).
export function wallpaperLayer(): HTMLDivElement {
  return h(
    'div',
    { className: 'wallpaper', attrs: { 'aria-hidden': 'true' } },
    h('div', { className: 'wp-sky' }),
    h('div', { className: 'wp-floor' }, h('div', { className: 'wp-grid' })),
  );
}

export function applyDisplay(root: HTMLElement, v: { wallpaper: Wallpaper; animate: boolean }): void {
  for (const w of WALLPAPERS) root.classList.toggle(`wp-${w.id}`, w.id === v.wallpaper);
  root.classList.toggle('wp-animate', v.animate);
  root.dataset.wallpaper = v.wallpaper;
}
