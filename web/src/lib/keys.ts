// Desktop keyboard shortcuts: 1–9 toggle the habit in that position, N goes
// to the note, ? opens the help window, [ and ] step the Today deck a day back
// or forward. Pure, so the rules are unit-tested.

export type KeyAction =
  | { kind: 'toggle'; index: number }
  | { kind: 'note' }
  | { kind: 'help' }
  | { kind: 'step'; days: -1 | 1 };

// Anything that takes typing — or a menu or dialog with its own keys — owns
// the keyboard, and the shortcuts stand aside.
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

export function keyAction(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.target && typeof Element !== 'undefined' && e.target instanceof Element && isTypingTarget(e.target)) return null;
  if (/^[1-9]$/.test(e.key)) return { kind: 'toggle', index: Number(e.key) - 1 };
  if (e.key === 'n' || e.key === 'N') return { kind: 'note' };
  if (e.key === '?') return { kind: 'help' };
  if (e.key === '[') return { kind: 'step', days: -1 };
  if (e.key === ']') return { kind: 'step', days: 1 };
  return null;
}

// A streak worth a balloon: 7, 30, 60, 100, then every 100.
export function isMilestone(streak: number): boolean {
  return streak === 7 || streak === 30 || streak === 60 || (streak >= 100 && streak % 100 === 0);
}
