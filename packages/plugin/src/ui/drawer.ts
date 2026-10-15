import {
  CARD_TYPES,
  PRIORITIES,
  displayColumn,
  normalizeLabels,
  toggleTask,
  type Card,
  type CardPatch,
} from '@oprojects/core';
import { t, timeAgo } from '../i18n';
import { autosize, debounce, h } from './dom';
import { icon } from './icons';
import type { BoardHost } from './host';
import { typeBadge } from './card-view';
import { CommentsPanel } from './comments';

let uid = 0;

const MIN_WIDTH = 300;
/** Room always left for the board next to the panel (when the panel does not overlay it). */
const BOARD_MIN = 260;
const KEY_STEP = 16;

export interface DrawerSizing {
  /** Width restored from the saved view state; null = default. */
  width: number | null;
  /** Called when the user finishes resizing (not on every pixel). */
  onWidth(width: number | null): void;
}

/** Text of the description as shown in the editor (no leading blank line from the frontmatter fence). */
const bodyForEdit = (body: string) => body.replace(/^\n+/, '').replace(/\s+$/, '');
/** Inverse of `bodyForEdit`, matching how new cards are written. */
const bodyForSave = (text: string) => (text.trim() ? `\n${text.replace(/\s+$/, '')}\n` : '');

/**
 * Side panel with every field of one card. Edits save themselves (selects and
 * dates immediately, text after a short pause or on blur) and the panel never
 * overwrites a field you are currently typing in.
 */
export class Drawer {
  readonly el: HTMLElement;
  private card: Card | null = null;
  /** Reading is the default; the editor appears when you click the text (or the Write tab). */
  private tab: 'write' | 'preview' = 'preview';
  private previewSig = '';
  private previewToken = 0;

  private readonly head: HTMLElement;
  private readonly keyBtn: HTMLButtonElement;
  private readonly title: HTMLTextAreaElement;
  private readonly status = h('select', { class: 'op-input' });
  private readonly type = h('select', { class: 'op-input' });
  private readonly priority = h('select', { class: 'op-input' });
  private readonly assignee: HTMLInputElement;
  private readonly labelsBox = h('div', { class: 'op-labels-input' });
  private readonly labelInput: HTMLInputElement;
  private readonly due = h('input', { class: 'op-input', props: { type: 'date' } });
  private readonly estimate = h('input', {
    class: 'op-input',
    props: { type: 'number', min: '0', step: '0.5', placeholder: '—' },
  });
  private readonly parent = h('select', { class: 'op-input' });
  private readonly desc: HTMLTextAreaElement;
  private readonly preview = h('div', {
    class: 'op-preview markdown-rendered',
    attrs: { tabindex: 0, role: 'button', title: t('desc.edit') },
  });
  private readonly tabWrite: HTMLButtonElement;
  private readonly tabPreview: HTMLButtonElement;
  private readonly times = h('div', { class: 'op-times' });
  private readonly members = h('datalist', { props: { id: `op-members-${++uid}` } });
  private readonly knownLabels = h('datalist', { props: { id: `op-labels-${uid}` } });
  private readonly comments: CommentsPanel;
  private optionsSig = '';
  private readonly saveDesc: ReturnType<typeof debounce<[]>>;

