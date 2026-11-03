// Per-device preferences in localStorage: the window layout, wallpaper,
// animation, the day the all-done moment last fired. Every read and write is
// wrapped: private mode, blocked storage or a corrupt value just means the
// default.

export const PREF = {
  grid: 'pht:grid',
  wallpaper: 'pht:wallpaper',
  animate: 'pht:animate',
  allDone: 'pht:all-done',
} as const;

// Layout keys from before the snap grid (the docking columns, and before that
// three widths and a minimized list): ignored, and removed on first load.
export const OLD_LAYOUT_KEYS = ['pht:layout', 'pht:cols', 'pht:minimized'] as const;

export function readPref<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v: unknown = JSON.parse(raw);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not remembered on this device */
  }
}

export function removePref(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to remove */
  }
}
