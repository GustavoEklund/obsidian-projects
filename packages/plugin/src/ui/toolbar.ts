import { CARD_TYPES, PRIORITIES, UNASSIGNED } from '@oprojects/core';
import { t } from '../i18n';
import { avatar, priorityMark, typeBadge } from './card-view';
import { h } from './dom';
import { icon } from './icons';
import type { BoardHost } from './host';
import { openPopover, type PopoverOption } from './popover';
import { NO_EPIC, activeFilterCount, type UiState } from './state';

interface Pill {
  el: HTMLButtonElement;
  count: HTMLElement;
}

/** Search box, filter pills, view toggles and the create button. */
export class Toolbar {
  readonly el: HTMLElement;
  readonly search: HTMLInputElement;
  private readonly searchClear: HTMLButtonElement;
  private readonly pills: Record<'assignee' | 'type' | 'priority' | 'labels' | 'parent', Pill>;
  private readonly mine: HTMLButtonElement;
  private readonly epics: HTMLButtonElement;
  private readonly archived: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;

  constructor(
    private readonly host: BoardHost,
    private readonly get: () => UiState,
    private readonly set: (patch: Partial<UiState>) => void,
    onCreate: () => void,
  ) {
    this.search = h('input', { class: 'op-search-input', props: { type: 'search', placeholder: t('search.placeholder'), autocomplete: 'off', spellcheck: false }, attrs: { 'aria-label': t('search.placeholder') } });
    this.search.addEventListener('input', () => {
      this.set({ text: this.search.value });
    });
    this.searchClear = h('button', { class: 'op-search-clear', attrs: { type: 'button', 'aria-label': t('filter.clear'), hidden: true }, on: { click: () => this.clearSearch() } }, icon('x', 12));

    const pill = (label: string, open: (anchor: HTMLButtonElement) => void): Pill => {
      const count = h('span', { class: 'op-pill-count', attrs: { hidden: true } });
      const el = h('button', { class: 'op-pill', attrs: { type: 'button', 'aria-haspopup': 'listbox' }, on: { click: () => open(el) } }, h('span', { text: label }), count, icon('chevron', 12));
      return { el, count };
    };

    this.pills = {
      assignee: pill(t('filter.assignee'), (a) => this.openAssignee(a)),
      type: pill(t('filter.type'), (a) => this.openType(a)),
      priority: pill(t('filter.priority'), (a) => this.openPriority(a)),
      labels: pill(t('filter.label'), (a) => this.openLabels(a)),
      parent: pill(t('filter.epic'), (a) => this.openEpic(a)),
    };

    this.mine = this.toggle('user', t('filter.mine'), '', () => this.set({ mine: !this.get().mine }));
    this.epics = this.toggle('layers', t('view.epics'), t('view.epics.hint'), () => this.set({ showEpics: !this.get().showEpics }));
    this.archived = this.toggle('archive', t('view.archived'), t('view.archived.hint'), () => this.set({ showArchived: !this.get().showArchived }));
    this.clearBtn = h('button', { class: 'op-link-btn', text: t('filter.clear'), attrs: { type: 'button', hidden: true }, on: { click: () => this.clearAll() } });

    const create = h('button', { class: 'op-btn-primary', attrs: { type: 'button' }, on: { click: onCreate } }, icon('plus', 14), h('span', { class: 'op-btn-label', text: t('create') }));

    this.el = h(
      'div',
      { class: 'op-toolbar', attrs: { role: 'toolbar' } },
      h('div', { class: 'op-search' }, icon('search', 14), this.search, this.searchClear),
      h('div', { class: 'op-filters' }, this.pills.assignee.el, this.pills.type.el, this.pills.priority.el, this.pills.labels.el, this.pills.parent.el, this.mine, this.clearBtn),
      h('span', { class: 'op-spacer' }),
      h('div', { class: 'op-views' }, this.epics, this.archived),
      create,
    );
  }