  constructor(
    private readonly host: BoardHost,
    private readonly onClose: () => void,
    private readonly sizing: DrawerSizing = { width: null, onWidth: () => {} },
  ) {
    this.comments = new CommentsPanel(host);
    this.keyBtn = h('button', {
      class: 'op-key-btn',
      attrs: { type: 'button' },
      on: { click: () => this.card && this.copy(this.card.key) },
    });
    this.head = h(
      'div',
      { class: 'op-drawer-head' },
      h('span', { class: 'op-drawer-id' }),
      h('span', { class: 'op-spacer' }),
      this.iconButton(
        'external',
        t('action.openNote'),
        (e) => this.card && this.host.openNote(this.card, { newTab: e.ctrlKey || e.metaKey }),
      ),
      this.iconButton('trash', t('action.delete'), () => void this.remove(), 'op-danger'),
      this.iconButton('x', t('action.close'), () => this.onClose()),
    );

    this.title = h('textarea', {
      class: 'op-title-input',
      props: { rows: 1, placeholder: t('field.title') },
      attrs: { 'aria-label': t('field.title') },
    });
    this.title.addEventListener('input', () => autosize(this.title));
    this.title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.title.blur();
      } else if (e.key === 'Escape' && this.card) {
        e.stopPropagation();
        this.title.value = this.card.title;
        autosize(this.title);
        this.title.blur();
      }
    });
    this.title.addEventListener('blur', () => {
      const v = this.title.value.replace(/\s+/g, ' ').trim();
      if (!this.card) return;
      if (!v) this.title.value = this.card.title;
      else if (v !== this.card.title) this.commit({ title: v });
      autosize(this.title);
    });

    this.status.addEventListener(
      'change',
      () => this.card && void this.host.move(this.card.key, this.status.value).catch((e) => this.fail(e)),
    );
    this.type.addEventListener('change', () => this.commit({ type: this.type.value as Card['type'] }));
    this.priority.addEventListener('change', () => this.commit({ priority: this.priority.value as Card['priority'] }));
    this.due.addEventListener('change', () => this.commit({ due: this.due.value || null }));
    this.estimate.addEventListener('change', () =>
      this.commit({ estimate: this.estimate.value === '' ? null : Number(this.estimate.value) }),
    );
    this.parent.addEventListener('change', () => this.commit({ parent: this.parent.value || null }));

    this.assignee = h('input', {
      class: 'op-input',
      props: { type: 'text', placeholder: t('assignee.placeholder'), autocomplete: 'off' },
      attrs: { list: this.members.id },
    });
    this.assignee.addEventListener('change', () => this.commit({ assignee: this.assignee.value.trim() || null }));

    this.labelInput = h('input', {
      class: 'op-label-field',
      props: { type: 'text', placeholder: t('label.add'), autocomplete: 'off' },
      attrs: { list: this.knownLabels.id, 'aria-label': t('field.labels') },
    });
    this.labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        this.addLabels();
      } else if (e.key === 'Backspace' && !this.labelInput.value && this.card?.labels.length) {
        this.commit({ labels: this.card.labels.slice(0, -1) });
      }
    });
    this.labelInput.addEventListener('blur', () => this.addLabels());

    this.saveDesc = debounce(() => this.commitDescription(), 700);
    this.desc = h('textarea', {
      class: 'op-desc',
      props: { placeholder: t('desc.placeholder'), rows: 6 },
      attrs: { 'aria-label': t('field.description'), spellcheck: 'true' },
    });
    this.desc.addEventListener('input', () => {
      autosize(this.desc);
      this.saveDesc();
    });
    this.desc.addEventListener('blur', () => {
      this.saveDesc.flush();
      // Done editing: back to reading. (Not when the whole window lost focus, e.g. alt-tab mid-sentence.)
      if (this.desc.ownerDocument.hasFocus()) this.setTab('preview');
    });
    this.desc.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.setTab('preview');
    });
    this.preview.addEventListener('click', (e) => {
      // A rendered checkbox is only a picture of the task: write the change back to the text.
      const box = (e.target as Element).closest<HTMLInputElement>('input[type="checkbox"]');
      if (box) {
        e.preventDefault();
        this.toggleTask(box);
        return;
      }
      if ((e.target as Element).closest('a, input, button, summary, details, .callout-fold')) return; // let links work
      if (this.preview.ownerDocument.getSelection()?.toString()) return; // selecting text to copy, not editing
      this.setTab('write', true);
    });
    this.preview.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target !== this.preview) return;
      e.preventDefault();
      this.setTab('write', true);
    });

    this.tabWrite = h('button', {
      class: 'op-tab',
      text: t('desc.write'),
      attrs: { type: 'button' },
      on: { click: () => this.setTab('write', true) },
    });
    this.tabPreview = h('button', {
      class: 'op-tab is-on',
      text: t('desc.preview'),
      attrs: { type: 'button' },
      on: { click: () => this.setTab('preview') },
    });

    const row = (label: string, control: Node) =>
      h(
        'div',
        { class: 'op-field' },
        h('label', { class: 'op-field-label', text: label }),
        h('div', { class: 'op-field-control' }, control),
      );

    this.el = h(
      'aside',
      { class: 'op-drawer', attrs: { hidden: true, role: 'complementary', 'aria-label': t('action.open') } },
      this.resizer(),
      this.head,
      h(
        'div',
        { class: 'op-drawer-body' },
        this.title,
        h(
          'div',
          { class: 'op-fields' },
          row(t('field.status'), this.status),
          row(t('field.priority'), this.priority),
          row(t('field.type'), this.type),
          row(t('field.assignee'), this.assignee),
          row(t('field.labels'), this.labelsBox),
          row(t('field.due'), this.due),
          row(t('field.estimate'), this.estimate),
          row(t('field.epic'), this.parent),
        ),
        h(
          'div',
          { class: 'op-desc-head' },
          h('span', { class: 'op-section-title', text: t('field.description') }),
          h('span', { class: 'op-spacer' }),
          this.tabWrite,
          this.tabPreview,
        ),
        this.desc,
        this.preview,
        this.comments.el,
        this.times,
        this.members,
        this.knownLabels,
      ),
    );
    this.desc.hidden = true; // starts in reading mode
    this.setWidth(this.sizing.width);
    this.labelsBox.addEventListener('click', (e) => {
      if (e.target === this.labelsBox) this.labelInput.focus();
    });
  }

  /** Apply a width (px) or null for the default. The CSS clamps it to what fits the pane. */
  setWidth(width: number | null): void {
    if (width === null) this.el.style.removeProperty('--op-drawer-w');
    else this.el.style.setProperty('--op-drawer-w', `${width}px`);
  }

  /** Drag handle on the panel's left edge: pointer drag, arrow keys, double-click to reset. */
  private resizer(): HTMLElement {
    const handle = h('div', {
      class: 'op-drawer-resizer',
      attrs: {
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': t('drawer.resize'),
        title: t('drawer.resize'),
        tabindex: 0,
      },
    });
    let startX = 0;
    let startWidth = 0;
    let dragging = false;

    const current = () => this.el.getBoundingClientRect().width;
    const limits = () => {
      const host = this.el.parentElement?.getBoundingClientRect().width ?? 0;
      const overlay = getComputedStyle(this.el).position === 'absolute'; // narrow panes: the panel floats over the board
      return { min: MIN_WIDTH, max: Math.max(MIN_WIDTH, overlay ? host : host - BOARD_MIN) };
    };
    const apply = (width: number) => {
      const { min, max } = limits();
      this.setWidth(Math.round(Math.min(max, Math.max(min, width))));
    };
    const commit = () => this.sizing.onWidth(Math.round(current()));
    const root = () => this.el.closest('.op-root');

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      dragging = true;
      startX = e.clientX;
      startWidth = current();
      root()?.classList.add('op-resizing');
    });
    handle.addEventListener('pointermove', (e) => {
      if (dragging) apply(startWidth + (startX - e.clientX)); // the panel is on the right: dragging left widens it
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      root()?.classList.remove('op-resizing');
      commit();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', () => {
      this.setWidth(null);
      this.sizing.onWidth(null);
    });
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? KEY_STEP * 3 : KEY_STEP;
      if (e.key === 'ArrowLeft') apply(current() + step);
      else if (e.key === 'ArrowRight') apply(current() - step);
      else if (e.key === 'Home' || e.key === 'Escape') {
        this.setWidth(null);
        this.sizing.onWidth(null);
      } else return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== 'Home' && e.key !== 'Escape') commit();
    });
    return handle;
  }

  get openKey(): string | null {
    return this.card?.key ?? null;
  }

  isOpen(): boolean {
    return !this.el.hidden;
  }

  open(card: Card): void {
    if (this.card?.key !== card.key) {
      this.setTab('preview');
      this.comments.reset();
    }
    this.el.hidden = false;
    this.bind(card);
  }

  close(): void {
    this.saveDesc.flush();
    this.el.hidden = true;
    this.card = null;
    this.comments.release();
    this.host.releaseMarkdown(this.preview);
    this.previewSig = '';
  }

  /** Re-sync with the latest data; closes if the card no longer exists. */
  refresh(): void {
    if (this.el.hidden || !this.card) return;
    const latest = this.host.cards().find((c) => c.key === this.card!.key);
    if (!latest) {
      this.close();
      this.onClose();
      return;
    }
    this.bind(latest);
  }

  destroy(): void {
    this.saveDesc.cancel();
    this.comments.release();
    this.host.releaseMarkdown(this.preview);
    this.el.remove();
  }

  // --- binding -------------------------------------------------------------

  private bind(card: Card): void {
    this.card = card;
    const config = this.host.config;
    const all = this.host.cards();

    const idEl = this.head.querySelector('.op-drawer-id')!;
    this.keyBtn.textContent = card.key;
    this.keyBtn.title = t('action.copyKey');
    idEl.replaceChildren(typeBadge(card.type, 18), this.keyBtn);

    this.setIdle(this.title, card.title);
    autosize(this.title);

    // Option lists only change with the config / known cards; rebuilding on every keystroke elsewhere would reset open selects.
    const epics = all.filter((c) => c.type === 'epic' && c.key !== card.key);
    const parentKnown = !card.parent || epics.some((e) => e.key === card.parent);
    const sig = [
      config.columns.map((c) => `${c.id}:${c.name}`).join('|'),
      epics.map((e) => `${e.key}:${e.title}`).join('|'),
      card.parent ?? '',
      parentKnown,
    ].join('#');
    if (sig !== this.optionsSig) {
      this.optionsSig = sig;
      this.status.replaceChildren(...config.columns.map((c) => h('option', { text: c.name, props: { value: c.id } })));
      this.type.replaceChildren(...CARD_TYPES.map((x) => h('option', { text: t(`type.${x}`), props: { value: x } })));
      this.priority.replaceChildren(
        ...PRIORITIES.map((x) => h('option', { text: t(`priority.${x}`), props: { value: x } })),
      );
      this.parent.replaceChildren(
        h('option', { text: t('none'), props: { value: '' } }),
        ...epics.map((e) => h('option', { text: `${e.key} · ${e.title}`, props: { value: e.key } })),
        ...(parentKnown ? [] : [h('option', { text: card.parent!, props: { value: card.parent! } })]),
      );
      this.members.replaceChildren(
        ...[...new Set([...config.members, ...all.map((c) => c.assignee).filter((a): a is string => !!a)])]
          .sort()
          .map((m) => h('option', { props: { value: m } })),
      );
      this.knownLabels.replaceChildren(
        ...[...new Set(all.flatMap((c) => c.labels))].sort().map((l) => h('option', { props: { value: l } })),
      );
    }
    this.status.value = displayColumn(config, card.status).id;
    this.type.value = card.type;
    this.priority.value = card.priority;
    this.parent.value = card.parent ?? '';
    this.setIdle(this.assignee, card.assignee ?? '');
    this.setIdle(this.due, card.due ?? '');
    this.setIdle(this.estimate, card.estimate === undefined ? '' : String(card.estimate));
    this.renderLabels(card);

    const text = bodyForEdit(card.body);
    this.setIdle(this.desc, text);
    autosize(this.desc);
    if (this.tab === 'preview') this.showPreview(this.desc.value);
    this.comments.bind(card);

    const now = this.host.now();
    this.times.textContent = [
      t('time.created', { when: timeAgo(card.created, now) }),
      t('time.updated', { when: timeAgo(card.updated, now) }),
    ].join(' · ');
  }

  /** Update a control from data unless the user is typing in it right now. */
  private setIdle(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    if (control.ownerDocument.activeElement === control) return;
    if (control.value !== value) control.value = value;
  }

  private renderLabels(card: Card): void {
    this.labelsBox.replaceChildren(
      ...card.labels.map((l) =>
        h(
          'span',
          { class: 'op-label op-label-edit' },
          l,
          h(
            'button',
            {
              class: 'op-label-x',
              attrs: { type: 'button', 'aria-label': `${t('label.remove')}: ${l}`, title: t('label.remove') },
              on: { click: () => this.commit({ labels: card.labels.filter((x) => x !== l) }) },
            },
            icon('x', 10),
          ),
        ),
      ),
      this.labelInput,
    );
  }

  private addLabels(): void {
    const raw = this.labelInput.value;
    if (!raw.trim() || !this.card) return;
    this.labelInput.value = '';
    this.commit({ labels: normalizeLabels([...this.card.labels, ...raw.split(',')]) });
  }

  // --- description ----------------------------------------------------------

  private setTab(tab: 'write' | 'preview', focus = false): void {
    if (tab === 'preview') this.saveDesc.flush(); // save before the editor disappears
    this.tab = tab;
    this.tabWrite.classList.toggle('is-on', tab === 'write');
    this.tabPreview.classList.toggle('is-on', tab === 'preview');
    this.desc.hidden = tab !== 'write';
    this.preview.hidden = tab !== 'preview';
    if (tab === 'preview') {
      this.showPreview(this.desc.value);
    } else {
      autosize(this.desc);
      if (focus) {
        this.desc.focus();
        this.desc.setSelectionRange(this.desc.value.length, this.desc.value.length);
      }
    }
  }

  private toggleTask(box: HTMLInputElement): void {
    const index = [...this.preview.querySelectorAll('input[type="checkbox"]')].indexOf(box);
    const next = index < 0 ? null : toggleTask(this.desc.value, index);
    if (next === null) return;
    this.desc.value = next;
    this.commitDescription();
    this.showPreview(next); // show the new state now; the saved card confirms it a frame later
  }

  /**
   * Render the description as Markdown, but only when it changed. The result is built off-screen and
   * swapped in at once: rendering is asynchronous and appends, so rendering straight into the visible
   * element could duplicate content when two updates overlap.
   */
  private showPreview(markdown: string): void {
    const card = this.card;
    if (!card) return;
    const sig = `${card.key}\u0000${markdown}`;
    if (sig === this.previewSig) return;
    this.previewSig = sig;
    const token = ++this.previewToken;

    if (!markdown.trim()) {
      this.host.releaseMarkdown(this.preview);
      this.preview.replaceChildren(h('div', { class: 'op-preview-empty', text: t('desc.add') }));
      return;
    }
    const content = h('div', { class: 'op-preview-content' });
    void Promise.resolve(this.host.renderMarkdown(content, markdown, card.path)).then(
      () => {
        if (token !== this.previewToken) return void this.host.releaseMarkdown(content); // superseded
        this.host.releaseMarkdown(this.preview); // free the previous render before replacing it
        this.preview.replaceChildren(content);
      },
      () => {
        if (token === this.previewToken) this.preview.textContent = markdown;
      },
    );
  }

  private commitDescription(): void {
    if (!this.card) return;
    if (this.desc.value.replace(/\s+$/, '') === bodyForEdit(this.card.body)) return;
    this.commit({ body: bodyForSave(this.desc.value) });
  }

  // --- actions ----------------------------------------------------------------

  private commit(patch: CardPatch): void {
    const card = this.card;
    if (!card) return;
    void this.host.update(card.key, patch).catch((e) => this.fail(e));
  }

  private fail(e: unknown): void {
    this.host.notify(t('error.generic', { message: e instanceof Error ? e.message : String(e) }));
    this.refresh();
  }

  private copy(text: string): void {
    this.host.copy(text);
    this.host.notify(t('copied', { text }));
  }

  private async remove(): Promise<void> {
    const card = this.card;
    if (!card) return;
    if (!(await this.host.confirm(t('delete.confirm', { key: card.key }), t('delete.button')))) return;
    try {
      await this.host.remove(card.key);
      this.close();
      this.onClose();
    } catch (e) {
      this.fail(e);
    }
  }

  private iconButton(
    name: Parameters<typeof icon>[0],
    label: string,
    onClick: (e: MouseEvent) => void,
    extra = '',
  ): HTMLButtonElement {
    return h(
      'button',
      {
        class: `op-icon-btn ${extra}`.trim(),
        attrs: { type: 'button', 'aria-label': label, title: label },
        on: { click: onClick },
      },
      icon(name, 16),
    );
  }
}
