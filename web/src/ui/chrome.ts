import { h } from '../lib/dom';

// 98-style modal dialogs and the segmented progress bar.

interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
}

interface DialogOptions {
  title: string;
  message?: string;
  // An icon-ish marker drawn beside the message: error (red), question, info.
  kind?: 'error' | 'question' | 'info';
  input?: { label: string; value: string; maxLength?: number };
  buttons: DialogButton[];
  className?: string;
}

export interface DialogResult {
  button: string; // the pressed button's value; 'dismiss' for Escape / Close
  value: string; // the input's value, '' when there is none
}

// One modal at a time is enough here; a second opens on top of the first.
export function dialog(opts: DialogOptions): Promise<DialogResult> {
  return new Promise((resolve) => {
    const input = opts.input
      ? h('input', {
          type: 'text',
          value: opts.input.value,
          maxLength: opts.input.maxLength ?? 200,
          id: 'dialog-input',
          className: 'dialog-input',
        })
      : null;

    const done = (button: string) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve({ button, value: input ? input.value : '' });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done('dismiss');
      } else if (e.key === 'Enter' && input && document.activeElement === input) {
        e.preventDefault();
        const primary = opts.buttons.find((b) => b.primary) ?? opts.buttons[0];
        done(primary.value);
      }
    };

    const buttons = opts.buttons.map((b) =>
      h('button', {
        type: 'button',
        className: b.primary ? 'default' : '',
        text: b.label,
        dataset: { value: b.value },
        on: { click: () => done(b.value) },
      }),
    );

    const box = h(
      'div',
      {
        className: `window dialog ${opts.className ?? ''}`.trim(),
        attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' },
      },
      h(
        'div',
        { className: 'title-bar' },
        h('div', { className: 'title-bar-text', id: 'dialog-title', text: opts.title }),
        h(
          'div',
          { className: 'title-bar-controls' },
          h('button', { attrs: { 'aria-label': 'Close' }, on: { click: () => done('dismiss') } }),
        ),
      ),
      h(
        'div',
        { className: 'window-body' },
        h(
          'div',
          { className: 'dialog-message' },
          opts.kind ? h('span', { className: `dialog-icon ${opts.kind}`, attrs: { 'aria-hidden': 'true' } }) : null,
          opts.message ? h('p', { text: opts.message }) : null,
        ),
        input && opts.input
          ? h(
              'div',
              { className: 'field-row-stacked' },
              h('label', { htmlFor: 'dialog-input', text: opts.input.label }),
              input,
            )
          : null,
        h('div', { className: 'dialog-buttons' }, ...buttons),
      ),
    );
    const overlay = h('div', { className: 'dialog-overlay' }, box);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    (input ?? buttons.find((_, i) => opts.buttons[i].primary) ?? buttons[0]).focus();
    input?.select();
  });
}

export async function errorDialog(title: string, message: string): Promise<void> {
  await dialog({ title, message, kind: 'error', buttons: [{ label: 'OK', value: 'ok', primary: true }] });
}

export async function confirmDialog(title: string, message: string, ok = 'OK'): Promise<boolean> {
  const r = await dialog({
    title,
    message,
    kind: 'question',
    buttons: [
      { label: ok, value: 'ok', primary: true },
      { label: 'Cancel', value: 'cancel' },
    ],
  });
  return r.button === 'ok';
}

export async function promptDialog(
  title: string,
  label: string,
  value: string,
  maxLength: number,
): Promise<string | null> {
  const r = await dialog({
    title,
    input: { label, value, maxLength },
    buttons: [
      { label: 'OK', value: 'ok', primary: true },
      { label: 'Cancel', value: 'cancel' },
    ],
  });
  return r.button === 'ok' ? r.value : null;
}

// "Can't reach PHT" — resolves true for Retry. There is no way past it but
// Retry or dismissing it, which leaves the screen as it was.
export async function unreachableDialog(): Promise<boolean> {
  const r = await dialog({
    title: "Can't reach PHT",
    message: "Can't reach PHT. Check the connection, then try again.",
    kind: 'error',
    className: 'unreachable',
    buttons: [
      { label: 'Retry', value: 'retry', primary: true },
      { label: 'Cancel', value: 'cancel' },
    ],
  });
  return r.button === 'retry';
}

// A 98 segmented progress bar. `fraction` is clamped to 0..1. The bar width is
// set through CSSOM, which the CSP allows (it forbids style attributes).
export function progressBar(fraction: number, label: string): HTMLDivElement {
  const bar = h('span', { className: 'progress-indicator-bar' });
  const wrap = h(
    'div',
    {
      className: 'progress-indicator segmented',
      attrs: {
        role: 'progressbar',
        'aria-label': label,
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(Math.round(Math.min(1, Math.max(0, fraction)) * 100)),
      },
    },
    bar,
  );
  bar.style.width = `${Math.min(1, Math.max(0, fraction)) * 100}%`;
  return wrap;
}
