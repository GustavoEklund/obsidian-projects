/** Minimal DOM helpers. The UI layer never imports `obsidian`, so it runs in a plain browser too. */
export type Child = Node | string | number | null | undefined | false;

type Handlers = { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };

export interface HOpts<K extends keyof HTMLElementTagNameMap> {
  class?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  /** CSS properties or custom properties (`--x`). */
  style?: Record<string, string | number>;
  props?: Partial<HTMLElementTagNameMap[K]>;
  on?: Handlers;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, opts: HOpts<K> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (opts.class) el.className = opts.class;
  if (opts.text !== undefined) el.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (opts.style) for (const [k, v] of Object.entries(opts.style)) el.style.setProperty(k, String(v));
  if (opts.props) Object.assign(el, opts.props);
  if (opts.on) for (const [ev, fn] of Object.entries(opts.on)) el.addEventListener(ev, fn as EventListener);
  append(el, children);
  return el;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;
  const run = () => {
    timer = undefined;
    if (pending) {
      const args = pending;
      pending = undefined;
      fn(...args);
    }
  };
  const d = ((...args: A) => {
    pending = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }) as ((...args: A) => void) & { flush(): void; cancel(): void };
  d.flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    run();
  };
  d.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return d;
}

/**
 * Stable 0–359 hue for a string (avatar / epic colors). Keys like OP-1, OP-2, OP-3 differ by one
 * character, so a plain multiplicative hash gives near-identical hues; FNV-1a plus a final
 * avalanche step spreads them apart.
 */
export function hueOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2c1b3c6d);
  hash ^= hash >>> 12;
  hash = Math.imul(hash, 0x297a2d39);
  hash ^= hash >>> 15;
  return (hash >>> 0) % 360;
}

const GOLDEN_ANGLE = 137.508;
const circularDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/**
 * Hues for a set of names such that no two are close together. Each name starts at its own hash
 * hue (so colors stay put as the set grows) and, if that is within `minGap` degrees of one already
 * taken, steps around the wheel by the golden angle until it finds room. Names are processed in
 * sorted order, so the result does not depend on the order they are passed in.
 */
export function distinctHues(names: Iterable<string>, minGap = 36): Map<string, number> {
  const result = new Map<string, number>();
  const taken: number[] = [];
  for (const name of [...new Set(names)].sort()) {
    const preferred = hueOf(name);
    let best = preferred;
    let bestGap = -1;
    for (let step = 0; step < 24; step++) {
      const hue = Math.round((preferred + step * GOLDEN_ANGLE) % 360);
      const gap = taken.length ? Math.min(...taken.map((t) => circularDistance(hue, t))) : 360;
      if (gap > bestGap) {
        best = hue;
        bestGap = gap;
      }
      if (gap >= minGap) break;
    }
    result.set(name, best);
    taken.push(best);
  }
  return result;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1 ? [...words[0]!].slice(0, 2) : [[...words[0]!][0]!, [...words[words.length - 1]!][0]!];
  return letters.join('').toUpperCase();
}

export function autosize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

export function clear(el: Element): void {
  el.replaceChildren();
}
