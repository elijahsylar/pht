// A tiny DOM builder. Text always goes in as text nodes, never as HTML, and
// there is no way to set a `style` attribute: the CSP forbids inline styles,
// so anything positional is a CSS class or a CSSOM property set in code.

type Child = Node | string | number | null | undefined | false;
type Props = {
  className?: string;
  id?: string;
  text?: string;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
} & Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === 'className') el.className = String(value);
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'attrs') {
        for (const [a, v] of Object.entries(value as Record<string, string>)) el.setAttribute(a, v);
      } else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'on') {
        for (const [ev, fn] of Object.entries(value as Record<string, EventListener>)) {
          el.addEventListener(ev, fn);
        }
      } else if (key === 'style') {
        throw new Error('h(): inline styles are not allowed (CSP); use a class');
      } else {
        // Plain DOM properties: type, value, checked, disabled, htmlFor, ...
        (el as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return el;
}

let uid = 0;
export const nextId = (prefix: string) => `${prefix}-${++uid}`;
