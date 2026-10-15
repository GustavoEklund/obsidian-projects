// A real BoardUI on a real CardService and in-memory notes, with the Obsidian-only edges (menu, confirm dialog,
// Markdown rendering, opening notes) replaced by spies. The same idea as `dev/harness.ts`, shaped for tests.
import { CardService, newCardContent, type BoardConfig, type Card } from '@oprojects/core';
import { vi } from 'vitest';
import { SAMPLE_CONFIG, sampleCards } from '../../../../scripts/sample';
import { CardsHost } from '../../src/host-impl';
import { setLanguage } from '../../src/i18n';
import { CardStore } from '../../src/store';
import { BoardUI } from '../../src/ui/board';
import { setColorUniverse } from '../../src/ui/card-view';
import type { UiState } from '../../src/ui/state';
import { installDomStubs } from './dom';
import { createPlatform, type FakePlatform } from './platform';
import { AtomicStorage } from './storage';

/** The "current time" of every test: mid-afternoon on a fixed day, so due dates and "x days ago" are stable. */
export const NOW = new Date(2026, 9, 15, 12, 0, 0);

export interface SandboxOptions {
  cards?: Card[];
  config?: BoardConfig;
  /** Saved view state handed to the BoardUI (as Obsidian would restore it). */
  state?: unknown;
  now?: Date;
  /** Mount the BoardUI right away (default true). */
  mount?: boolean;
}

export interface Sandbox {
  storage: AtomicStorage;
  store: CardStore;
  service: CardService;
  host: CardsHost;
  platform: FakePlatform;
  config: BoardConfig;
  container: HTMLElement;
  now: Date;
  /** Every UI state the board reported through its `onState` callback, oldest first. */
  states: UiState[];
  /** The mounted board (throws if the sandbox was created with `mount: false`). */
  ui: BoardUI;
  mount(state?: unknown): BoardUI;
  /** Let timers, animation frames and pending promises run. */
  settle(ms?: number): Promise<void>;
  /** The card element on the board, or null when it is not in the DOM. */
  card(key: string): HTMLElement | null;
  /** Keys of the cards shown in a column, top to bottom. */
  keys(columnId: string): string[];
  column(columnId: string): HTMLElement;
  /** The saved note text of a card. */
  note(key: string): string;
  dispose(): void;
}

export async function createSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  installDomStubs();
  const now = options.now ?? NOW;
  vi.useFakeTimers({ now });

  const config = structuredClone(options.config ?? SAMPLE_CONFIG);
  const cards = options.cards ?? sampleCards(now);
  const storage = new AtomicStorage();
  for (const card of cards) await storage.create(card.path, newCardContent(card));
  const store = new CardStore();
  store.replaceAll(cards);
  let ids = 0;
  const service = new CardService(storage, config, {
    snapshot: () => store.all() as Card[],
    now: () => new Date(Date.now()),
    newId: () => `n${++ids}`,
  });
  const platform = createPlatform();
  const host = new CardsHost(
    store,
    () => service,
    platform,
    () => now,
  );

  const container = document.createElement('div');
  document.body.appendChild(container);
  const states: UiState[] = [];
  let ui: BoardUI | null = null;

  const sandbox: Sandbox = {
    storage,
    store,
    service,
    host,
    platform,
    config,
    container,
    now,
    states,
    get ui() {
      if (!ui) throw new Error('The sandbox has no mounted board');
      return ui;
    },
    mount(state) {
      ui?.destroy();
      ui = new BoardUI(container, host, state, (s) => states.push(s));
      return ui;
    },
    async settle(ms = 30) {
      await vi.advanceTimersByTimeAsync(ms);
    },
    card: (key) => container.querySelector<HTMLElement>(`.op-card[data-key="${key}"]`),
    keys: (columnId) =>
      [...sandbox.column(columnId).querySelectorAll<HTMLElement>('.op-card')].map((c) => c.dataset.key!),
    column(columnId) {
      const el = container.querySelector<HTMLElement>(`.op-col[data-col="${columnId}"]`);
      if (!el) throw new Error(`No column "${columnId}" on the board`);
      return el;
    },
    note: (key) => storage.files.get(`${config.folder}/${key}.md`) ?? '',
    dispose() {
      ui?.destroy();
      ui = null;
      container.remove();
      document.body.replaceChildren();
      vi.useRealTimers();
      vi.restoreAllMocks();
      setLanguage('en');
      setColorUniverse([], []);
    },
  };
  if (options.mount !== false) sandbox.mount(options.state);
  return sandbox;
}

export { makeCard } from './cards';
export { createPlatform, renderMini, type FakePlatform } from './platform';
