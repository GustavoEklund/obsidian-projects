import { applyPatch, rankForPlacement, type BoardConfig, type Card, type CardPatch, type CardService, type NewCardInput, type Placement } from '@oprojects/core';
import { t } from './i18n';
import type { CardStore } from './store';
import type { BoardHost, MenuEntry } from './ui/host';

/** The few things that differ between Obsidian and a plain browser. */
export interface Platform {
  openNote(card: Card, opts?: { newTab?: boolean }): void;
  confirm(message: string, confirmLabel: string): Promise<boolean>;
  menu(at: MouseEvent | { x: number; y: number }, entries: MenuEntry[]): void;
  renderMarkdown(el: HTMLElement, markdown: string, sourcePath: string): void | Promise<void>;
  releaseMarkdown(root: HTMLElement): void;
  copy(text: string): void;
  notify(message: string): void;
}

/**
 * `BoardHost` over the in-memory store + `CardService`. Edits are applied to the
 * store immediately (optimistic) so dragging and typing never wait for the disk;
 * the saved card then replaces the guess, or the guess is rolled back on failure.
 */
export class CardsHost implements BoardHost {
  constructor(
    private readonly store: CardStore,
    private readonly getService: () => CardService,
    private readonly platform: Platform,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get config(): BoardConfig {
    return this.getService().config;
  }
  get ready(): boolean {
    return this.store.ready;
  }
  cards(): readonly Card[] {
    return this.store.all();
  }
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }
  now(): Date {
    return this.clock();
  }

  async move(key: string, status: string, placement: Placement = {}): Promise<void> {
    const svc = this.getService();
    const card = this.mustGet(key);
    const column = svc.checkStatus(status);
    const rank = rankForPlacement(this.store.all() as Card[], svc.config, key, column, placement);
    await this.optimistic(card, { status: column, rank }, () => svc.update(key, { status: column, rank }));
  }

  async update(key: string, patch: CardPatch): Promise<void> {
    const svc = this.getService();
    await this.optimistic(this.mustGet(key), patch, () => svc.update(key, patch));
  }

  async create(input: NewCardInput): Promise<Card> {
    const card = await this.getService().create(input);
    this.store.apply(card);
    return card;
  }

  async remove(key: string): Promise<void> {
    await this.getService().remove(key);
    this.store.remove(key);
  }

  /** Comments are written by the service (ids, timestamps) and then shown; there is no useful optimistic guess. */
  async addComment(key: string, text: string): Promise<void> {
    const svc = this.getService();
    this.mustGet(key);
    this.store.apply(await svc.addComment(key, { text, author: svc.config.me || t('comment.anonymous') }));
  }

  async editComment(key: string, commentId: string, text: string): Promise<void> {
    this.mustGet(key);
    this.store.apply(await this.getService().editComment(key, commentId, text));
  }

  async removeComment(key: string, commentId: string): Promise<void> {
    this.mustGet(key);
    this.store.apply(await this.getService().removeComment(key, commentId));
  }

  openNote = (card: Card, opts?: { newTab?: boolean }) => this.platform.openNote(card, opts);
  confirm = (message: string, label: string) => this.platform.confirm(message, label);
  menu = (at: MouseEvent | { x: number; y: number }, entries: MenuEntry[]) => this.platform.menu(at, entries);
  renderMarkdown = (el: HTMLElement, md: string, path: string) => this.platform.renderMarkdown(el, md, path);
  releaseMarkdown = (root: HTMLElement) => this.platform.releaseMarkdown(root);
  copy = (text: string) => this.platform.copy(text);
  notify = (message: string) => this.platform.notify(message);

  private mustGet(key: string): Card {
    const card = this.store.get(key);
    if (!card) throw new Error(`Card ${key} not found`);
    return card;
  }

  private async optimistic(before: Card, patch: CardPatch, save: () => Promise<Card>): Promise<void> {
    const guess = applyPatch(before, patch);
    this.store.apply(guess);
    try {
      this.store.apply(await save());
    } catch (e) {
      // Only undo our own guess; if something newer landed meanwhile, keep it.
      if (this.store.get(before.key) === guess) this.store.apply(before);
      throw e;
    }
  }
}
