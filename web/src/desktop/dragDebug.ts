import { h } from '../lib/dom';
import { setTraceSink } from '../lib/dragTrace';
import { openFloat } from './float';

// ?debug=drag: a "Drag log" window that records every event involved in
// moving and resizing windows, plus what the drag code decided (trace()), so
// a drag that fails in a real browser can be seen step by step. Copy log puts
// it on the clipboard. Nothing is sent anywhere and nothing is stored; without
// the query parameter none of this runs.

const POINTER = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture'] as const;
const MOUSE = ['mousedown', 'mousemove', 'mouseup'] as const;
const OTHER = ['dragstart', 'selectstart', 'contextmenu'] as const;
const THROTTLE_MS = 50;
const MAX_LINES = 5000;

export function dragDebugWanted(): boolean {
  return new URLSearchParams(location.search).get('debug') === 'drag';
}

export function mountDragDebug(opts: { layoutJson(): string; isPhone(): boolean }): () => void {
  const t0 = performance.now();
  const lines: string[] = [];
  const pre = h('pre', { className: 'drag-log-lines', tabIndex: 0, attrs: { 'aria-label': 'Drag log' } });
  const head = h('pre', { className: 'drag-log-head' });
  const note = h('p', { className: 'drag-log-note', attrs: { role: 'status' } });
  const copy = h('button', { type: 'button', text: 'Copy log', className: 'drag-log-copy' });
  const clear = h('button', { type: 'button', text: 'Clear', className: 'drag-log-clear' });
  let fallback: HTMLTextAreaElement | null = null;

  const win = openFloat({ key: 'drag-log', title: 'Drag log', className: 'drag-log', isPhone: opts.isPhone, at: 'corner' });
  win.body.replaceChildren(head, pre, h('div', { className: 'drag-log-buttons' }, copy, clear), note);

  function header(): string {
    const vv = window.visualViewport;
    return [
      `PHT drag log  ${new Date().toISOString()}`,
      `userAgent: ${navigator.userAgent}`,
      `devicePixelRatio: ${window.devicePixelRatio}  viewport: ${window.innerWidth}x${window.innerHeight}` +
        (vv ? `  visualViewport: ${Math.round(vv.width)}x${Math.round(vv.height)} scale ${vv.scale}` : ''),
      `layout: ${opts.layoutJson()}`,
    ].join('\n');
  }
  head.textContent = header();

  const stamp = () => `+${(performance.now() - t0).toFixed(1).padStart(9)}ms`;
  function add(line: string) {
    lines.push(line);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    // Follow the end unless the reader has scrolled up.
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.append(`${line}\n`);
    while (pre.childNodes.length > MAX_LINES) pre.firstChild?.remove();
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }

  function describe(t: EventTarget | null): string {
    if (!(t instanceof Element)) return t === window ? 'window' : t === document ? 'document' : String(t);
    const cls = typeof t.className === 'string' && t.className ? `.${t.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
    const role = t.getAttribute('data-role');
    const win = t.closest('.win')?.id;
    return `${t.tagName.toLowerCase()}${cls}${role ? `[data-role=${role}]` : ''}${win ? ` in #${win}` : ''}`;
  }

  // Events in the log window itself are left out, so reading it adds nothing.
  const own = (e: Event) => e.target instanceof Node && win.root.contains(e.target);
  const lastMove: Record<string, number> = {};

  function onEvent(e: Event) {
    if (own(e)) return;
    if (e.type === 'pointermove' || e.type === 'mousemove') {
      const now = performance.now();
      if (now - (lastMove[e.type] ?? -Infinity) < THROTTLE_MS) return;
      lastMove[e.type] = now;
    }
    const at = stamp();
    const parts = [at, e.type.padEnd(18), describe(e.target)];
    if (e instanceof MouseEvent) {
      parts.push(`button=${e.button} buttons=${e.buttons} x=${e.clientX.toFixed(1)} y=${e.clientY.toFixed(1)}`);
    }
    if (typeof PointerEvent !== 'undefined' && e instanceof PointerEvent) {
      parts.push(`id=${e.pointerId} type=${e.pointerType} primary=${e.isPrimary}`);
    }
    const sel = window.getSelection()?.toString() ?? '';
    if (sel) parts.push(`selection=${JSON.stringify(sel.slice(0, 30))}`);
    // defaultPrevented is final only once every listener has run.
    window.setTimeout(() => add(`${parts.join('  ')}  prevented=${e.defaultPrevented}`), 0);
  }
  const onBlur = (e: FocusEvent) => {
    if (e.target === window) add(`${stamp()} blur              window`);
  };
  const onVisibility = () => add(`${stamp()} visibilitychange  ${document.visibilityState}`);

  const types = [...POINTER, ...MOUSE, ...OTHER];
  for (const t of types) window.addEventListener(t, onEvent, true);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  // Queued like the events, so a decision prints after the event that caused it.
  setTraceSink((line) => {
    const at = stamp();
    window.setTimeout(() => {
      add(`${at} >> ${line}`);
      head.textContent = header();
    }, 0);
  });
  add(`${stamp()} >> drag log on`);

  copy.addEventListener('click', async () => {
    const text = `${header()}\n\n${lines.join('\n')}\n`;
    head.textContent = header();
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = `Copied ${lines.length} lines.`;
      fallback?.remove();
      fallback = null;
    } catch {
      // No clipboard access: select it all in a box to copy by hand.
      fallback?.remove();
      fallback = h('textarea', { className: 'drag-log-fallback', value: text, readOnly: true, attrs: { 'aria-label': 'Log text' } });
      win.body.append(fallback);
      fallback.focus();
      fallback.select();
      note.textContent = 'The clipboard is blocked here: the log is selected below — press Ctrl+C.';
    }
  });
  clear.addEventListener('click', () => {
    lines.length = 0;
    pre.replaceChildren();
    head.textContent = header();
    note.textContent = 'Cleared.';
    add(`${stamp()} >> cleared`);
  });

  return () => {
    for (const t of types) window.removeEventListener(t, onEvent, true);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
    setTraceSink(null);
    win.close();
  };
}
