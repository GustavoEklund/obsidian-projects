import {
  PRIORITIES,
  displayColumn,
  filterCards,
  groupByColumn,
  isArchivedDone,
  type BoardConfig,
  type Card,
  type CardType,
  type Column,
  type Placement,
} from '@oprojects/core';
import { t } from '../i18n';
import { cardSignature, createCardEl, fillCardEl, setColorUniverse, type CardCtx } from './card-view';
import { createComposer, type Composer } from './composer';
import { h } from './dom';
import { DragController } from './dnd';
import { Drawer } from './drawer';
import type { BoardHost, MenuEntry } from './host';
import { icon } from './icons';
import { closeActivePopover } from './popover';
import { NO_EPIC, defaultState, sanitizeState, toFilter, type UiState } from './state';
import { Toolbar } from './toolbar';

interface ColumnView {
  id: string;
  el: HTMLElement;
  count: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  footer: HTMLElement;
  addBtn: HTMLButtonElement;
  composer: Composer | null;
}

interface Entry {
  el: HTMLElement;
  sig: string;
}

const isTyping = (el: Element | null): boolean =>
  !!el && (el.matches('input, textarea, select') || (el as HTMLElement).isContentEditable);

/**
 * The whole board: toolbar, columns, cards, details drawer. It renders only
 * what changed (cards are keyed and carry a signature) and talks to the world
 * exclusively through a `BoardHost`.
 */
export class BoardUI {
  readonly el: HTMLElement;
  private state: UiState;
  private readonly toolbar: Toolbar;
  private readonly drawer: Drawer;
  private readonly boardEl: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly drag: DragController;
  private readonly unsubscribe: () => void;

  private columns = new Map<string, ColumnView>();
  private columnsSig = '';
  private colorSig = '';
  private entries = new Map<string, Entry>();
  /** Rendered order per column, for keyboard moves. */
  private order = new Map<string, string[]>();
  private raf = 0;
  private dirty = false;
  private dragging = false;
  private pendingReveal: string | null = null;
  private pendingFocus: string | null = null;
  private lastType: CardType = 'task';
  private selectedEl: HTMLElement | null = null;

  constructor(
    container: HTMLElement,
    private readonly host: BoardHost,
    initialState?: unknown,
    private readonly onState?: (state: UiState) => void,
  ) {
    this.state = initialState ? sanitizeState(initialState) : defaultState();

    this.toolbar = new Toolbar(
      host,
      () => this.state,
      (patch) => this.setState(patch),
      () => this.openComposer(),
    );
    this.drawer = new Drawer(host, () => this.closeCard(), {
      width: this.state.drawerWidth,
      onWidth: (drawerWidth) => this.setState({ drawerWidth }),
    });
    this.boardEl = h('div', { class: 'op-board', attrs: { role: 'list' } });
    this.loading = h('div', { class: 'op-loading', text: t('loading'), attrs: { hidden: true } });
    // tabindex -1: clicking empty space inside the board focuses the root, so shortcuts (/, c, Esc) keep working.
    this.el = h(
      'div',
      { class: 'op-root', attrs: { 'aria-label': t('board.title'), tabindex: -1 } },
      this.toolbar.el,
      h('div', { class: 'op-main' }, this.boardEl, this.drawer.el),
      this.loading,
    );
    container.appendChild(this.el);

    this.drag = new DragController(this.boardEl, {
      onStart: () => (this.dragging = true),
      onEnd: () => {
        this.dragging = false;
        if (this.dirty) this.scheduleRender();
      },
      onDrop: (key, status, placement) => this.move(key, status, placement),
    });

    this.boardEl.addEventListener('click', this.onClick);
    this.boardEl.addEventListener('dblclick', this.onDblClick);
    this.boardEl.addEventListener('contextmenu', this.onContextMenu);
    this.boardEl.addEventListener('keydown', this.onCardKey);
    this.el.addEventListener('keydown', this.onRootKey);
    this.unsubscribe = host.subscribe(() => this.scheduleRender());
    this.renderNow();
  }

  // --- public API ---------------------------------------------------------------

  getState(): UiState {
    return this.state;
  }

  setState(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    if ('drawerWidth' in patch) this.drawer.setWidth(this.state.drawerWidth);
    this.onState?.(this.state);
    this.scheduleRender();
  }

