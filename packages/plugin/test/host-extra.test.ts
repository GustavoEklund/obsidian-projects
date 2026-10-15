import { CardService, DEFAULT_CONFIG, normalizeConfig, parseCard, type Card } from '@oprojects/core';
import { describe, expect, it, vi } from 'vitest';
import { CardsHost } from '../src/host-impl';
import { CardStore } from '../src/store';
import { createPlatform } from './helpers/platform';
import { AtomicStorage } from './helpers/storage';

const NOW = new Date('2026-10-15T12:00:00.000Z');

async function setup(me = 'Ana', clock: () => Date = () => NOW) {
  const storage = new AtomicStorage();
  const store = new CardStore();
  const config = normalizeConfig({ ...DEFAULT_CONFIG, me });
  let ids = 0;
  const service = new CardService(storage, config, {
    snapshot: () => store.all() as Card[],
    now: clock,
    newId: () => `c${++ids}`,
  });
  const plat = createPlatform();
  const host = new CardsHost(
    store,
    () => service,
    plat,
    () => NOW,
  );
  store.replaceAll([
    await service.create({ title: 'first' }),
    await service.create({ title: 'second' }),
    await service.create({ title: 'third', status: 'doing' }),
  ]);
  const onDisk = (key: string) => parseCard(`Cards/${key}.md`, storage.files.get(`Cards/${key}.md`)!)!;
  return { storage, store, service, host, plat, config, onDisk };
}

