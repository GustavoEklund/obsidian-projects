import { normalizeText } from '@oprojects/core';
import { h } from './dom';
import { icon } from './icons';

export interface PopoverOption {
  value: string;
  label: string;
  /** Optional leading visual (type badge, avatar…). */
  lead?: Node | null;
}

export interface PopoverOptions {
  anchor: HTMLElement;
  options: PopoverOption[];
  selected: string[];
  /** Multi-select stays open and toggles; single-select picks and closes. */
  multi: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  onChange(selected: string[]): void;
}

export interface Popover {
  close(): void;
}

let active: Popover | null = null;

/** Anchored dropdown with a checklist. Only one is open at a time. */
export function openPopover(opts: PopoverOptions): Popover {
  active?.close();

  let selected = [...opts.selected];
  const search = opts.searchPlaceholder
    ? h('input', {
        class: 'op-pop-search',
        props: { type: 'text', placeholder: opts.searchPlaceholder },
        attrs: { 'aria-label': opts.searchPlaceholder },
      })
    : null;
  const list = h('div', {
    class: 'op-pop-list',
    attrs: { role: 'listbox', 'aria-multiselectable': String(opts.multi) },
  });
  const pop = h('div', { class: 'op-pop' }, search, list);

  const render = () => {
    const needle = search ? normalizeText(search.value.trim()) : '';
    const rows = opts.options.filter((o) => !needle || normalizeText(o.label).includes(needle));
    list.replaceChildren(
      ...(rows.length
        ? rows.map((o) => {
            const on = selected.includes(o.value);
            return h(
              'button',
              {
                class: `op-pop-item${on ? ' is-on' : ''}`,
                attrs: { role: 'option', 'aria-selected': String(on), type: 'button' },
                on: {
                  click: () => {
                    selected = opts.multi
                      ? on
                        ? selected.filter((v) => v !== o.value)
                        : [...selected, o.value]
                      : [o.value];
                    opts.onChange(selected);
                    if (opts.multi) render();
                    else close();
                  },
                },
              },
              h('span', { class: 'op-pop-check' }, on ? icon('check', 12) : null),
              o.lead,
              h('span', { class: 'op-pop-label', text: o.label }),
            );
          })
        : [h('div', { class: 'op-pop-empty', text: opts.emptyText ?? '—' })]),
    );
  };

  const place = () => {
    const a = opts.anchor.getBoundingClientRect();
    const margin = 8;
    pop.style.maxHeight = '';
    const width = Math.max(pop.offsetWidth, 200);
    let left = Math.min(Math.max(margin, a.left), window.innerWidth - width - margin);
    if (left < margin) left = margin;
    const below = window.innerHeight - a.bottom - margin;
    const above = a.top - margin;
    const flip = below < 220 && above > below;
    const maxH = Math.max(160, Math.min(360, flip ? above : below));
    pop.style.maxHeight = `${maxH}px`;
    pop.style.left = `${left}px`;
    pop.style.top = flip ? `${Math.max(margin, a.top - Math.min(maxH, pop.offsetHeight) - 4)}px` : `${a.bottom + 4}px`;
  };

  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as Node;
    if (!pop.contains(target) && !opts.anchor.contains(target)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      opts.anchor.focus();
    }
  };
  const onViewportChange = () => place();

  const close = () => {
    if (active === handle) active = null;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onViewportChange);
    pop.remove();
  };
  const handle: Popover = { close };

  search?.addEventListener('input', render);
  render();
  document.body.appendChild(pop);
  place();
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onViewportChange);
  (search ?? (list.querySelector('.op-pop-item') as HTMLElement | null))?.focus();
  active = handle;
  return handle;
}

export function closeActivePopover(): void {
  active?.close();
}
