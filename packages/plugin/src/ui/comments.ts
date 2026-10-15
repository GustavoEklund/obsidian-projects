import { toggleTask, type Card, type Comment } from '@oprojects/core';
import { getLocale, t, timeAgo } from '../i18n';
import { avatar } from './card-view';
import { autosize, h } from './dom';
import type { BoardHost } from './host';
import { icon } from './icons';

const isSubmit = (e: KeyboardEvent) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing;

/**
 * The comments of one card: the thread (author, time, rendered Markdown, edit/delete) and the box to
 * write a new one. It rebuilds the thread only when the comments actually changed (so unrelated card
 * updates do not re-render Markdown), never while one is being edited, and keeps an unsent draft per card.
 */
export class CommentsPanel {
  readonly el: HTMLElement;
  private card: Card | null = null;
  private sig = '';
  private editing: string | null = null;
  private draftKey: string | null = null;
  private readonly drafts = new Map<string, string>();

  private readonly title = h('span', { class: 'op-section-title' });
  private readonly list = h('div', { class: 'op-comment-list' });
  private readonly input: HTMLTextAreaElement;
  private readonly post: HTMLButtonElement;

  constructor(private readonly host: BoardHost) {
    this.input = h('textarea', { class: 'op-comment-input', props: { rows: 2, placeholder: t('comment.placeholder') }, attrs: { 'aria-label': t('comment.placeholder') } });
    this.input.addEventListener('input', () => {
      autosize(this.input);
      if (this.card) this.drafts.set(this.card.key, this.input.value);
      this.syncPost();
    });
    this.input.addEventListener('keydown', (e) => {
      if (isSubmit(e)) {
        e.preventDefault();
        void this.submit();
      }
    });
    this.post = h('button', { class: 'op-btn-primary', text: t('comment.post'), attrs: { type: 'button', disabled: true }, on: { click: () => void this.submit() } });

    this.el = h(
      'section',
      { class: 'op-comments' },
      h('div', { class: 'op-desc-head' }, this.title),
      this.list,
      h('div', { class: 'op-comment-new' }, this.input, h('div', { class: 'op-comment-actions' }, h('span', { class: 'op-composer-hint', text: t('comment.hint') }), h('span', { class: 'op-spacer' }), this.post)),
    );
  }

  /** A different card is being shown: forget the edit state of the previous one. */
  reset(): void {
    this.editing = null;
    this.sig = '';
  }

  bind(card: Card): void {
    this.card = card;
    this.title.textContent = card.comments.length ? `${t('comments.title')} (${card.comments.length})` : t('comments.title');

    if (this.draftKey !== card.key) {
      this.draftKey = card.key;
      this.input.value = this.drafts.get(card.key) ?? '';
      autosize(this.input);
      this.syncPost();
    }
    if (this.editing) return; // do not pull the text out from under someone who is editing
    const sig = this.signature(card);
    if (sig === this.sig) return;
    this.sig = sig;
    this.renderThread(card);
  }

  /** Free the rendered Markdown (call when the panel is hidden or discarded). */
  release(): void {
    this.host.releaseMarkdown(this.list);
    this.sig = '';
    this.editing = null;
  }

  // --- thread -----------------------------------------------------------------

  private signature(card: Card): string {
    return `${card.key}\u0002${card.comments.map((c) => `${c.id}\u0001${c.author}\u0001${c.at}\u0001${c.text}`).join('\u0003')}`;
  }

  private renderThread(card: Card): void {
    this.host.releaseMarkdown(this.list);
    const now = this.host.now();
    this.list.replaceChildren(...(card.comments.length ? card.comments.map((c) => this.item(card, c, now)) : [h('div', { class: 'op-comments-empty', text: t('comments.empty') })]));
  }

