import type { BoardConfig, Card, CardPatch, NewCardInput, Placement } from '@oprojects/core';

export interface MenuEntry {
  label?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

/**
 * Everything the board UI needs from its environment. The Obsidian plugin
 * implements it with the vault API; the browser harness implements it with
 * in-memory data. The UI itself never touches `obsidian`.
 */
export interface BoardHost {
  /** Current board settings (re-read on every render). */
  readonly config: BoardConfig;
  /** Current snapshot of every card. Treat as read-only. */
  cards(): readonly Card[];
  /** Called whenever cards or config change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Whether the first full load has finished. */
  readonly ready: boolean;

  move(key: string, status: string, placement?: Placement): Promise<void>;
  update(key: string, patch: CardPatch): Promise<void>;
  create(input: NewCardInput): Promise<Card>;
  remove(key: string): Promise<void>;
  addComment(key: string, text: string): Promise<void>;
  editComment(key: string, commentId: string, text: string): Promise<void>;
  removeComment(key: string, commentId: string): Promise<void>;

  openNote(card: Card, opts?: { newTab?: boolean }): void;
  confirm(message: string, confirmLabel: string): Promise<boolean>;
  menu(at: MouseEvent | { x: number; y: number }, entries: MenuEntry[]): void;
  renderMarkdown(el: HTMLElement, markdown: string, sourcePath: string): void | Promise<void>;
  /** Free whatever `renderMarkdown` created for `root` and everything inside it (call before discarding it). */
  releaseMarkdown(root: HTMLElement): void;
  copy(text: string): void;
  notify(message: string): void;
  now(): Date;
}