  /** Reflect the current state in the controls (never touches the search box while it has focus). */
  sync(): void {
    const s = this.get();
    const cfg = this.host.config;
    if (this.search.ownerDocument.activeElement !== this.search && this.search.value !== s.text) this.search.value = s.text;
    this.searchClear.hidden = !s.text;

    const counts = { assignee: s.assignee.length, type: s.type.length, priority: s.priority.length, labels: s.labels.length, parent: s.parent ? 1 : 0 };
    for (const [k, pill] of Object.entries(this.pills) as [keyof typeof counts, Pill][]) {
      const n = counts[k];
      pill.el.classList.toggle('is-active', n > 0);
      pill.count.hidden = n === 0;
      pill.count.textContent = String(n);
    }
    this.setPressed(this.mine, s.mine);
    this.mine.hidden = !cfg.me;
    this.setPressed(this.epics, s.showEpics);
    this.setPressed(this.archived, s.showArchived);
    this.clearBtn.hidden = activeFilterCount(s) === 0;
  }

  // --- pieces ---------------------------------------------------------------------

  private toggle(name: Parameters<typeof icon>[0], label: string, hint: string, onClick: () => void): HTMLButtonElement {
    return h('button', { class: 'op-toggle', attrs: { type: 'button', 'aria-pressed': false, title: hint || label }, on: { click: onClick } }, icon(name, 14), h('span', { class: 'op-toggle-label', text: label }));
  }

  private setPressed(btn: HTMLButtonElement, on: boolean): void {
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('is-on', on);
  }

  private clearSearch(): void {
    this.search.value = '';
    this.set({ text: '' });
    this.search.focus();
  }

  private clearAll(): void {
    this.search.value = '';
    this.set({ text: '', assignee: [], type: [], priority: [], labels: [], parent: null, mine: false });
  }

  private openAssignee(anchor: HTMLButtonElement): void {
    const cards = this.host.cards();
    const names = [...new Set([...this.host.config.members, ...cards.map((c) => c.assignee).filter((a): a is string => !!a)])].sort((a, b) => a.localeCompare(b));
    const options: PopoverOption[] = [
      { value: UNASSIGNED, label: t('filter.unassigned'), lead: h('span', { class: 'op-avatar op-avatar-empty', style: { '--op-size': '18px' } }, icon('user', 11)) },
      ...names.map((n) => ({ value: n, label: n, lead: avatar(n, 18) })),
    ];
    openPopover({ anchor, options, selected: this.get().assignee, multi: true, onChange: (assignee) => this.set({ assignee }), searchPlaceholder: names.length > 7 ? t('search.placeholder') : undefined });
  }

  private openType(anchor: HTMLButtonElement): void {
    const options = CARD_TYPES.map((x) => ({ value: x, label: t(`type.${x}`), lead: typeBadge(x, 16) }));
    openPopover({ anchor, options, selected: this.get().type, multi: true, onChange: (type) => this.set({ type: type as UiState['type'] }) });
  }

  private openPriority(anchor: HTMLButtonElement): void {
    const options = PRIORITIES.map((x) => ({ value: x, label: t(`priority.${x}`), lead: priorityMark(x) }));
    openPopover({ anchor, options, selected: this.get().priority, multi: true, onChange: (priority) => this.set({ priority: priority as UiState['priority'] }) });
  }

  private openLabels(anchor: HTMLButtonElement): void {
    const labels = [...new Set(this.host.cards().flatMap((c) => c.labels))].sort((a, b) => a.localeCompare(b));
    openPopover({ anchor, options: labels.map((l) => ({ value: l, label: l })), selected: this.get().labels, multi: true, onChange: (l) => this.set({ labels: l }), searchPlaceholder: labels.length > 7 ? t('search.placeholder') : undefined, emptyText: '—' });
  }

  private openEpic(anchor: HTMLButtonElement): void {
    const epics = this.host.cards().filter((c) => c.type === 'epic');
    const options: PopoverOption[] = [{ value: NO_EPIC, label: t('filter.noEpic') }, ...epics.map((e) => ({ value: e.key, label: `${e.key} · ${e.title}` }))];
    const current = this.get().parent;
    openPopover({
      anchor,
      options,
      selected: current ? [current] : [],
      multi: false,
      // Picking the active epic again turns the filter off.
      onChange: ([value]) => this.set({ parent: value === current ? null : (value ?? null) }),
    });
  }
}
