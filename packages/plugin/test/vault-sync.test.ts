import { DEFAULT_CONFIG, newCardContent, type BoardConfig, type Card } from '@oprojects/core';
import type { Plugin } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardStore } from '../src/store';
import { VaultSync } from '../src/vault-sync';
import { FakePlugin } from './helpers/fake-obsidian';

vi.mock('obsidian', async () => await import('./helpers/fake-obsidian'));

const SETTLE = 40;

const card = (key: string, extra: Partial<Card> = {}): Omit<Card, 'path' | 'checklist'> => ({
  key,
  title: `Title ${key}`,
  status: 'todo',
  type: 'task',
  priority: 'medium',
  labels: [],
  rank: 'M',
  created: '2026-10-01T10:00:00.000Z',
  updated: '2026-10-10T10:00:00.000Z',
  body: '',
  comments: [],
  ...extra,
});
const note = (key: string, extra: Partial<Card> = {}) => newCardContent(card(key, extra));

let plugin: FakePlugin;
let store: CardStore;
let config: BoardConfig;
let sync: VaultSync;
let notifications: number;

const vault = () => plugin.app.vault;

beforeEach(() => {
  vi.useFakeTimers();
  plugin = new FakePlugin();
  store = new CardStore();
  config = { ...DEFAULT_CONFIG };
  sync = new VaultSync(plugin as unknown as Plugin, store, () => config);
  notifications = 0;
  store.subscribe(() => notifications++);
});

afterEach(() => {
  sync.dispose();
  vi.useRealTimers();
});

describe('VaultSync.start / loadAll', () => {
  it('loads every card of the folder once and marks the store ready', async () => {
    vault().seed({ 'Cards/OP-1.md': note('OP-1'), 'Cards/OP-2.md': note('OP-2', { status: 'doing' }) });
    expect(store.ready).toBe(false);
    await sync.start();
    expect(store.ready).toBe(true);
    expect(
      store
        .all()
        .map((c) => c.key)
        .sort(),
    ).toEqual(['OP-1', 'OP-2']);
    expect(store.get('OP-2')!.status).toBe('doing');
    expect(notifications).toBe(1);
  });

  it('ignores notes outside the cards folder and files that are not markdown', async () => {
    vault().seed({
      'Cards/OP-1.md': note('OP-1'),
      'Cards2/OP-2.md': note('OP-2'),
      'Elsewhere/OP-3.md': note('OP-3'),
      'Cards/data.json': '{}',
    });
    await sync.start();
    expect(store.all().map((c) => c.key)).toEqual(['OP-1']);
  });

  it('includes cards in sub-folders of the cards folder', async () => {
    vault().seed({ 'Cards/Archive/2025/OP-1.md': note('OP-1') });
    await sync.start();
    expect(store.get('OP-1')!.path).toBe('Cards/Archive/2025/OP-1.md');
  });

  it('skips notes that are not cards, and notes that cannot be read, without failing the board', async () => {
    vault().seed({
      'Cards/OP-1.md': note('OP-1'),
      'Cards/scratch.md': '# just a note',
      'Cards/broken.md': 'x',
      'Cards/OP-2.md': note('OP-2'),
    });
    const original = vault().cachedRead.bind(vault());
    vi.spyOn(vault(), 'cachedRead').mockImplementation(async (file) => {
      if (file.path === 'Cards/broken.md') throw new Error('EIO');
      return original(file);
    });
    await sync.start();
    expect(
      store
        .all()
        .map((c) => c.key)
        .sort(),
    ).toEqual(['OP-1', 'OP-2']);
  });

  it('uses the cheap cached read for the first load', async () => {
    vault().seed({ 'Cards/OP-1.md': note('OP-1') });
    await sync.start();
    expect(vault().cachedReads).toEqual(['Cards/OP-1.md']);
    expect(vault().reads).toEqual([]);
  });

  it('is ready with an empty board when the folder does not exist yet', async () => {
    await sync.start();
    expect(store.ready).toBe(true);
    expect(store.all()).toEqual([]);
  });

  it('starts only once, and registers one handler per vault event (so the plugin can unload them)', async () => {
    await sync.start();
    await sync.start();
    expect(plugin.registerEvent).toHaveBeenCalledTimes(4);
    for (const event of ['create', 'modify', 'delete', 'rename'] as const) expect(vault().listenerCount(event)).toBe(1);
    expect(notifications).toBe(1); // one load, not two
  });

  it('only starts listening after the initial load', async () => {
    vault().seed({ 'Cards/OP-1.md': note('OP-1') });
    const started = sync.start();
    expect(plugin.registerEvent).not.toHaveBeenCalled();
    await started;
    expect(plugin.registerEvent).toHaveBeenCalled();
  });

  it('reloads from scratch when asked (the cards folder setting changed)', async () => {
    vault().seed({ 'Cards/OP-1.md': note('OP-1'), 'Work/OP-2.md': note('OP-2') });
    await sync.start();
    expect(store.all().map((c) => c.key)).toEqual(['OP-1']);
    config = { ...config, folder: 'Work' };
    await sync.loadAll();
    expect(store.all().map((c) => c.key)).toEqual(['OP-2']);
  });
});

