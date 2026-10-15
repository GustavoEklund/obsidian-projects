import { CardService, MemoryStorage, normalizeConfig, DEFAULT_CONFIG, type Card } from '@oprojects/core';
import { describe, expect, it, vi } from 'vitest';
import { CardsHost, type Platform } from '../src/host-impl';
import { CardStore } from '../src/store';

const platform: Platform = {
  openNote: vi.fn(),
  confirm: async () => true,
  menu: vi.fn(),
  renderMarkdown: vi.fn(),
  releaseMarkdown: vi.fn(),
  copy: vi.fn(),
  notify: vi.fn(),
};

async function setup() {
  const storage = new MemoryStorage();
  const store = new CardStore();
  const config = normalizeConfig(DEFAULT_CONFIG);
  const service = new CardService(storage, config, { snapshot: () => store.all() as Card[] });
  const host = new CardsHost(store, () => service, platform);
  const seed = [await service.create({ title: 'a' }), await service.create({ title: 'b' }), await service.create({ title: 'c' })];
  store.replaceAll(seed);
  return { storage, store, service, host };
}

describe('CardsHost (optimistic edits)', () => {
  it('updates the store before the write finishes, then settles on the saved card', async () => {
    const { store, host, storage } = await setup();
    const realModify = storage.modify.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    storage.modify = async (path, fn) => (await gate, realModify(path, fn));

    const pending = host.update('OP-1', { priority: 'highest' });
    await Promise.resolve();
    expect(store.get('OP-1')?.priority).toBe('highest'); // visible immediately
    expect(storage.files.get('Cards/OP-1.md')).not.toContain('priority: highest'); // not on disk yet
    release();
    await pending;
    expect(storage.files.get('Cards/OP-1.md')).toContain('priority: highest');
  });

  it('rolls back when the write fails, and rethrows', async () => {
    const { store, host, storage } = await setup();
    storage.modify = async () => {
      throw new Error('disk full');
    };
    await expect(host.update('OP-2', { title: 'new title' })).rejects.toThrow('disk full');
    expect(store.get('OP-2')?.title).toBe('b');
  });

  it('does not undo a newer change when an older write fails', async () => {
    const { store, host, storage } = await setup();
    const realModify = storage.modify.bind(storage);
    let fail!: () => void;
    const gate = new Promise<void>((_, rej) => (fail = () => rej(new Error('boom'))));
    storage.modify = async (path, fn) => {
      if (storage.files.get(path)?.includes('title: a')) await gate;
      return realModify(path, fn);
    };
    const first = host.update('OP-1', { title: 'first' }).catch(() => undefined);
    await Promise.resolve();
    // a newer edit lands in the store (e.g. the vault reported another change)
    store.apply({ ...store.get('OP-1')!, title: 'newer' });
    fail();
    await first;
    expect(store.get('OP-1')?.title).toBe('newer');
  });

  it('moves between columns with a computed rank and persists only that note', async () => {
    const { store, host, storage } = await setup();
    const before = new Map(storage.files);
    await host.move('OP-3', 'doing');
    expect(store.get('OP-3')?.status).toBe('doing');
    const changed = [...storage.files].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);
    expect(changed).toEqual(['Cards/OP-3.md']);
  });

  it('reorders within a column using a placement', async () => {
    const { store, host } = await setup();
    await host.move('OP-3', 'todo', { before: 'OP-1' });
    const order = [...store.all()].sort((a, b) => (a.rank < b.rank ? -1 : 1)).map((c) => c.key);
    expect(order).toEqual(['OP-3', 'OP-1', 'OP-2']);
  });

  it('rejects an unknown column before touching anything', async () => {
    const { host, store } = await setup();
    const before = store.get('OP-1');
    await expect(host.move('OP-1', 'limbo')).rejects.toThrow(/Unknown status/);
    expect(store.get('OP-1')).toBe(before);
  });

  it('create adds the saved card to the store; remove deletes it', async () => {
    const { host, store, storage } = await setup();
    const created = await host.create({ title: 'new one' });
    expect(created.key).toBe('OP-4');
    expect(store.get('OP-4')?.title).toBe('new one');
    await host.remove('OP-4');
    expect(store.get('OP-4')).toBeUndefined();
    expect(storage.files.has('Cards/OP-4.md')).toBe(false);
  });

  it('errors clearly for a card that is not in the store', async () => {
    const { host } = await setup();
    await expect(host.update('OP-99', { title: 'x' })).rejects.toThrow(/not found/);
  });
});