  /** Open the inline composer at the bottom of a column (default: the first). */
  openComposer(status?: string): void {
    const config = this.host.config;
    this.ensureColumns(config);
    const col = this.columns.get(status ?? config.columns[0]!.id) ?? this.columns.get(config.columns[0]!.id);
    if (!col) return;
    for (const other of this.columns.values()) if (other !== col) this.closeComposer(other);
    if (!col.composer) {
      col.composer = createComposer({
        type: this.lastType,
        onType: (type) => (this.lastType = type),
        submit: async (title, body, type) => {
          try {
            const card = await this.host.create({ title, body: body || undefined, type, status: col.id });
            this.pendingReveal = card.key;
            this.scheduleRender();
          } catch (e) {
            this.fail(e);
            throw e;
          }
        },
        cancel: () => this.closeComposer(col),
      });
      col.footer.appendChild(col.composer.el);
    }
    col.addBtn.hidden = true;
    col.composer.focus();
    col.composer.el.scrollIntoView({ block: 'nearest' });
  }

  openCard(key: string): void {
    const card = this.host.cards().find((c) => c.key === key);
    if (!card) return;
    this.drawer.open(card);
    this.syncSelection();
  }

  focusSearch(): void {
    this.toolbar.search.focus();
    this.toolbar.search.select();
  }

  /** Render synchronously (tests, first paint). */
  renderNow(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.render();
  }

  destroy(): void {
    this.unsubscribe();
    this.drag.destroy();
    this.drawer.destroy();
    closeActivePopover();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.el.remove();
  }

  // --- rendering ------------------------------------------------------------------