describe('VaultSync live updates', () => {
  beforeEach(async () => {
    vault().seed({ 'Cards/OP-1.md': note('OP-1'), 'Cards/OP-2.md': note('OP-2') });
    await sync.start();
    notifications = 0;
  });

  it('adds a card that appears in the vault, after the settle delay', async () => {
    vault().write('Cards/OP-3.md', note('OP-3'));
    expect(store.get('OP-3')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(SETTLE - 1);
    expect(store.get('OP-3')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(store.get('OP-3')!.title).toBe('Title OP-3');
    expect(notifications).toBe(1);
  });

  it('reads the fresh content (not the metadata cache) for changed notes', async () => {
    vault().cache.set('Cards/OP-1.md', note('OP-1', { title: 'stale' }));
    vault().write('Cards/OP-1.md', note('OP-1', { title: 'fresh' }));
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(store.get('OP-1')!.title).toBe('fresh');
    expect(vault().reads).toContain('Cards/OP-1.md');
  });

  it('updates a card when its note is modified', async () => {
    vault().write('Cards/OP-1.md', note('OP-1', { priority: 'highest' }));
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(store.get('OP-1')!.priority).toBe('highest');
  });

  it('stays silent when the "change" is identical to what the store has (our own write echoing back)', async () => {
    vault().write('Cards/OP-1.md', vault().files.get('Cards/OP-1.md')!);
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(notifications).toBe(0);
  });

  it('removes a card whose note is deleted', async () => {
    vault().delete('Cards/OP-1.md');
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(store.get('OP-1')).toBeUndefined();
    expect(store.get('OP-2')).toBeDefined();
  });

  it('removes a card whose note stops being a card (the key is deleted)', async () => {
    vault().write('Cards/OP-1.md', '# now just a note\n');
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(store.get('OP-1')).toBeUndefined();
  });

  it('coalesces a burst of events into one store update', async () => {
    vault().write('Cards/OP-3.md', note('OP-3'));
    vault().write('Cards/OP-4.md', note('OP-4'));
    vault().write('Cards/OP-1.md', note('OP-1', { title: 'edited' }));
    vault().delete('Cards/OP-2.md');
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(notifications).toBe(1);
    expect(
      store
        .all()
        .map((c) => c.key)
        .sort(),
    ).toEqual(['OP-1', 'OP-3', 'OP-4']);
    expect(store.get('OP-1')!.title).toBe('edited');
  });

  it('waits for the burst to end: every new event restarts the settle timer', async () => {
    vault().write('Cards/OP-3.md', note('OP-3'));
    await vi.advanceTimersByTimeAsync(SETTLE - 10);
    vault().write('Cards/OP-4.md', note('OP-4'));
    await vi.advanceTimersByTimeAsync(SETTLE - 10);
    expect(notifications).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(notifications).toBe(1);
    expect(store.get('OP-3')).toBeDefined();
    expect(store.get('OP-4')).toBeDefined();
  });

  it('reads each changed note once even if it fired several events', async () => {
    for (let i = 0; i < 5; i++) vault().write('Cards/OP-1.md', note('OP-1', { title: `v${i}` }));
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(vault().reads.filter((p) => p === 'Cards/OP-1.md')).toHaveLength(1);
    expect(store.get('OP-1')!.title).toBe('v4');
  });

  it('ignores events outside the cards folder and for non-markdown files', async () => {
    vault().write('Cards2/OP-9.md', note('OP-9'));
    vault().write('Elsewhere/OP-8.md', note('OP-8'));
    vault().write('Cards/image.png', 'x');
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(notifications).toBe(0);
    expect(store.all()).toHaveLength(2);
    expect(vault().reads).toEqual([]);
  });

  it('a note that disappears between the event and the read is treated as deleted', async () => {
    vault().write('Cards/OP-3.md', note('OP-3'));
    vault().files.delete('Cards/OP-3.md'); // gone before the settle timer fires
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(store.get('OP-3')).toBeUndefined();
  });

  it('a note that cannot be read right now drops out instead of breaking the update', async () => {
    vault().write('Cards/OP-1.md', note('OP-1', { title: 'still fine' }));
    vault().write('Cards/OP-3.md', note('OP-3'));
    const original = vault().read.bind(vault());
    vi.spyOn(vault(), 'read').mockImplementation(async (file) => {
      if (file.path === 'Cards/OP-3.md') throw new Error('EBUSY');
      return original(file);
    });
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(store.get('OP-1')!.title).toBe('still fine');
    expect(store.get('OP-3')).toBeUndefined();
  });
});

describe('VaultSync renames', () => {
  beforeEach(async () => {
    vault().seed({ 'Cards/OP-1.md': note('OP-1'), 'Cards/OP-2.md': note('OP-2') });
    await sync.start();
    notifications = 0;
  });

  it('keeps the card when its note is moved to another folder inside the cards folder', async () => {
    const snapshots: string[][] = [];
    store.subscribe(() =>
      snapshots.push(
        store
          .all()
          .map((c) => c.key)
          .sort(),
      ),
    );
    vault().rename('Cards/OP-1.md', 'Cards/Archive/OP-1.md');
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(store.get('OP-1')!.path).toBe('Cards/Archive/OP-1.md');
    expect(store.keyAt('Cards/OP-1.md')).toBeUndefined();
    expect(notifications).toBe(1);
    expect(snapshots).toEqual([['OP-1', 'OP-2']]); // the card never blinks out of the board
  });

  it('keeps the card when only the file name changes', async () => {
    vault().rename('Cards/OP-1.md', 'Cards/first-card.md');
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(store.get('OP-1')!.path).toBe('Cards/first-card.md');
    expect(store.all()).toHaveLength(2);
  });

  it('removes a card whose note is moved out of the cards folder', async () => {
    vault().rename('Cards/OP-1.md', 'Elsewhere/OP-1.md');
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(store.get('OP-1')).toBeUndefined();
    expect(store.get('OP-2')).toBeDefined();
  });

  it('adds a card whose note is moved into the cards folder', async () => {
    vault().seed({ 'Elsewhere/OP-5.md': note('OP-5') });
    vault().rename('Elsewhere/OP-5.md', 'Cards/OP-5.md');
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(store.get('OP-5')!.path).toBe('Cards/OP-5.md');
  });

  it('handles a rename that swaps two notes in one batch', async () => {
    vault().write('Cards/OP-1.md', note('OP-1', { title: 'one' }));
    vault().rename('Cards/OP-2.md', 'Cards/renamed-2.md');
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(store.get('OP-1')!.title).toBe('one');
    expect(store.get('OP-2')!.path).toBe('Cards/renamed-2.md');
    expect(notifications).toBe(1);
  });
});

describe('VaultSync.dispose', () => {
  beforeEach(async () => {
    vault().seed({ 'Cards/OP-1.md': note('OP-1') });
    await sync.start();
    notifications = 0;
  });

  it('cancels a pending update', async () => {
    vault().write('Cards/OP-2.md', note('OP-2'));
    sync.dispose();
    await vi.advanceTimersByTimeAsync(SETTLE * 5);
    expect(store.get('OP-2')).toBeUndefined();
    expect(notifications).toBe(0);
  });

  it('is safe to call twice or before anything happened', () => {
    sync.dispose();
    expect(() => sync.dispose()).not.toThrow();
    expect(() => new VaultSync(plugin as unknown as Plugin, new CardStore(), () => config).dispose()).not.toThrow();
  });
});

describe('VaultSync with a custom folder', () => {
  it('follows the folder from the live config, with nested paths', async () => {
    config = { ...config, folder: 'Work/Board' };
    vault().seed({ 'Work/Board/OP-1.md': note('OP-1'), 'Work/OP-2.md': note('OP-2'), 'Cards/OP-3.md': note('OP-3') });
    await sync.start();
    expect(store.all().map((c) => c.key)).toEqual(['OP-1']);
    vault().write('Work/Board/OP-4.md', note('OP-4'));
    vault().write('Work/Boardroom/OP-5.md', note('OP-5')); // shares a prefix with the folder name, is not inside it
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(
      store
        .all()
        .map((c) => c.key)
        .sort(),
    ).toEqual(['OP-1', 'OP-4']);
  });
});