describe('CardsHost basics', () => {
  it('reflects the service config, the store contents and readiness', async () => {
    const { host, service, store } = await setup();
    expect(host.config).toBe(service.config);
    expect(host.cards()).toBe(store.all());
    expect(host.ready).toBe(true);
    expect(new CardsHost(new CardStore(), () => service, createPlatform()).ready).toBe(false);
  });

  it('reads the service lazily, so a replaced service takes effect', async () => {
    const { store, plat } = await setup();
    const a = new CardService(new AtomicStorage(), normalizeConfig({ ...DEFAULT_CONFIG, prefix: 'AA' }));
    const b = new CardService(new AtomicStorage(), normalizeConfig({ ...DEFAULT_CONFIG, prefix: 'BB' }));
    let current = a;
    const host = new CardsHost(store, () => current, plat);
    expect(host.config.prefix).toBe('AA');
    current = b;
    expect(host.config.prefix).toBe('BB');
  });

  it('subscribe forwards store changes and the returned function unsubscribes', async () => {
    const { host, store } = await setup();
    const listener = vi.fn();
    const off = host.subscribe(listener);
    store.touch();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.touch();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('now() uses the injected clock, and the real clock by default', async () => {
    const { host, service, store } = await setup();
    expect(host.now()).toBe(NOW);
    const real = new CardsHost(store, () => service, createPlatform());
    expect(Math.abs(real.now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it('hands the platform every argument it was given', async () => {
    const { host, plat } = await setup();
    const card = host.cards()[0]!;
    const el = {} as HTMLElement;
    host.openNote(card, { newTab: true });
    host.menu({ x: 1, y: 2 }, [{ label: 'x' }]);
    host.renderMarkdown(el, '# hi', 'Cards/OP-1.md');
    host.releaseMarkdown(el);
    host.copy('OP-1');
    host.notify('hello');
    await host.confirm('Sure?', 'Yes');
    expect(plat.openNote).toHaveBeenCalledWith(card, { newTab: true });
    expect(plat.menu).toHaveBeenCalledWith({ x: 1, y: 2 }, [{ label: 'x' }]);
    expect(plat.renderMarkdown).toHaveBeenCalledWith(el, '# hi', 'Cards/OP-1.md');
    expect(plat.releaseMarkdown).toHaveBeenCalledWith(el);
    expect(plat.copy).toHaveBeenCalledWith('OP-1');
    expect(plat.notify).toHaveBeenCalledWith('hello');
    expect(plat.confirm).toHaveBeenCalledWith('Sure?', 'Yes');
  });

  it('returns what the platform confirm dialog answered', async () => {
    const { host, plat } = await setup();
    plat.confirm.mockResolvedValueOnce(false);
    expect(await host.confirm('Sure?', 'Yes')).toBe(false);
    expect(await host.confirm('Sure?', 'Yes')).toBe(true);
  });
});

describe('CardsHost comments', () => {
  it('signs a comment with the configured user, shows it at once, and writes the callout', async () => {
    const { host, store, onDisk } = await setup('Ana');
    await host.addComment('OP-1', 'Looks good\n\n- [ ] ship it');
    expect(store.get('OP-1')!.comments).toMatchObject([{ author: 'Ana', text: 'Looks good\n\n- [ ] ship it' }]);
    expect(onDisk('OP-1').comments).toMatchObject([{ author: 'Ana' }]);
  });

  it('falls back to "Anonymous" when the board does not know who you are', async () => {
    const { host, store } = await setup('');
    await host.addComment('OP-1', 'hello');
    expect(store.get('OP-1')!.comments[0]!.author).toBe('Anonymous');
  });

  it('edits and removes a comment by id', async () => {
    const { host, store, onDisk } = await setup();
    await host.addComment('OP-1', 'one');
    await host.addComment('OP-1', 'two');
    const [a, b] = store.get('OP-1')!.comments;
    await host.editComment('OP-1', a!.id, 'one (edited)');
    expect(store.get('OP-1')!.comments.map((c) => c.text)).toEqual(['one (edited)', 'two']);
    await host.removeComment('OP-1', b!.id);
    expect(store.get('OP-1')!.comments.map((c) => c.text)).toEqual(['one (edited)']);
    expect(onDisk('OP-1').comments.map((c) => c.text)).toEqual(['one (edited)']);
  });

  it('refuses comment operations on an unknown card before touching storage', async () => {
    const { host, storage } = await setup();
    const before = new Map(storage.files);
    await expect(host.addComment('OP-99', 'x')).rejects.toThrow('Card OP-99 not found');
    await expect(host.editComment('OP-99', 'c1', 'x')).rejects.toThrow('Card OP-99 not found');
    await expect(host.removeComment('OP-99', 'c1')).rejects.toThrow('Card OP-99 not found');
    expect(storage.files).toEqual(before);
  });

  it('leaves the store alone when the write fails', async () => {
    const { host, store, storage } = await setup();
    vi.spyOn(storage, 'modify').mockRejectedValueOnce(new Error('disk full'));
    const before = store.get('OP-1');
    await expect(host.addComment('OP-1', 'x')).rejects.toThrow('disk full');
    expect(store.get('OP-1')).toBe(before);
  });

  it('reports an unknown comment id as an error and changes nothing', async () => {
    const { host, store } = await setup();
    await host.addComment('OP-1', 'one');
    const before = store.get('OP-1');
    await expect(host.editComment('OP-1', 'nope', 'x')).rejects.toThrow(/Comment nope .*not found/);
    await expect(host.removeComment('OP-1', 'nope')).rejects.toThrow(/Comment nope .*not found/);
    expect(store.get('OP-1')).toBe(before);
  });
});

describe('CardsHost create / remove failures', () => {
  it('create: a failure adds nothing to the store', async () => {
    const { host, store, storage } = await setup();
    vi.spyOn(storage, 'create').mockRejectedValueOnce(new Error('quota exceeded'));
    const count = store.all().length;
    await expect(host.create({ title: 'doomed' })).rejects.toThrow('quota exceeded');
    expect(store.all()).toHaveLength(count);
  });

  it('create: invalid input is rejected with the service message', async () => {
    const { host } = await setup();
    await expect(host.create({ title: '   ' })).rejects.toThrow(/title/i);
    await expect(host.create({ title: 'x', status: 'limbo' })).rejects.toThrow(/Unknown status/);
  });

  it('remove: a failure keeps the card in the store', async () => {
    const { host, store, storage } = await setup();
    vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error('read-only'));
    await expect(host.remove('OP-1')).rejects.toThrow('read-only');
    expect(store.get('OP-1')).toBeDefined();
  });

  it('remove: an unknown card is an error', async () => {
    const { host } = await setup();
    await expect(host.remove('OP-99')).rejects.toThrow(/not found/i);
  });
});

describe('CardsHost move and resolved', () => {
  it('sets `resolved` when a card enters a done column and clears it when it leaves', async () => {
    const { host, store, onDisk } = await setup();
    await host.move('OP-1', 'done');
    expect(store.get('OP-1')!.resolved).toBe(NOW.toISOString());
    expect(onDisk('OP-1').resolved).toBe(NOW.toISOString());
    await host.move('OP-1', 'todo');
    expect(store.get('OP-1')!.resolved).toBeUndefined();
  });

  it('refuses to place a card relative to one that is not in the target column, changing nothing', async () => {
    const { host, store, storage } = await setup();
    const before = new Map(storage.files);
    const card = store.get('OP-1');
    await expect(host.move('OP-1', 'doing', { before: 'OP-2' })).rejects.toThrow(/not in column/);
    expect(storage.files).toEqual(before);
    expect(store.get('OP-1')).toBe(card);
  });

  it('refuses to move a card that is not in the store', async () => {
    const { host } = await setup();
    await expect(host.move('OP-99', 'doing')).rejects.toThrow('Card OP-99 not found');
  });

  it('puts a card at the bottom of the column when no placement is given', async () => {
    const { host, store } = await setup();
    await host.move('OP-1', 'doing');
    const doing = [...store.all()].filter((c) => c.status === 'doing').sort((a, b) => (a.rank < b.rank ? -1 : 1));
    expect(doing.map((c) => c.key)).toEqual(['OP-3', 'OP-1']);
  });
});

describe('CardsHost optimistic updates', () => {
  it('shows the guess synchronously, before anything is awaited', async () => {
    const { host, store } = await setup();
    const pending = host.update('OP-1', { title: '  Spaced   out  ' });
    expect(store.get('OP-1')!.title).toBe('Spaced out'); // normalized like the service will
    await pending;
  });

  it('notifies once when the saved card is exactly the guess', async () => {
    const { host, store } = await setup();
    const listener = vi.fn();
    store.subscribe(listener);
    await host.update('OP-1', { priority: 'highest' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies again when the saved card differs from the guess (the service stamps `updated`)', async () => {
    let tick = 0;
    const { host, store } = await setup('Ana', () => new Date(NOW.getTime() + ++tick * 1000));
    const listener = vi.fn();
    store.subscribe(listener);
    await host.update('OP-1', { priority: 'highest' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(Date.parse(store.get('OP-1')!.updated)).toBeGreaterThan(NOW.getTime());
  });

  it('rolls back to exactly the card that was there before (same object)', async () => {
    const { host, store, storage } = await setup();
    const before = store.get('OP-1');
    vi.spyOn(storage, 'modify').mockRejectedValueOnce(new Error('nope'));
    await expect(host.update('OP-1', { priority: 'lowest' })).rejects.toThrow('nope');
    expect(store.get('OP-1')).toBe(before);
  });

  it('does not bring back a card that was deleted while its edit was failing', async () => {
    const { host, store, storage } = await setup();
    let fail!: () => void;
    const gate = new Promise<void>((_, reject) => (fail = () => reject(new Error('late failure'))));
    vi.spyOn(storage, 'modify').mockImplementationOnce(async () => {
      await gate;
      return '';
    });
    const pending = host.update('OP-1', { title: 'edited' }).catch(() => undefined);
    await Promise.resolve();
    store.remove('OP-1'); // the note was deleted in the meantime
    fail();
    await pending;
    expect(store.get('OP-1')).toBeUndefined();
  });

  it('two edits to different fields of one card both end up in the store and on disk', async () => {
    const { host, store, onDisk } = await setup();
    await Promise.all([
      host.update('OP-1', { title: 'renamed' }),
      host.update('OP-1', { priority: 'highest' }),
      host.update('OP-1', { labels: ['a', 'b'] }),
    ]);
    expect(store.get('OP-1')).toMatchObject({ title: 'renamed', priority: 'highest', labels: ['a', 'b'] });
    expect(onDisk('OP-1')).toMatchObject({ title: 'renamed', priority: 'highest', labels: ['a', 'b'] });
  });

  it('keeps the store equal to the notes after a mixed burst of moves and edits', async () => {
    const { host, store, onDisk } = await setup();
    await Promise.all([
      host.move('OP-1', 'doing'),
      host.update('OP-2', { assignee: 'Bo' }),
      host.move('OP-3', 'done'),
      host.move('OP-2', 'review', { after: undefined }),
    ]);
    for (const card of store.all())
      expect(onDisk(card.key)).toMatchObject({ status: card.status, assignee: card.assignee, rank: card.rank });
  });

  it('rejects an invalid patch and leaves the card as it was', async () => {
    const { host, store, storage } = await setup();
    const before = store.get('OP-1');
    const files = new Map(storage.files);
    await expect(host.update('OP-1', { due: 'tomorrow-ish' })).rejects.toThrow(/due/i);
    expect(store.get('OP-1')).toBe(before);
    expect(storage.files).toEqual(files);
  });
});
