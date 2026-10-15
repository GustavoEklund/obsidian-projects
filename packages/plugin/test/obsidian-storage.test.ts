import { CardService, DEFAULT_CONFIG, FileExistsError, NotFoundError, parseCard } from '@oprojects/core';
import type { App } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObsidianStorage } from '../src/obsidian-storage';
import { FakeApp } from './helpers/fake-obsidian';

vi.mock('obsidian', async () => await import('./helpers/fake-obsidian'));

let app: FakeApp;
let storage: ObsidianStorage;

beforeEach(() => {
  app = new FakeApp();
  storage = new ObsidianStorage(app as unknown as App);
});

describe('ObsidianStorage.listMarkdown', () => {
  beforeEach(() => {
    app.vault.seed({
      'Cards/OP-1.md': 'a',
      'Cards/sub/deeper/OP-2.md': 'b',
      'Cards2/OP-3.md': 'c',
      'Other/note.md': 'd',
      'root.md': 'e',
      'Cards/picture.png': 'not markdown',
    });
  });

  it('lists every markdown file under the folder, recursively', async () => {
    expect((await storage.listMarkdown('Cards')).sort()).toEqual(['Cards/OP-1.md', 'Cards/sub/deeper/OP-2.md']);
  });

  it('does not mistake a folder with a similar name for the same folder', async () => {
    expect(await storage.listMarkdown('Cards2')).toEqual(['Cards2/OP-3.md']);
    expect(await storage.listMarkdown('Card')).toEqual([]);
  });

  it('lists the whole vault for an empty folder', async () => {
    expect((await storage.listMarkdown('')).sort()).toEqual([
      'Cards/OP-1.md',
      'Cards/sub/deeper/OP-2.md',
      'Cards2/OP-3.md',
      'Other/note.md',
      'root.md',
    ]);
  });

  it('returns an empty list, not an error, for a folder that does not exist yet', async () => {
    expect(await storage.listMarkdown('Nothing')).toEqual([]);
  });
});

describe('ObsidianStorage.read', () => {
  it('reads a note', async () => {
    app.vault.seed({ 'Cards/OP-1.md': 'hello' });
    expect(await storage.read('Cards/OP-1.md')).toBe('hello');
  });

  it('normalizes the path first', async () => {
    app.vault.seed({ 'Cards/OP-1.md': 'hello' });
    expect(await storage.read('/Cards//OP-1.md')).toBe('hello');
    expect(await storage.read('Cards\\OP-1.md')).toBe('hello');
  });

  it('reads the live content, not a cached copy', async () => {
    app.vault.seed({ 'Cards/OP-1.md': 'live' });
    app.vault.cache.set('Cards/OP-1.md', 'stale');
    expect(await storage.read('Cards/OP-1.md')).toBe('live');
    expect(app.vault.cachedReads).toEqual([]);
  });

  it('throws NotFoundError for a missing note and for a folder', async () => {
    app.vault.seed({ 'Cards/OP-1.md': 'x' });
    await expect(storage.read('Cards/OP-9.md')).rejects.toBeInstanceOf(NotFoundError);
    await expect(storage.read('Cards')).rejects.toThrow('Cards not found');
  });
});

describe('ObsidianStorage.create', () => {
  it('writes the note', async () => {
    app.vault.seed({ 'Cards/OP-1.md': 'x' });
    await storage.create('Cards/OP-2.md', 'two');
    expect(app.vault.files.get('Cards/OP-2.md')).toBe('two');
  });

  it('creates the missing folders, one level at a time', async () => {
    await storage.create('Work/Board/Cards/OP-1.md', 'one');
    expect([...app.vault.folders].sort()).toEqual(['Work', 'Work/Board', 'Work/Board/Cards']);
    expect(app.vault.files.get('Work/Board/Cards/OP-1.md')).toBe('one');
  });

  it('creates a note at the vault root without creating folders', async () => {
    await storage.create('OP-1.md', 'root');
    expect(app.vault.folders.size).toBe(0);
    expect(app.vault.files.get('OP-1.md')).toBe('root');
  });

  it('rejects with FileExistsError when the note already exists, and does not touch it', async () => {
    app.vault.seed({ 'Cards/OP-1.md': 'original' });
    const error = await storage.create('Cards/OP-1.md', 'new').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FileExistsError);
    expect((error as FileExistsError).path).toBe('Cards/OP-1.md');
    expect(app.vault.files.get('Cards/OP-1.md')).toBe('original');
  });

  it('reports the normalized path in that error', async () => {
    app.vault.seed({ 'Cards/OP-1.md': 'original' });
    await expect(storage.create('/Cards//OP-1.md', 'new')).rejects.toMatchObject({ path: 'Cards/OP-1.md' });
  });

  it('turns losing a race with another writer into FileExistsError (so the service takes the next key)', async () => {
    app.vault.seed({ Cards: '' });
    app.vault.files.delete('Cards');
    app.vault.folders.add('Cards');
    const create = vi.spyOn(app.vault, 'create').mockRejectedValueOnce(new Error('File already exists.'));
    await expect(storage.create('Cards/OP-1.md', 'mine')).rejects.toBeInstanceOf(FileExistsError);
    create.mockRestore();
  });

  it('lets any other write error through unchanged', async () => {
    app.vault.folders.add('Cards');
    vi.spyOn(app.vault, 'create').mockRejectedValueOnce(new Error('disk full'));
    await expect(storage.create('Cards/OP-1.md', 'x')).rejects.toThrow('disk full');
  });

  it('tolerates another writer creating the folder first', async () => {
    const original = app.vault.createFolder.bind(app.vault);
    vi.spyOn(app.vault, 'createFolder').mockImplementationOnce(async (path: string) => {
      await original(path); // someone else got there first...
      throw new Error('Folder already exists.'); // ...so ours reports that
    });
    await storage.create('Cards/OP-1.md', 'ok');
    expect(app.vault.files.get('Cards/OP-1.md')).toBe('ok');
  });

  it('surfaces a real folder error', async () => {
    vi.spyOn(app.vault, 'createFolder').mockRejectedValueOnce(new Error('permission denied'));
    await expect(storage.create('Cards/OP-1.md', 'x')).rejects.toThrow('permission denied');
  });
});

