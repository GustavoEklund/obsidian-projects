import { promises as fsp } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsStorage } from '../src/node';
import { FileExistsError, NotFoundError } from '../src/storage';

let root: string;
let storage: FsStorage;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'oprojects-fs-'));
  await mkdir(path.join(root, '.obsidian'));
  storage = new FsStorage(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const onDisk = (rel: string) => readFile(path.join(root, rel), 'utf8');
const names = (rel: string) => readdir(path.join(root, rel)).then((list) => list.sort());

describe('create', () => {
  it('writes the file, creating every missing folder on the way', async () => {
    await storage.create('Deep/Er/Folder/note.md', 'hello');
    expect(await onDisk('Deep/Er/Folder/note.md')).toBe('hello');
  });

  it('rejects with FileExistsError carrying the path, and leaves the original untouched', async () => {
    await storage.create('a.md', 'first');
    const error = await storage.create('a.md', 'second').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FileExistsError);
    expect((error as FileExistsError).path).toBe('a.md');
    expect((error as Error).message).toBe('File already exists: a.md');
    expect(await onDisk('a.md')).toBe('first');
  });

  it('exactly one of many racing creators wins; the others get FileExistsError', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => storage.create('race.md', `writer ${i}`)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const losers = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason as unknown);
    expect(losers).toHaveLength(11);
    expect(losers.every((e) => e instanceof FileExistsError)).toBe(true);
    expect(await onDisk('race.md')).toMatch(/^writer \d+$/);
  });

  it('keeps unicode names, empty content and big content byte for byte', async () => {
    const big = 'línea larga ünïcode 日本語 🙂\r\n'.repeat(20_000);
    await storage.create('日本語 note ✓.md', big);
    await storage.create('empty.md', '');
    expect(await onDisk('日本語 note ✓.md')).toBe(big);
    expect(await onDisk('empty.md')).toBe('');
    expect(await storage.read('日本語 note ✓.md')).toBe(big);
  });
});

describe('read / exists', () => {
  it('rejects a missing file with NotFoundError naming it', async () => {
    const error = await storage.read('nope.md').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as Error).message).toBe('nope.md not found');
  });

  it('exists is true for files and folders, false for missing paths', async () => {
    await storage.create('Cards/a.md', 'x');
    expect(await storage.exists('Cards/a.md')).toBe(true);
    expect(await storage.exists('Cards')).toBe(true);
    expect(await storage.exists('Cards/b.md')).toBe(false);
  });

  it('reading a folder fails with the underlying error, not NotFoundError', async () => {
    await mkdir(path.join(root, 'folder'));
    const error = await storage.read('folder').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NotFoundError);
  });
});

describe('path safety', () => {
  const escapes = ['../outside.md', 'a/../../outside.md', 'a/b/../../../outside.md', '..'];

  it.each(escapes)('refuses to touch %s (read, create, modify, remove)', async (rel) => {
    await expect(storage.read(rel)).rejects.toThrow(/escapes the vault/);
    await expect(storage.create(rel, 'x')).rejects.toThrow(/escapes the vault/);
    await expect(storage.modify(rel, (c) => c)).rejects.toThrow(/escapes the vault/);
    await expect(storage.remove(rel)).rejects.toThrow(/escapes the vault/);
    await expect(storage.listMarkdown(rel)).rejects.toThrow(/escapes the vault/);
    expect(await storage.exists(rel)).toBe(false);
    expect(await names('.')).not.toContain('outside.md');
  });

  it('treats a leading slash as vault-relative: the file lands inside the vault', async () => {
    await storage.create('/abs/inside.md', 'x');
    expect(await onDisk('abs/inside.md')).toBe('x');
  });

  it('exposes the resolved vault root', () => {
    expect(new FsStorage(path.join(root, 'x', '..')).root).toBe(root);
  });
});

