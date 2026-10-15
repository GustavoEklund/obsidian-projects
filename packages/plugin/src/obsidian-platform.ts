import { Component, MarkdownRenderer, Menu, Modal, Notice, TFile, type App } from 'obsidian';
import type { Platform } from './host-impl';
import type { MenuEntry } from './ui/host';
import { t } from './i18n';

class ConfirmModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly message: string,
    private readonly confirmLabel: string,
    private readonly done: (answer: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.createEl('p', { text: this.message });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: this.confirmLabel, cls: 'mod-warning' }).addEventListener('click', () => this.answer(true));
    row.createEl('button', { text: t('cancel') }).addEventListener('click', () => this.answer(false));
  }

  override onClose(): void {
    this.contentEl.empty();
    this.answer(false); // closed with Esc / click outside
  }

  private answer(value: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.done(value);
    this.close();
  }
}

/** Obsidian side of the few things the board UI delegates to its host. */
export class ObsidianPlatform implements Platform {
  /**
   * Each rendered element gets its own throwaway component (links, embeds, event handlers live on it).
   * Re-rendering into the same element unloads the previous one; `releaseMarkdown` frees them when the
   * element is discarded, so repeated refreshes do not pile up children.
   */
  private rendered = new Map<HTMLElement, Component>();

  constructor(private readonly app: App) {}

  openNote(card: { path: string }, opts?: { newTab?: boolean }): void {
    const file = this.app.vault.getAbstractFileByPath(card.path);
    if (!(file instanceof TFile)) return;
    // Never replace the board itself: reuse another note pane if there is one, else open beside it.
    const existing = this.app.workspace.getLeavesOfType('markdown')[0];
    const leaf = opts?.newTab ? this.app.workspace.getLeaf('tab') : (existing ?? this.app.workspace.getLeaf('split', 'vertical'));
    void leaf.openFile(file);
    void this.app.workspace.revealLeaf(leaf);
  }

  confirm(message: string, confirmLabel: string): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(this.app, message, confirmLabel, resolve).open());
  }

  menu(at: MouseEvent | { x: number; y: number }, entries: MenuEntry[]): void {
    const menu = new Menu();
    for (const e of entries) {
      if (e.separator) {
        menu.addSeparator();
        continue;
      }
      menu.addItem((item) => {
        item.setTitle(e.label ?? '').setDisabled(!!e.disabled);
        if (e.checked !== undefined) item.setChecked(e.checked);
        if (e.danger) item.setWarning(true);
        if (e.onClick) item.onClick(e.onClick);
      });
    }
    if ('clientX' in at) menu.showAtMouseEvent(at);
    else menu.showAtPosition(at);
  }

  async renderMarkdown(el: HTMLElement, markdown: string, sourcePath: string): Promise<void> {
    this.rendered.get(el)?.unload();
    const component = new Component();
    component.load();
    this.rendered.set(el, component);
    await MarkdownRenderer.render(this.app, markdown, el, sourcePath, component);
  }

  releaseMarkdown(root: HTMLElement): void {
    for (const [el, component] of this.rendered) {
      if (el !== root && !root.contains(el)) continue;
      component.unload();
      this.rendered.delete(el);
    }
  }

  copy(text: string): void {
    void navigator.clipboard.writeText(text);
  }

  notify(message: string): void {
    new Notice(message);
  }

  dispose(): void {
    for (const component of this.rendered.values()) component.unload();
    this.rendered.clear();
  }
}