describe('ObsidianStorage.modify', () => {
  it("applies the change through the vault's atomic process() and returns the new content", async () => {
    app.vault.seed({ 'Cards/OP-1.md': 'abc' });
    const process = vi.spyOn(app.vault, 'process');
    expect(await storage.modify('Cards/OP-1.md', (c) => c.toUpperCase())).toBe('ABC');
    expect(app.vault.files.get('Cards/OP-1.md')).toBe('ABC');
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent modifications: none is lost', async () => {
    app.vault.seed({ 'Cards/OP-1.md': '' });
    await Promise.all(Array.from({ length: 10 }, (_, i) => storage.modify('Cards/OP-1.md', (c) => `${c}${i}`)));
    expect(app.vault.files.get('Cards/OP-1.md')).toBe('0123456789');
  });

  it('throws NotFoundError for a missing note without calling the callback', async () => {
    const fn = vi.fn((c: string) => c);
    await expect(storage.modify('Cards/OP-9.md', fn)).rejects.toBeInstanceOf(NotFoundError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('propagates an error thrown by the callback and leaves the note as it was', async () => {
    app.vault.seed({ 'Cards/OP-1.md': 'keep' });
    await expect(
      storage.modify('Cards/OP-1.md', () => {
        throw new Error('bad edit');
      }),
    ).rejects.toThrow('bad edit');
    expect(app.vault.files.get('Cards/OP-1.md')).toBe('keep');
    await storage.modify('Cards/OP-1.md', (c) => `${c}!`); // and the queue is not stuck
    expect(app.vault.files.get('Cards/OP-1.md')).toBe('keep!');
  });
});

describe('ObsidianStorage.remove / exists', () => {
  it("sends the note to the user's trash through the file manager (respecting their deletion setting)", async () => {
    app.vault.seed({ 'Cards/OP-1.md': 'x' });
    await storage.remove('Cards/OP-1.md');
    expect(app.fileManager.trashFile).toHaveBeenCalledTimes(1);
    expect(app.trashed).toEqual(['Cards/OP-1.md']);
    expect(app.vault.files.has('Cards/OP-1.md')).toBe(false);
  });

  it('throws NotFoundError for a missing note', async () => {
    await expect(storage.remove('Cards/OP-1.md')).rejects.toBeInstanceOf(NotFoundError);
    expect(app.fileManager.trashFile).not.toHaveBeenCalled();
  });

  it('exists() is true for notes and folders, with normalized paths, and false otherwise', async () => {
    app.vault.seed({ 'Cards/OP-1.md': 'x' });
    expect(await storage.exists('Cards/OP-1.md')).toBe(true);
    expect(await storage.exists('/Cards//OP-1.md')).toBe(true);
    expect(await storage.exists('Cards')).toBe(true);
    expect(await storage.exists('Cards/OP-2.md')).toBe(false);
  });
});

describe("ObsidianStorage under CardService (the plugin's real wiring)", () => {
  const config = { ...DEFAULT_CONFIG };

  it('creates, moves, comments on and deletes cards, one note each', async () => {
    const service = new CardService(storage, config);
    const a = await service.create({ title: 'First' });
    const b = await service.create({ title: 'Second', status: 'doing' });
    expect([a.key, b.key]).toEqual(['OP-1', 'OP-2']);
    expect([...app.vault.files.keys()].sort()).toEqual(['Cards/OP-1.md', 'Cards/OP-2.md']);

    await service.update('OP-1', { status: 'done' });
    await service.addComment('OP-1', { text: 'shipped', author: 'Ana' });
    expect(parseCard('Cards/OP-1.md', app.vault.files.get('Cards/OP-1.md')!)).toMatchObject({
      status: 'done',
      comments: [{ author: 'Ana', text: 'shipped' }],
    });

    await service.remove('OP-2');
    expect([...app.vault.files.keys()]).toEqual(['Cards/OP-1.md']);
    expect((await service.list()).map((c) => c.key)).toEqual(['OP-1']);
  });

  it('allocates the next key when another writer takes a number between the check and the write', async () => {
    const service = new CardService(storage, config);
    await service.create({ title: 'Seed the folder' }); // OP-1
    const real = app.vault.create.bind(app.vault);
    let raced = false;
    vi.spyOn(app.vault, 'create').mockImplementation(async (path: string, content: string) => {
      if (!raced) {
        raced = true;
        app.vault.seed({ [path]: 'someone else was faster' }); // sync client drops OP-2 right now
      }
      return real(path, content);
    });
    const card = await service.create({ title: 'Second' });
    expect(card.key).toBe('OP-3');
    expect(app.vault.files.get('Cards/OP-2.md')).toBe('someone else was faster');
  });
});