describe('listMarkdown', () => {
  it('walks folders recursively and returns vault-relative paths with forward slashes', async () => {
    await storage.create('Cards/a.md', '');
    await storage.create('Cards/sub/b.md', '');
    await storage.create('Cards/sub/deeper/c.md', '');
    expect((await storage.listMarkdown('Cards')).sort()).toEqual([
      'Cards/a.md',
      'Cards/sub/b.md',
      'Cards/sub/deeper/c.md',
    ]);
  });

  it('skips hidden files and folders, temp files and anything that is not markdown', async () => {
    await storage.create('Cards/a.md', '');
    await storage.create('Cards/.hidden.md', '');
    await storage.create('Cards/.git/inside.md', '');
    await storage.create('Cards/readme.txt', '');
    await storage.create('Cards/image.png', '');
    await storage.create('Cards/noext', '');
    await storage.create('Cards/upper.MD', '');
    expect(await storage.listMarkdown('Cards')).toEqual(['Cards/a.md']);
  });

  it('returns an empty list for a folder that does not exist yet', async () => {
    expect(await storage.listMarkdown('Nope/Deeper')).toEqual([]);
  });

  it('can list the whole vault with an empty folder, still skipping .obsidian and .trash', async () => {
    await storage.create('top.md', '');
    await storage.create('Cards/a.md', '');
    await mkdir(path.join(root, '.trash'));
    await writeFile(path.join(root, '.trash', 'gone.md'), '');
    expect((await storage.listMarkdown('')).sort()).toEqual(['Cards/a.md', 'top.md']);
  });

  it('fails (rather than pretending the folder is empty) when the folder is a file', async () => {
    await storage.create('Cards', 'i am a file');
    await expect(storage.listMarkdown('Cards')).rejects.toThrow(/ENOTDIR/);
  });

  it('does not follow symbolic links to markdown files', async () => {
    await storage.create('Cards/real.md', '');
    await symlink(path.join(root, 'Cards', 'real.md'), path.join(root, 'Cards', 'link.md'));
    expect(await storage.listMarkdown('Cards')).toEqual(['Cards/real.md']);
  });

  it('copes with a few thousand notes', async () => {
    await mkdir(path.join(root, 'Cards'));
    await Promise.all(
      Array.from({ length: 1500 }, (_, i) => writeFile(path.join(root, 'Cards', `n${i}.md`), `# ${i}`)),
    );
    const started = Date.now();
    expect(await storage.listMarkdown('Cards')).toHaveLength(1500);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('modify', () => {
  it('returns the new content, writes it, and passes the current content to the callback', async () => {
    await storage.create('a.md', 'one');
    const seen: string[] = [];
    const result = await storage.modify('a.md', (c) => {
      seen.push(c);
      return `${c} two`;
    });
    expect(result).toBe('one two');
    expect(seen).toEqual(['one']);
    expect(await onDisk('a.md')).toBe('one two');
  });

  it('preserves CRLF, BOM and unicode exactly when the callback returns its input', async () => {
    const content = '﻿---\r\nkey: OP-1\r\n---\r\ncafé 日本語 🙂\r\n';
    await storage.create('a.md', content);
    await storage.modify('a.md', (c) => c);
    expect(await onDisk('a.md')).toBe(content);
  });

  it('leaves the note untouched and no temp file behind when the callback throws', async () => {
    await storage.create('Cards/a.md', 'keep me');
    await expect(
      storage.modify('Cards/a.md', () => {
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');
    expect(await onDisk('Cards/a.md')).toBe('keep me');
    expect(await names('Cards')).toEqual(['a.md']);
  });

  it('rejects with NotFoundError for a missing note and creates nothing', async () => {
    await mkdir(path.join(root, 'Cards'));
    await expect(storage.modify('Cards/missing.md', (c) => `${c}x`)).rejects.toThrow(NotFoundError);
    expect(await names('Cards')).toEqual([]);
  });

  it('never leaves temp files in the folder after a burst of edits', async () => {
    await storage.create('Cards/a.md', '0');
    await Promise.all(Array.from({ length: 25 }, () => storage.modify('Cards/a.md', (c) => `${c}.`)));
    expect(await names('Cards')).toEqual(['a.md']);
  });

  it('serializes concurrent edits of the same note: none is lost and none fails (regression)', async () => {
    // Before the per-file queue, two of three parallel edits died with ENOENT on the shared temp file and the
    // survivor overwrote the others.
    await storage.create('Cards/a.md', 'start');
    const results = await Promise.allSettled(
      ['A', 'B', 'C', 'D', 'E', 'F'].map((letter) => storage.modify('Cards/a.md', (c) => c + letter)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(6).fill('fulfilled'));
    const final = await onDisk('Cards/a.md');
    expect(final.startsWith('start')).toBe(true);
    expect(final.slice(5).split('').sort().join('')).toBe('ABCDEF');
  });

  it('runs edits of the same note in the order they were requested', async () => {
    await storage.create('a.md', '');
    await Promise.all(['1', '2', '3', '4', '5', '6', '7', '8'].map((d) => storage.modify('a.md', (c) => c + d)));
    expect(await onDisk('a.md')).toBe('12345678');
  });

  it('a failed edit does not block or poison the edits queued behind it', async () => {
    await storage.create('a.md', 'x');
    const [first, second, third] = await Promise.allSettled([
      storage.modify('a.md', (c) => `${c}1`),
      storage.modify('a.md', () => {
        throw new Error('boom');
      }),
      storage.modify('a.md', (c) => `${c}3`),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(third.status).toBe('fulfilled');
    expect(await onDisk('a.md')).toBe('x13');
  });

  it('edits of different notes still run in parallel and independently', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => storage.create(`Cards/n${i}.md`, 'x')));
    await Promise.all(Array.from({ length: 20 }, (_, i) => storage.modify(`Cards/n${i}.md`, (c) => `${c}${i}`)));
    for (let i = 0; i < 20; i++) expect(await onDisk(`Cards/n${i}.md`)).toBe(`x${i}`);
  });

  it.skipIf(process.getuid?.() === 0)(
    'reports the error and leaves the folder as it was when the temp file cannot be written',
    async () => {
      await mkdir(path.join(root, 'Cards'));
      await storage.create('Cards/a.md', 'x');
      await chmod(path.join(root, 'Cards'), 0o500); // read + execute only: nothing can be created in the folder
      const failure = await storage.modify('Cards/a.md', (c) => `${c}y`).catch((e: unknown) => e);
      await chmod(path.join(root, 'Cards'), 0o700);
      expect(failure).toBeInstanceOf(Error);
      expect(await names('Cards')).toEqual(['a.md']);
      expect(await onDisk('Cards/a.md')).toBe('x');
      // ...and the queue is still usable afterwards.
      expect(await storage.modify('Cards/a.md', (c) => `${c}z`)).toBe('xz');
    },
  );

  it('removes its temp file, keeps the note intact and reports the error when the final rename fails', async () => {
    await mkdir(path.join(root, 'Cards'));
    await storage.create('Cards/a.md', 'original');
    const rename = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('rename failed'));
    await expect(storage.modify('Cards/a.md', (c) => `${c} changed`)).rejects.toThrow('rename failed');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await names('Cards')).toEqual(['a.md']);
    expect(await onDisk('Cards/a.md')).toBe('original');
    // The queue is not stuck on the failure: the next edit goes through.
    expect(await storage.modify('Cards/a.md', (c) => `${c}!`)).toBe('original!');
  });
});

describe('remove (to .trash)', () => {
  it('moves the note to .trash, keeping its content, and the original disappears', async () => {
    await storage.create('Cards/OP-1.md', 'precious');
    await storage.remove('Cards/OP-1.md');
    expect(await storage.exists('Cards/OP-1.md')).toBe(false);
    expect(await onDisk('.trash/OP-1.md')).toBe('precious');
  });

  it('rejects with NotFoundError for a missing note', async () => {
    await expect(storage.remove('Cards/ghost.md')).rejects.toThrow(NotFoundError);
  });

  it('never overwrites a previously trashed note of the same name', async () => {
    for (const version of ['v1', 'v2', 'v3']) {
      await storage.create('Cards/same.md', version);
      await storage.remove('Cards/same.md');
    }
    const trashed = await names('.trash');
    expect(trashed).toHaveLength(3);
    const contents = await Promise.all(trashed.map((n) => onDisk(`.trash/${n}`)));
    expect(contents.sort()).toEqual(['v1', 'v2', 'v3']);
  });

  it('does not lose notes even when many of them are trashed within the same millisecond (regression)', async () => {
    // The fallback name used to be `name <Date.now()>.md`: identical timestamps overwrote each other.
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    for (let i = 0; i < 6; i++) {
      await storage.create('Cards/same.md', `v${i}`);
      await storage.remove('Cards/same.md');
    }
    const trashed = await names('.trash');
    expect(trashed).toHaveLength(6);
    const contents = await Promise.all(trashed.map((n) => onDisk(`.trash/${n}`)));
    expect(contents.sort()).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5']);
  });

  it('keeps trashed notes out of listings', async () => {
    await storage.create('Cards/a.md', '');
    await storage.create('Cards/b.md', '');
    await storage.remove('Cards/a.md');
    expect(await storage.listMarkdown('Cards')).toEqual(['Cards/b.md']);
    expect(await storage.listMarkdown('')).toEqual(['Cards/b.md']);
  });

  it('trashes two different notes with the same file name from different folders without losing either', async () => {
    await storage.create('Cards/x.md', 'one');
    await storage.create('Other/x.md', 'two');
    await storage.remove('Cards/x.md');
    await storage.remove('Other/x.md');
    const contents = await Promise.all((await names('.trash')).map((n) => onDisk(`.trash/${n}`)));
    expect(contents.sort()).toEqual(['one', 'two']);
  });
});
