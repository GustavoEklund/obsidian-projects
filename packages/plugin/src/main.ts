import { CardService, DEFAULT_CONFIG, normalizeConfig, type BoardConfig, type Card } from '@oprojects/core';
import { FuzzySuggestModal, Plugin, getIconIds, getLanguage, type App } from 'obsidian';
import { CardsHost } from './host-impl';
import { setLanguage, t } from './i18n';
import { ObsidianPlatform } from './obsidian-platform';
import { ObsidianStorage } from './obsidian-storage';
import { CardsSettingTab } from './settings';
import { CardStore } from './store';
import { BoardView, VIEW_TYPE } from './view';
import { VaultSync } from './vault-sync';

/** Persisted in `data.json`; the `oprojects` CLI reads `board` from the same file. */
interface PluginData {
  version: 1;
  board: BoardConfig;
}

/** Newer Obsidian builds renamed the kanban icon; take whichever exists. */
function pickIcon(): string {
  const ids = new Set<string>(getIconIds());
  return ['square-kanban', 'kanban-square', 'layout-dashboard'].find((id) => ids.has(`lucide-${id}`) || ids.has(id)) ?? 'layout-dashboard';
}

class CardPicker extends FuzzySuggestModal<Card> {
  constructor(
    app: App,
    private readonly cards: readonly Card[],
    private readonly onPick: (card: Card) => void,
  ) {
    super(app);
    this.setPlaceholder(t('cmd.goTo.placeholder'));
  }
  getItems(): Card[] {
    return [...this.cards];
  }
  getItemText(card: Card): string {
    return `${card.key} ${card.title}`;
  }
  onChooseItem(card: Card): void {
    this.onPick(card);
  }
}

export default class CardsPlugin extends Plugin {
  config: BoardConfig = DEFAULT_CONFIG;
  readonly store = new CardStore();
  service!: CardService;
  host!: CardsHost;
  iconName = 'layout-dashboard';
  private platform!: ObsidianPlatform;
  private sync!: VaultSync;

  override async onload(): Promise<void> {
    setLanguage(getLanguage());
    this.iconName = pickIcon();
    this.config = await this.loadConfig();

    const storage = new ObsidianStorage(this.app);
    this.rebuildService(storage);
    this.platform = new ObsidianPlatform(this.app);
    this.host = new CardsHost(this.store, () => this.service, this.platform);
    this.sync = new VaultSync(this, this.store, () => this.config);

    this.registerView(VIEW_TYPE, (leaf) => new BoardView(leaf, this));
    this.addRibbonIcon(this.iconName, t('ribbon'), () => void this.openBoard());
    this.addCommand({ id: 'open-board', name: t('cmd.openBoard'), callback: () => void this.openBoard() });
    this.addCommand({
      id: 'new-card',
      name: t('cmd.newCard'),
      callback: async () => (await this.openBoard()).openComposer(),
    });
    this.addCommand({
      id: 'go-to-card',
      name: t('cmd.goTo'),
      callback: () => new CardPicker(this.app, this.store.all(), (card) => this.platform.openNote(card)).open(),
    });
    this.addSettingTab(new CardsSettingTab(this.app, this));

    // Before layout-ready, `create` fires for every existing file; start watching afterwards.
    this.app.workspace.onLayoutReady(() => void this.sync.start());
  }

  override onunload(): void {
    this.sync.dispose();
    this.platform.dispose();
  }

  /** Reveal the board tab (creating it on first use) and return the live view. */
  async openBoard(): Promise<BoardView> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    return leaf.view as BoardView;
  }

  /** Called by the settings tab. Saves, rebuilds the service and refreshes every open board. */
  async updateConfig(next: BoardConfig): Promise<void> {
    const previous = this.config;
    this.config = normalizeConfig(next);
    await this.saveData({ version: 1, board: this.config } satisfies PluginData);
    this.rebuildService(new ObsidianStorage(this.app));
    if (previous.folder !== this.config.folder) await this.sync.loadAll();
    else this.store.touch();
  }

  private rebuildService(storage: ObsidianStorage): void {
    // The in-memory store feeds key/rank allocation, so creating or moving a card never rescans the vault.
    this.service = new CardService(storage, this.config, { snapshot: () => this.store.all() as Card[] });
  }

  private async loadConfig(): Promise<BoardConfig> {
    const data = (await this.loadData()) as Partial<PluginData> | null;
    return normalizeConfig(data?.board ?? DEFAULT_CONFIG);
  }
}
