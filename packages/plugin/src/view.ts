import { ItemView, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type CardsPlugin from './main';
import { t } from './i18n';
import { BoardUI } from './ui/board';
import { sanitizeState } from './ui/state';

export const VIEW_TYPE = 'obsidian-projects-board';

/** The board as a workspace tab. Filters are saved with the layout, so a restart restores them. */
export class BoardView extends ItemView {
  private ui: BoardUI | null = null;
  private saved: unknown;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: CardsPlugin,
  ) {
    super(leaf);
    this.navigation = false;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return t('board.title');
  }

  override getIcon(): string {
    return this.plugin.iconName;
  }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), ui: this.ui?.getState() ?? this.saved };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    this.saved = (state as { ui?: unknown } | null)?.ui;
    // `setState` can arrive before or after `onOpen`; handle both orders.
    if (this.ui && this.saved) this.ui.setState(sanitizeState(this.saved));
    await super.setState(state, result);
  }

  protected override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.ui = new BoardUI(this.contentEl, this.plugin.host, this.saved, () => this.app.workspace.requestSaveLayout());
  }

  protected override async onClose(): Promise<void> {
    this.ui?.destroy();
    this.ui = null;
  }

  openComposer(status?: string): void {
    this.ui?.openComposer(status);
  }

  focusSearch(): void {
    this.ui?.focusSearch();
  }
}