  private item(card: Card, comment: Comment, now: Date): HTMLElement {
    const body = h('div', { class: 'op-comment-body markdown-rendered' });
    void Promise.resolve(this.host.renderMarkdown(body, comment.text, card.path)).catch(() => (body.textContent = comment.text));

    // Rendered checkboxes are only pictures: a click rewrites that task in the comment's text.
    body.addEventListener('click', (e) => {
      const box = (e.target as Element).closest<HTMLInputElement>('input[type="checkbox"]');
      if (!box) return;
      e.preventDefault();
      const index = [...body.querySelectorAll('input[type="checkbox"]')].indexOf(box);
      const next = index < 0 ? null : toggleTask(comment.text, index);
      if (next !== null) void this.host.editComment(card.key, comment.id, next).catch((err) => this.fail(err));
    });

    const when = comment.at ? new Date(comment.at) : null;
    const main = h(
      'div',
      { class: 'op-comment-main' },
      h(
        'div',
        { class: 'op-comment-head' },
        h('span', { class: 'op-comment-author', text: comment.author }),
        when ? h('span', { class: 'op-comment-time', text: timeAgo(comment.at, now), attrs: { title: when.toLocaleString(getLocale()) } }) : null,
        h('span', { class: 'op-spacer' }),
        this.action('edit', t('comment.edit'), () => this.startEdit(card, comment, main, body)),
        this.action('trash', t('comment.delete'), () => void this.remove(card, comment), 'op-danger'),
      ),
      body,
    );
    return h('div', { class: 'op-comment', attrs: { 'data-id': comment.id } }, avatar(comment.author, 26), main);
  }

  private action(name: Parameters<typeof icon>[0], label: string, onClick: () => void, extra = ''): HTMLButtonElement {
    return h('button', { class: `op-icon-btn op-comment-act ${extra}`.trim(), attrs: { type: 'button', 'aria-label': label, title: label }, on: { click: onClick } }, icon(name, 14));
  }

  // --- actions ----------------------------------------------------------------

  private async submit(): Promise<void> {
    const card = this.card;
    const text = this.input.value;
    if (!card || !text.trim()) return;
    this.post.disabled = true;
    try {
      await this.host.addComment(card.key, text);
      this.input.value = '';
      this.drafts.delete(card.key);
      autosize(this.input);
      // The thread re-renders on the next frame; wait for it, then show the newest comment.
      requestAnimationFrame(() => requestAnimationFrame(() => this.list.lastElementChild?.scrollIntoView({ block: 'nearest' })));
    } catch (e) {
      this.fail(e);
    } finally {
      this.syncPost();
      this.input.focus();
    }
  }

  private startEdit(card: Card, comment: Comment, main: HTMLElement, body: HTMLElement): void {
    if (this.editing) return;
    this.editing = comment.id;
    const area = h('textarea', { class: 'op-comment-input op-comment-edit', props: { value: comment.text, rows: 2 }, attrs: { 'aria-label': t('comment.edit') } });
    const finish = () => {
      this.editing = null;
      this.sig = ''; // rebuild from the latest data
      const latest = this.host.cards().find((c) => c.key === card.key);
      if (latest) this.bind(latest);
    };
    const save = async () => {
      const text = area.value;
      if (!text.trim() || text === comment.text) return finish();
      try {
        await this.host.editComment(card.key, comment.id, text);
      } catch (e) {
        this.fail(e);
      }
      finish();
    };
    area.addEventListener('input', () => autosize(area));
    area.addEventListener('keydown', (e) => {
      if (isSubmit(e)) {
        e.preventDefault();
        void save();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        finish();
      }
    });
    const form = h(
      'div',
      { class: 'op-comment-editor' },
      area,
      h(
        'div',
        { class: 'op-comment-actions' },
        h('span', { class: 'op-spacer' }),
        h('button', { class: 'op-btn', text: t('cancel'), attrs: { type: 'button' }, on: { click: finish } }),
        h('button', { class: 'op-btn-primary', text: t('comment.save'), attrs: { type: 'button' }, on: { click: () => void save() } }),
      ),
    );
    main.replaceChild(form, body);
    this.host.releaseMarkdown(body);
    autosize(area);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  private async remove(card: Card, comment: Comment): Promise<void> {
    if (!(await this.host.confirm(t('comment.delete.confirm'), t('delete.button')))) return;
    try {
      await this.host.removeComment(card.key, comment.id);
    } catch (e) {
      this.fail(e);
    }
  }

  private syncPost(): void {
    this.post.disabled = !this.input.value.trim();
  }

  private fail(e: unknown): void {
    this.host.notify(t('error.generic', { message: e instanceof Error ? e.message : String(e) }));
  }
}
