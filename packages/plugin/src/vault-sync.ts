import { parseCard, type BoardConfig, type Card } from '@oprojects/core';
import { TFile, type Plugin } from 'obsidian';
import type { CardStore } from './store';

const SETTLE_MS = 40;

/**
 * Keeps the `CardStore` in step with the vault. One full read at startup, then
 * every create/modify/delete/rename re-reads only the note that changed
 * (coalesced into one store update), so the board stays live without rescans.
 */
export class VaultSync {
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  constructor(
    private readonly plugin: Plugin,
    private readonly store: CardStore,
    private readonly getConfig: () => BoardConfig,
  ) {}

  private get vault() {
    return this.plugin.app.vault;
  }

  /** Call once the workspace layout is ready (before that, `create` fires for every existing file). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.loadAll();
    const { plugin } = this;
    plugin.registerEvent(this.vault.on('create', (f) => this.queue(f.path)));
    plugin.registerEvent(this.vault.on('modify', (f) => this.queue(f.path)));
    plugin.registerEvent(this.vault.on('delete', (f) => this.queue(f.path)));
    plugin.registerEvent(
      this.vault.on('rename', (f, oldPath) => {
        // Both ends go through the same batch so a rename never makes the card blink out of the board.
        this.queue(oldPath);
        this.queue(f.path);
      }),
    );
  }

  /** Full (re)load, used at startup and when the cards folder setting changes. */
  async loadAll(): Promise<void> {
    const files = this.vault.getMarkdownFiles().filter((f) => this.inFolder(f.path));
    const cards = await Promise.all(files.map((f) => this.readCard(f)));
    this.store.replaceAll(cards.filter((c): c is Card => c !== null));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.pending.clear();
  }

  private inFolder(path: string): boolean {
    return path.endsWith('.md') && path.startsWith(`${this.getConfig().folder}/`);
  }

  private queue(path: string): void {
    if (!this.inFolder(path)) return;
    this.pending.add(path);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SETTLE_MS);
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    const paths = [...this.pending];
    this.pending.clear();
    const updates = await Promise.all(
      paths.map(async (path) => {
        const file = this.vault.getAbstractFileByPath(path);
        return { path, card: file instanceof TFile ? await this.readCard(file, true) : null };
      }),
    );
    this.store.batch(() => {
      for (const { path, card } of updates) {
        if (card) this.store.apply(card);
        else this.store.removePath(path);
      }
    });
  }

  private async readCard(file: TFile, fresh = false): Promise<Card | null> {
    try {
      const content = fresh ? await this.vault.read(file) : await this.vault.cachedRead(file);
      return parseCard(file.path, content);
    } catch {
      return null; // deleted or unreadable between the event and the read
    }
  }
}