  private scheduleRender(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private render(): void {
    // Re-rendering mid-drag could remove the card being dragged and cancel the drag.
    if (this.dragging) {
      this.dirty = true;
      return;
    }
    this.dirty = false;

    const config = this.host.config;
    const now = this.host.now();
    this.ensureColumns(config);

    const all = this.host.cards();
    this.updateColors(all, config);
    const byKey = new Map(all.map((c) => [c.key, c]));
    const ctx: CardCtx = { config, byKey, now };
    const s = this.state;

    const base = all.filter(
      (c) => (s.showEpics || c.type !== 'epic') && (s.showArchived || !isArchivedDone(c, config, now)),
    );
    let visible = filterCards(base, toFilter(s, config), config);
    if (s.parent === NO_EPIC) visible = visible.filter((c) => !c.parent);
    const filtering = visible.length !== base.length;

    const totals = new Map<string, number>();
    for (const c of base) {
      const id = displayColumn(config, c.status).id;
      totals.set(id, (totals.get(id) ?? 0) + 1);
    }

    this.order.clear();
    for (const { column, cards } of groupByColumn(visible, config)) {
      const col = this.columns.get(column.id)!;
      this.reconcile(col.list, cards, ctx);
      this.order.set(
        column.id,
        cards.map((c) => c.key),
      );
      this.updateHeader(col, column, cards.length, totals.get(column.id) ?? 0);
      col.empty.hidden = cards.length > 0;
      col.empty.textContent = filtering ? t('empty.filtered') : t('empty.column');
    }
    // Keep the elements of cards that are merely filtered out (detached, so clearing a search just
    // re-attaches them); forget only cards that no longer exist.
    for (const key of this.entries.keys()) if (!byKey.has(key)) this.entries.delete(key);

    this.toolbar.sync();
    this.drawer.refresh();
    this.syncSelection();
    this.loading.hidden = this.host.ready;

    if (this.pendingReveal) {
      this.entries.get(this.pendingReveal)?.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      this.pendingReveal = null;
    }
    if (this.pendingFocus) {
      this.entries.get(this.pendingFocus)?.el.focus({ preventScroll: false });
      this.pendingFocus = null;
    }
  }

  /** Keyed reconcile: reuse elements, only touch the DOM where the order or content changed. */
  private reconcile(list: HTMLElement, cards: Card[], ctx: CardCtx): void {
    let cursor = list.firstElementChild;
    for (const card of cards) {
      let entry = this.entries.get(card.key);
      if (!entry) {
        entry = { el: createCardEl(card.key), sig: '' };
        this.entries.set(card.key, entry);
      }
      const sig = cardSignature(card, ctx);
      if (entry.sig !== sig) {
        fillCardEl(entry.el, card, ctx);
        entry.sig = sig;
      }
      if (entry.el === cursor) cursor = cursor.nextElementSibling;
      else list.insertBefore(entry.el, cursor);
    }
    while (cursor) {
      const next: Element | null = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
  }

  private updateHeader(col: ColumnView, column: Column, shown: number, total: number): void {
    if (column.wip) {
      const over = total > column.wip;
      col.count.textContent = `${total}/${column.wip}`;
      col.count.classList.toggle('is-over', over);
      col.count.title = over ? t('wip.exceeded', { count: total, wip: column.wip }) : '';
      col.el.classList.toggle('op-col-wip-over', over);
    } else {
      col.count.textContent = String(shown);
    }
  }

  /** Re-derive avatar/epic colors only when the set of people or epics actually changed. */
  private updateColors(cards: readonly Card[], config: BoardConfig): void {
    const people = new Set(config.members.map((m) => m.toLowerCase()));
    const epics = new Set<string>();
    for (const c of cards) {
      if (c.assignee) people.add(c.assignee.toLowerCase());
      if (c.parent) epics.add(c.parent);
      if (c.type === 'epic') epics.add(c.key);
    }
    const sig = `${[...people].sort().join('|')}#${[...epics].sort().join('|')}`;
    if (sig === this.colorSig) return;
    this.colorSig = sig;
    setColorUniverse(people, epics);
  }

  private ensureColumns(config: BoardConfig): void {
    const sig = config.columns.map((c) => `${c.id}:${c.name}:${c.done ? 1 : 0}:${c.wip ?? 0}`).join('|');
    if (sig === this.columnsSig) return;
    this.columnsSig = sig;
    this.columns = new Map(config.columns.map((c) => [c.id, this.buildColumn(c)]));
    this.boardEl.replaceChildren(...[...this.columns.values()].map((c) => c.el));
    // Card elements survive column changes: the next reconcile moves them into the new lists.
  }

  private buildColumn(column: Column): ColumnView {
    const count = h('span', { class: 'op-col-count' });
    const list = h('div', { class: 'op-col-list', attrs: { role: 'list' } });
    const empty = h('div', { class: 'op-col-empty' });
    const addBtn = h(
      'button',
      { class: 'op-add', attrs: { type: 'button' }, on: { click: () => this.openComposer(column.id) } },
      icon('plus', 14),
      h('span', { text: t('create') }),
    );
    const footer = h('footer', { class: 'op-col-foot' }, addBtn);
    const el = h(
      'section',
      {
        class: `op-col${column.done ? ' op-col-is-done' : ''}`,
        attrs: { 'data-col': column.id, role: 'group', 'aria-label': column.name },
      },
      h(
        'header',
        { class: 'op-col-head' },
        column.done ? icon('check', 14) : null,
        h('span', { class: 'op-col-name', text: column.name }),
        count,
      ),
      h('div', { class: 'op-col-scroll' }, list, h('div', { class: 'op-drop-line', attrs: { hidden: true } }), empty),
      footer,
    );
    return { id: column.id, el, count, list, empty, footer, addBtn, composer: null };
  }

  private closeComposer(col: ColumnView): void {
    col.composer?.el.remove();
    col.composer = null;
    col.addBtn.hidden = false;
  }

  private syncSelection(): void {
    const el = this.drawer.openKey ? (this.entries.get(this.drawer.openKey)?.el ?? null) : null;
    if (el !== this.selectedEl) {
      this.selectedEl?.classList.remove('op-selected');
      el?.classList.add('op-selected');
      this.selectedEl = el;
    }
    this.el.classList.toggle('op-drawer-open', this.drawer.isOpen());
  }

  private closeCard(): void {
    const key = this.drawer.openKey;
    this.drawer.close();
    this.syncSelection();
    if (key) this.entries.get(key)?.el.focus({ preventScroll: true });
  }

  // --- actions --------------------------------------------------------------------

  private move(key: string, status: string, placement: Placement = {}): void {
    this.pendingFocus = key;
    this.host.move(key, status, placement).catch((e) => this.fail(e));
  }

  private fail(e: unknown): void {
    this.host.notify(t('error.generic', { message: e instanceof Error ? e.message : String(e) }));
  }

  private cardFrom(e: Event): { el: HTMLElement; card: Card } | null {
    const el = (e.target as Element).closest<HTMLElement>('.op-card');
    const card = el && this.host.cards().find((c) => c.key === el.dataset.key);
    return el && card ? { el, card } : null;
  }

  // --- events ---------------------------------------------------------------------

  private onClick = (e: MouseEvent): void => {
    const hit = this.cardFrom(e);
    if (!hit) return;
    if (e.ctrlKey || e.metaKey) this.host.openNote(hit.card, { newTab: true });
    else this.openCard(hit.card.key);
  };

  private onDblClick = (e: MouseEvent): void => {
    const hit = this.cardFrom(e);
    if (hit) this.host.openNote(hit.card);
  };

  private onContextMenu = (e: MouseEvent): void => {
    const hit = this.cardFrom(e);
    if (!hit) return;
    e.preventDefault();
    this.host.menu(e, this.menuFor(hit.card));
  };

  private menuFor(card: Card): MenuEntry[] {
    const config = this.host.config;
    const current = displayColumn(config, card.status).id;
    const me = config.me;
    const entries: MenuEntry[] = [
      { label: t('action.open'), onClick: () => this.openCard(card.key) },
      { label: t('action.openNote'), onClick: () => this.host.openNote(card) },
      { label: t('action.openNoteTab'), onClick: () => this.host.openNote(card, { newTab: true }) },
      { separator: true },
      ...config.columns.map((c) => ({
        label: t('action.moveTo', { column: c.name }),
        checked: c.id === current,
        onClick: () => c.id !== current && this.move(card.key, c.id),
      })),
      { separator: true },
      ...PRIORITIES.map((p) => ({
        label: t('action.setPriority', { priority: t(`priority.${p}`) }),
        checked: p === card.priority,
        onClick: () => this.update(card.key, { priority: p }),
      })),
      { separator: true },
    ];
    if (me && card.assignee !== me)
      entries.push({ label: t('action.assignMe'), onClick: () => this.update(card.key, { assignee: me }) });
    if (card.assignee)
      entries.push({ label: t('action.unassign'), onClick: () => this.update(card.key, { assignee: null }) });
    entries.push(
      { label: t('action.copyKey'), onClick: () => this.copy(card.key) },
      { label: t('action.copyLink'), onClick: () => this.copy(`[[${card.key}]]`) },
      { separator: true },
      { label: t('action.delete'), danger: true, onClick: () => void this.confirmDelete(card) },
    );
    return entries;
  }

  private update(key: string, patch: Parameters<BoardHost['update']>[1]): void {
    this.host.update(key, patch).catch((e) => this.fail(e));
  }

  private copy(text: string): void {
    this.host.copy(text);
    this.host.notify(t('copied', { text }));
  }

  private async confirmDelete(card: Card): Promise<void> {
    if (!(await this.host.confirm(t('delete.confirm', { key: card.key }), t('delete.button')))) return;
    try {
      await this.host.remove(card.key);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Enter/Space open a card; Alt+arrows move it (left/right = column, up/down = position). */
  private onCardKey = (e: KeyboardEvent): void => {
    const hit = (e.target as Element).matches('.op-card') ? this.cardFrom(e) : null;
    if (!hit) return;
    const { card } = hit;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.openCard(card.key);
      return;
    }
    if (!e.altKey) return;
    const config = this.host.config;
    const colId = displayColumn(config, card.status).id;
    const idx = config.columns.findIndex((c) => c.id === colId);
    const keys = this.order.get(colId) ?? [];
    const pos = keys.indexOf(card.key);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const target = config.columns[idx + (e.key === 'ArrowLeft' ? -1 : 1)];
      if (target) this.move(card.key, target.id);
    } else if (e.key === 'ArrowUp' && pos > 0) this.move(card.key, colId, { before: keys[pos - 1]! });
    else if (e.key === 'ArrowDown' && pos >= 0 && pos < keys.length - 1)
      this.move(card.key, colId, { after: keys[pos + 1]! });
    else return;
    e.preventDefault();
  };

  private onRootKey = (e: KeyboardEvent): void => {
    const typing = isTyping(e.target as Element);
    if (e.key === 'Escape' && !typing && this.drawer.isOpen()) {
      e.preventDefault();
      this.closeCard();
    } else if (e.key === 'Escape' && e.target === this.toolbar.search && this.state.text) {
      this.toolbar.search.value = '';
      this.setState({ text: '' });
    } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === '/') {
        e.preventDefault();
        this.focusSearch();
      } else if (e.key === 'c') {
        e.preventDefault();
        this.openComposer();
      }
    }
  };
}
