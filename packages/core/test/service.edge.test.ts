import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config';
import { FsStorage } from '../src/node';
import { groupByColumn, isArchivedDone } from '../src/query';
import { CardService, ValidationError } from '../src/service';
import { FileExistsError, MemoryStorage, NotFoundError, type Storage } from '../src/storage';
import type { Card } from '../src/types';

vi.setConfig({ testTimeout: 30_000 });

const config = normalizeConfig({ ...DEFAULT_CONFIG, prefix: 'OP', me: 'Ana', members: ['Ana', 'Bruno'] });
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 14, 12, 0, tick++));
const service = (storage: Storage = new MemoryStorage(), options: ConstructorParameters<typeof CardService>[2] = {}) =>
  new CardService(storage, config, { now: clock, ...options });

beforeEach(() => {
  tick = 0;
});

describe('MemoryStorage (the test double must honour the Storage contract)', () => {
  it('modify is an atomic read-modify-write: parallel edits are applied one after the other (regression)', async () => {
    // The first version awaited between reading and writing, so three parallel edits ended as "startC".
    const storage = new MemoryStorage();
    await storage.create('a.md', 'start');
    await Promise.all(['A', 'B', 'C', 'D'].map((l) => storage.modify('a.md', (c) => c + l)));
    expect(storage.files.get('a.md')).toBe('startABCD');
  });

  it('modify rejects for a missing note and writes nothing', async () => {
    const storage = new MemoryStorage();
    await expect(storage.modify('nope.md', (c) => c)).rejects.toThrow(NotFoundError);
    expect(storage.files.size).toBe(0);
  });

  it('modify keeps the note when the callback throws', async () => {
    const storage = new MemoryStorage();
    await storage.create('a.md', 'keep');
    await expect(
      storage.modify('a.md', () => {
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');
    expect(storage.files.get('a.md')).toBe('keep');
  });

  it('lists only markdown files under the folder prefix, not look-alike folders', async () => {
    const storage = new MemoryStorage();
    for (const p of ['Cards/a.md', 'Cards/sub/b.md', 'Cards/c.txt', 'CardsExtra/d.md', 'e.md'])
      await storage.create(p, '');
    expect((await storage.listMarkdown('Cards')).sort()).toEqual(['Cards/a.md', 'Cards/sub/b.md']);
    expect((await storage.listMarkdown('')).sort()).toEqual([
      'Cards/a.md',
      'Cards/sub/b.md',
      'CardsExtra/d.md',
      'e.md',
    ]);
  });

  it('create/remove/exists follow the contract', async () => {
    const storage = new MemoryStorage();
    await storage.create('a.md', 'x');
    await expect(storage.create('a.md', 'y')).rejects.toThrow(FileExistsError);
    expect(await storage.exists('a.md')).toBe(true);
    await storage.remove('a.md');
    expect(await storage.exists('a.md')).toBe(false);
    await expect(storage.remove('a.md')).rejects.toThrow(NotFoundError);
    await expect(storage.read('a.md')).rejects.toThrow('a.md not found');
  });
});

describe('concurrency', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oprojects-svc-'));
    await mkdir(path.join(root, '.obsidian'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it.each([
    ['memory', () => new MemoryStorage()],
    ['disk', () => new FsStorage(root)],
  ])(
    'parallel creates through one service all succeed with consecutive keys, in call order (%s) (regression)',
    async (_name, make) => {
      // Before creates were queued, more than 8 parallel callers exhausted the retry budget and the rest failed.
      const svc = service(make());
      const cards = await Promise.all(Array.from({ length: 40 }, (_, i) => svc.create({ title: `card ${i}` })));
      expect(cards.map((c) => c.key)).toEqual(Array.from({ length: 40 }, (_, i) => `OP-${i + 1}`));
      expect((await svc.list()).map((c) => c.key).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))).toHaveLength(
        40,
      );
    },
  );

  it('creates from two services on the same folder (plugin + CLI) never collide or overwrite each other', async () => {
    const storage = new FsStorage(root);
    const a = service(storage);
    const b = service(storage);
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).create({ title: `n${i}`, body: `body ${i}` })),
    );
    expect(new Set(created.map((c) => c.key)).size).toBe(10);
    const listed = await a.list();
    expect(listed).toHaveLength(10);
    expect(listed.map((c) => c.body.trim()).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `body ${i}`).sort());
  });

  it('a create that fails validation does not block or break the creates queued behind it', async () => {
    const svc = service();
    const results = await Promise.allSettled([
      svc.create({ title: 'first' }),
      svc.create({ title: '   ' }),
      svc.create({ title: 'third' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((await svc.list()).map((c) => c.title)).toEqual(['first', 'third']);
    expect((results[2] as PromiseFulfilledResult<Card>).value.key).toBe('OP-2');
  });

  it('parallel comments on one card on disk are all kept, with distinct ids', async () => {
    const svc = service(new FsStorage(root));
    await svc.create({ title: 'Busy' });
    let n = 0;
    const busy = service(new FsStorage(root), { newId: () => `id${n++}` });
    await Promise.all(Array.from({ length: 12 }, (_, i) => busy.addComment('OP-1', { text: `comment ${i}` })));
    const card = await svc.get('OP-1');
    expect(card.comments).toHaveLength(12);
    expect(new Set(card.comments.map((c) => c.id)).size).toBe(12);
    expect(card.comments.map((c) => c.text).sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => `comment ${i}`).sort(),
    );
  });

  it('parallel updates of different fields of one card are all applied', async () => {
    const svc = service(new FsStorage(root));
    await svc.create({ title: 'Target' });
    await Promise.all([
      svc.update('OP-1', { priority: 'high' }),
      svc.update('OP-1', { assignee: 'Bruno' }),
      svc.update('OP-1', { labels: ['x'] }),
      svc.update('OP-1', { estimate: 3 }),
    ]);
    expect(await svc.get('OP-1')).toMatchObject({ priority: 'high', assignee: 'Bruno', labels: ['x'], estimate: 3 });
  });
});

describe('notes edited or arranged by hand', () => {
  it('lists both notes when a sync conflict leaves two with the same key, and `get` prefers the file named after the key', async () => {
    const storage = new MemoryStorage();
    const svc = service(storage);
    await svc.create({ title: 'Original' });
    await storage.create(
      'Cards/OP-1 (conflicted copy).md',
      '---\nkey: OP-1\ntitle: Conflict copy\nstatus: todo\nrank: Z\n---\n',
    );
    expect((await svc.list()).map((c) => c.title).sort()).toEqual(['Conflict copy', 'Original']);
    expect((await svc.get('OP-1')).title).toBe('Original');
    expect((await svc.create({ title: 'Next' })).key).toBe('OP-2');
  });

  it('finds a card whose note was renamed or moved by hand, and edits, moves and deletes it in place', async () => {
    const storage = new MemoryStorage();
    await storage.create(
      'Cards/Archive/Some renamed note.md',
      '---\nkey: OP-5\ntitle: Hidden away\nstatus: todo\nrank: V\n---\nBody\n',
    );
    const svc = service(storage);
    expect((await svc.get('5')).path).toBe('Cards/Archive/Some renamed note.md');
    await svc.update('OP-5', { priority: 'high' });
    await svc.move('OP-5', 'doing');
    expect((await svc.get('OP-5')).status).toBe('doing');
    expect([...storage.files.keys()]).toEqual(['Cards/Archive/Some renamed note.md']);
    expect((await svc.create({ title: 'After' })).key).toBe('OP-6');
    await svc.remove('OP-5');
    await expect(svc.get('OP-5')).rejects.toThrow(NotFoundError);
  });

  it('ignores a note whose frontmatter is broken, and never overwrites its file when allocating keys', async () => {
    const storage = new MemoryStorage();
    const svc = service(storage);
    await svc.create({ title: 'One' });
    await svc.create({ title: 'Two' });
    const broken = '---\nkey: OP-3\ntitle: [unclosed\n---\nprecious text\n';
    await storage.create('Cards/OP-3.md', broken);
    expect((await svc.list()).map((c) => c.key)).toEqual(['OP-1', 'OP-2']);
    const created = await svc.create({ title: 'Three' });
    expect(created.key).toBe('OP-4');
    expect(storage.files.get('Cards/OP-3.md')).toBe(broken);
    await expect(svc.get('OP-3')).rejects.toThrow(NotFoundError);
  });

  it('does not trust a note named after one key but holding another', async () => {
    const storage = new MemoryStorage();
    await storage.create('Cards/OP-1.md', '---\nkey: OP-9\ntitle: Wrong name\nstatus: todo\n---\n');
    const svc = service(storage);
    await expect(svc.get('OP-1')).rejects.toThrow('Card OP-1 not found');
    expect((await svc.get('OP-9')).title).toBe('Wrong name');
  });

  it('reads a CRLF note with a BOM and keeps its description through an update', async () => {
    const storage = new MemoryStorage();
    await storage.create(
      'Cards/OP-1.md',
      '﻿---\r\nkey: OP-1\r\ntitle: Crlf card\r\nstatus: todo\r\nrank: V\r\n---\r\nLine one\r\nLine two\r\n',
    );
    const svc = service(storage);
    expect((await svc.get('OP-1')).title).toBe('Crlf card');
    const updated = await svc.update('OP-1', { priority: 'high' });
    expect(updated.priority).toBe('high');
    expect(updated.body).toContain('Line one\r\nLine two');
    expect(storage.files.get('Cards/OP-1.md')!.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('skips notes it cannot read instead of failing the whole board', async () => {
    class Flaky extends MemoryStorage {
      override async read(p: string): Promise<string> {
        if (p.includes('locked')) throw new Error('EACCES');
        return super.read(p);
      }
    }
    const storage = new Flaky();
    const svc = service(storage);
    await svc.create({ title: 'fine' });
    await storage.create('Cards/locked.md', '---\nkey: OP-7\n---\n');
    expect((await svc.list()).map((c) => c.key)).toEqual(['OP-1']);
  });

  it('keeps unicode titles and descriptions intact through disk', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oprojects-uni-'));
    try {
      await mkdir(path.join(root, '.obsidian'));
      const svc = service(new FsStorage(root));
      const card = await svc.create({
        title: 'Zoë 日本語 🙂 — Straße',
        body: 'ünïcode body\n\n- [ ] 日本語 task',
        labels: ['Café', '日本語'],
      });
      const read = await service(new FsStorage(root)).get(card.key);
      expect(read.title).toBe('Zoë 日本語 🙂 — Straße');
      expect(read.body.trim()).toBe('ünïcode body\n\n- [ ] 日本語 task');
      expect(read.labels).toEqual(['Café', '日本語']);
      expect(read.checklist).toEqual({ done: 0, total: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses the number of the highest card once it is deleted (numbering continues after the highest existing key)', async () => {
    const svc = service();
    await svc.create({ title: 'a' });
    await svc.create({ title: 'b' });
    await svc.remove('OP-2');
    expect((await svc.create({ title: 'again' })).key).toBe('OP-2');
  });
});

describe('a big board', () => {
  const STATUSES = ['todo', 'doing', 'review', 'done'];

  async function boardOf(count: number) {
    const storage = new MemoryStorage();
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        storage.create(
          `Cards/OP-${i + 1}.md`,
          `---\nkey: OP-${i + 1}\ntitle: Card number ${i + 1}${i % 7 === 0 ? ' login' : ''}\nstatus: ${STATUSES[i % 4]}\npriority: ${i % 3 ? 'medium' : 'high'}\nlabels: [${i % 5 ? 'api' : 'ux'}]\nrank: ${String.fromCharCode(65 + (i % 26))}${i}\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\n---\nBody ${i}\n`,
        ),
      ),
    );
    return { storage, svc: service(storage) };
  }

  /** The fastest of a few runs: noise from other processes only ever makes a run slower. */
  async function best(work: () => unknown, runs = 2): Promise<number> {
    let fastest = Infinity;
    for (let i = 0; i < runs; i++) {
      const started = performance.now();
      await work();
      fastest = Math.min(fastest, performance.now() - started);
    }
    return fastest;
  }

  // A wall-clock limit would fail on a busy machine. What matters is how the cost grows: four times the cards
  // should cost about four times as much (linear); an accidentally quadratic loop would cost about sixteen times.
  const MAX_GROWTH = 10;
  const FLOOR_MS = 5; // below this, timer resolution and scheduling noise dominate the ratio

  it('lists, filters and groups a big board in time proportional to its size', async () => {
    const small = await boardOf(250);
    const big = await boardOf(1000);

    const all = await big.svc.list();
    expect(all).toHaveLength(1000);
    expect((await big.svc.list()).map((c) => c.key).sort()).toEqual(all.map((c) => c.key).sort());
    expect(await best(() => big.svc.list())).toBeLessThan(30_000); // only a safety net

    const listGrowth = (await best(() => big.svc.list())) / Math.max(await best(() => small.svc.list()), FLOOR_MS);
    expect(listGrowth, 'list() growth for 4x the cards').toBeLessThan(MAX_GROWTH);

    const query = { text: 'login', priority: ['high' as const], labels: ['api'], includeArchived: true };
    const found = await big.svc.find(query);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((c) => c.title.includes('login') && c.priority === 'high' && c.labels.includes('api'))).toBe(
      true,
    );
    const findGrowth =
      (await best(() => big.svc.find(query))) / Math.max(await best(() => small.svc.find(query)), FLOOR_MS);
    expect(findGrowth, 'find() growth for 4x the cards').toBeLessThan(MAX_GROWTH);

    const smallAll = await small.svc.list();
    const groups = groupByColumn(all, config);
    expect(groups.reduce((n, g) => n + g.cards.length, 0)).toBe(1000);
    for (const g of groups) expect(g.cards).toHaveLength(250);
    const groupGrowth =
      (await best(() => groupByColumn(all, config))) / Math.max(await best(() => groupByColumn(smallAll, config)), 1);
    expect(groupGrowth, 'groupByColumn() growth for 4x the cards').toBeLessThan(MAX_GROWTH * 2); // sub-millisecond: noisier
  });

  it('numbers the next card after the highest key on a big board', async () => {
    const { svc } = await boardOf(1000);
    const created = await svc.create({ title: 'one more' });
    expect(created.key).toBe('OP-1001');
  });

  it('hides old done cards from `find` unless asked, even on a big board', async () => {
    const storage = new MemoryStorage();
    const svc = service(storage);
    for (let i = 0; i < 30; i++) await svc.create({ title: `c${i}`, status: i % 2 ? 'done' : 'todo' });
    const later = new CardService(storage, config, { now: () => new Date('2027-06-01T00:00:00Z') });
    const visible = await later.find();
    const everything = await later.find({ includeArchived: true });
    expect(everything).toHaveLength(30);
    expect(visible).toHaveLength(15);
    expect(visible.every((c) => !isArchivedDone(c, config, new Date('2027-06-01T00:00:00Z')))).toBe(true);
  });
});

describe('find', () => {
  async function seeded() {
    const svc = service();
    await svc.create({ title: 'Login bug', type: 'bug', priority: 'high', assignee: 'Ana', labels: ['auth'] });
    await svc.create({ title: 'Payments story', type: 'story', assignee: 'Bruno', labels: ['pay'], status: 'doing' });
    await svc.create({ title: 'Unowned task', status: 'review' });
    await svc.create({ title: 'Epic parent', type: 'epic' });
    await svc.create({ title: 'Child of four', parent: '4', assignee: 'Ana' });
    return svc;
  }
  const keys = (cards: Card[]) => cards.map((c) => c.key);

  it('resolves `me`, `none` and plain names, case-insensitively, and ORs several assignees', async () => {
    const svc = await seeded();
    expect(keys(await svc.find({ assignee: ['me'] }))).toEqual(['OP-1', 'OP-5']);
    expect(keys(await svc.find({ assignee: ['ME'] }))).toEqual(['OP-1', 'OP-5']);
    expect(keys(await svc.find({ assignee: ['none'] }))).toEqual(['OP-4', 'OP-3']); // board order: column first
    expect(keys(await svc.find({ assignee: ['bruno'] }))).toEqual(['OP-2']);
    expect(keys(await svc.find({ assignee: ['me', 'none'] }))).toEqual(['OP-1', 'OP-4', 'OP-5', 'OP-3']);
  });

  it('refuses `me` on a board without a configured user, explaining how to fix it', async () => {
    const svc = new CardService(new MemoryStorage(), normalizeConfig({ ...DEFAULT_CONFIG, me: '' }));
    await expect(svc.find({ assignee: ['me'] })).rejects.toThrow(/"me" is not configured/);
  });

  it('accepts column ids and display names for status, and reports the valid ones otherwise', async () => {
    const svc = await seeded();
    expect(keys(await svc.find({ status: ['doing'] }))).toEqual(['OP-2']);
    expect(keys(await svc.find({ status: ['In Progress', 'review'] }))).toEqual(['OP-2', 'OP-3']);
    await expect(svc.find({ status: ['limbo'] })).rejects.toThrow(
      'Unknown status "limbo" (valid: todo, doing, review, done)',
    );
  });

  it('accepts a bare number or lower-case key for the parent filter', async () => {
    const svc = await seeded();
    expect(keys(await svc.find({ parent: '4' }))).toEqual(['OP-5']);
    expect(keys(await svc.find({ parent: 'op-4' }))).toEqual(['OP-5']);
    await expect(svc.find({ parent: 'not a key' })).rejects.toThrow(ValidationError);
  });

  it('rejects unknown types and priorities with the list of valid values', async () => {
    const svc = await seeded();
    await expect(svc.find({ type: ['chore' as never] })).rejects.toThrow(
      'Invalid type "chore" (task, story, bug, epic)',
    );
    await expect(svc.find({ priority: ['urgent' as never] })).rejects.toThrow(
      'Invalid priority "urgent" (highest, high, medium, low, lowest)',
    );
  });

  it('combines text, type, priority and labels with AND, and ignores blank text', async () => {
    const svc = await seeded();
    expect(keys(await svc.find({ text: 'login', type: ['bug'], priority: ['high'], labels: ['auth'] }))).toEqual([
      'OP-1',
    ]);
    expect(keys(await svc.find({ text: 'login', type: ['story'] }))).toEqual([]);
    expect(await svc.find({ text: '   ' })).toHaveLength(5);
    expect(await svc.find()).toHaveLength(5);
  });

  it('returns cards in board order', async () => {
    const svc = await seeded();
    expect(keys(await svc.find())).toEqual(['OP-1', 'OP-4', 'OP-5', 'OP-2', 'OP-3']);
  });
});

describe('resolveKey', () => {
  const svc = service();

  it('turns bare numbers into keys of the board prefix, ignoring leading zeros and spaces', () => {
    fc.assert(
      fc.property(fc.nat({ max: 99999 }), (n) => {
        expect(svc.resolveKey(String(n))).toBe(`OP-${n}`);
        expect(svc.resolveKey(`  ${String(n).padStart(6, '0')} `)).toBe(`OP-${n}`);
      }),
      { numRuns: 100 },
    );
  });

  it('upper-cases and trims keys, and accepts other prefixes as they are', () => {
    expect(svc.resolveKey(' op-12 ')).toBe('OP-12');
    expect(svc.resolveKey('web-3')).toBe('WEB-3');
  });

  it('rejects anything else with a message naming the input and the expected shape', () => {
    for (const bad of ['', 'abc', 'OP-', '-12', 'OP-1x', 'O-1', 'OP 12', 'OP--1', '1.5']) {
      expect(() => svc.resolveKey(bad)).toThrow(ValidationError);
      expect(() => svc.resolveKey(bad)).toThrow(`"${bad}" is not a card key (expected OP-123 or 123)`);
    }
  });
});

describe('get / remove', () => {
  it('rejects a card that does not exist with NotFoundError, and a malformed key with ValidationError', async () => {
    const svc = service();
    await expect(svc.get('OP-404')).rejects.toThrow(NotFoundError);
    await expect(svc.get('OP-404')).rejects.toThrow('Card OP-404 not found');
    await expect(svc.get('nonsense')).rejects.toThrow(ValidationError);
  });

  it('remove returns the card, deletes the note, and a second remove fails', async () => {
    const storage = new MemoryStorage();
    const svc = service(storage);
    await svc.create({ title: 'Bye', body: 'text' });
    const removed = await svc.remove('1');
    expect(removed).toMatchObject({ key: 'OP-1', title: 'Bye' });
    expect(storage.files.size).toBe(0);
    await expect(svc.remove('OP-1')).rejects.toThrow(NotFoundError);
  });
});

describe('create', () => {
  it('stamps created/updated with the clock and starts in the first column, medium priority, task', async () => {
    const svc = service();
    const card = await svc.create({ title: 'Defaults' });
    expect(card).toMatchObject({ status: 'todo', type: 'task', priority: 'medium', labels: [], body: '' });
    expect(card.created).toBe(card.updated);
    expect(card.created).toBe(new Date(Date.UTC(2026, 9, 14, 12, 0, 0)).toISOString());
    expect(card.resolved).toBeUndefined();
  });

  it('collapses whitespace in the title and trims the assignee, dropping a blank one', async () => {
    const svc = service();
    expect((await svc.create({ title: '  Fix \n the\t login  ' })).title).toBe('Fix the login');
    expect((await svc.create({ title: 'a', assignee: '  Ana  ' })).assignee).toBe('Ana');
    expect((await svc.create({ title: 'b', assignee: '   ' })).assignee).toBeUndefined();
  });

  it('accepts a column display name, resolves the card as done when it starts in a done column', async () => {
    const svc = service();
    const card = await svc.create({ title: 'Already done', status: 'Done' });
    expect(card.status).toBe('done');
    expect(card.resolved).toBe(card.created);
    expect((await svc.create({ title: 'Doing', status: 'in progress' })).status).toBe('doing');
  });

  it('honours an explicit rank, and resolves the parent from a bare number', async () => {
    const svc = service();
    await svc.create({ title: 'Parent' });
    const card = await svc.create({ title: 'Child', parent: '1', rank: 'A' });
    expect(card.parent).toBe('OP-1');
    expect(card.rank).toBe('A');
    expect((await svc.create({ title: 'Lower', parent: 'op-1' })).parent).toBe('OP-1');
  });

  it('rejects bad input with a message that says what is valid, and writes nothing', async () => {
    const storage = new MemoryStorage();
    const svc = service(storage);
    await expect(svc.create({ title: '' })).rejects.toThrow('Title cannot be empty');
    await expect(svc.create({ title: 'x', type: 'chore' as never })).rejects.toThrow(
      'Invalid type "chore" (task, story, bug, epic)',
    );
    await expect(svc.create({ title: 'x', priority: 'urgent' as never })).rejects.toThrow('Invalid priority "urgent"');
    await expect(svc.create({ title: 'x', due: '2026-02-30' })).rejects.toThrow(
      'Invalid due date "2026-02-30" (expected YYYY-MM-DD)',
    );
    await expect(svc.create({ title: 'x', status: 'limbo' })).rejects.toThrow('Unknown status "limbo"');
    await expect(svc.create({ title: 'x', parent: 'OP-99' })).rejects.toThrow('Parent card OP-99 does not exist');
    for (const estimate of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(svc.create({ title: 'x', estimate })).rejects.toThrow(/Invalid estimate/);
    expect(storage.files.size).toBe(0);
  });

  it('accepts a zero estimate and an estimate with decimals', async () => {
    const svc = service();
    expect((await svc.create({ title: 'zero', estimate: 0 })).estimate).toBe(0);
    expect((await svc.create({ title: 'half', estimate: 0.5 })).estimate).toBe(0.5);
  });

  it('does not mutate the input object', async () => {
    const svc = service();
    const input = { title: ' keep ', labels: ['#a', 'b b'], parent: undefined as string | undefined };
    const copy = structuredClone(input);
    await svc.create(input);
    expect(input).toEqual(copy);
  });

  it('allocates keys from the `snapshot` option when given (the plugin passes its in-memory index)', async () => {
    const storage = new MemoryStorage();
    const known = {
      key: 'OP-41',
      status: 'todo',
      rank: 'V',
      created: '',
      updated: '',
      labels: [],
      comments: [],
      body: '',
      checklist: { done: 0, total: 0 },
      path: '',
      title: '',
      type: 'task',
      priority: 'medium',
    } as Card;
    const svc = service(storage, { snapshot: () => [known] });
    expect((await svc.create({ title: 'from snapshot' })).key).toBe('OP-42');
  });
});

describe('update', () => {
  it('only touches `updated` when the patch is empty', async () => {
    const svc = service();
    const before = await svc.create({ title: 'Same', body: 'text', labels: ['x'] });
    const after = await svc.update('OP-1', {});
    expect({ ...after, updated: '' }).toEqual({ ...before, updated: '' });
    expect(after.updated > before.updated).toBe(true);
  });

  it('clears optional fields with null and labels with an empty list, keeps zero estimates', async () => {
    const svc = service();
    await svc.create({ title: 'Full', assignee: 'Ana', due: '2026-10-20', estimate: 5, labels: ['a'] });
    await svc.create({ title: 'Parent for 2' });
    const cleared = await svc.update('OP-1', { assignee: null, due: null, estimate: null, parent: null, labels: [] });
    expect([cleared.assignee, cleared.due, cleared.estimate, cleared.parent, cleared.labels]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    ]);
    expect((await svc.update('OP-1', { estimate: 0 })).estimate).toBe(0);
    expect((await svc.update('OP-1', { parent: '2' })).parent).toBe('OP-2');
  });

  it('rejects a card as its own parent and a parent that does not exist, leaving the note byte-for-byte unchanged', async () => {
    const storage = new MemoryStorage();
    const svc = service(storage);
    await svc.create({ title: 'Solo' });
    const before = storage.files.get('Cards/OP-1.md');
    await expect(svc.update('OP-1', { parent: 'OP-1' })).rejects.toThrow('A card cannot be its own parent');
    await expect(svc.update('OP-1', { parent: '99' })).rejects.toThrow('Parent card OP-99 does not exist');
    await expect(svc.update('OP-1', { priority: 'urgent' as never })).rejects.toThrow(ValidationError);
    await expect(svc.update('OP-1', { due: 'tomorrow' })).rejects.toThrow('Invalid due date');
    await expect(svc.update('OP-1', { title: '  ' })).rejects.toThrow('Title cannot be empty');
    await expect(svc.update('OP-1', { status: 'limbo' })).rejects.toThrow('Unknown status');
    expect(storage.files.get('Cards/OP-1.md')).toBe(before);
  });

  it('rejects an unknown card with NotFoundError', async () => {
    await expect(service().update('OP-1', { priority: 'low' })).rejects.toThrow(NotFoundError);
  });

  it('sets `resolved` when entering a done column, clears it when leaving, and keeps it between two done columns', async () => {
    const two = normalizeConfig({
      prefix: 'OP',
      columns: [
        { id: 'todo', name: 'To do' },
        { id: 'shipped', name: 'Shipped', done: true },
        { id: 'dropped', name: 'Dropped', done: true },
      ],
    });
    const svc = new CardService(new MemoryStorage(), two, { now: clock });
    const created = await svc.create({ title: 'Flow' });
    expect(created.resolved).toBeUndefined();
    const shipped = await svc.update('OP-1', { status: 'shipped' });
    expect(shipped.resolved).toBeDefined();
    const dropped = await svc.update('OP-1', { status: 'dropped' });
    expect(dropped.resolved).toBe(shipped.resolved);
    expect((await svc.update('OP-1', { status: 'todo' })).resolved).toBeUndefined();
  });

  it('changing to the same status changes nothing about order or resolution', async () => {
    const svc = service();
    await svc.create({ title: 'a' });
    const b = await svc.create({ title: 'b' });
    const again = await svc.update('OP-2', { status: 'todo' });
    expect(again.rank).toBe(b.rank);
    expect((await svc.list()).map((c) => c.key)).toEqual(['OP-1', 'OP-2']);
  });

  it('lands at the bottom of the new column when only the status changes', async () => {
    const svc = service();
    await svc.create({ title: 'a', status: 'doing' });
    await svc.create({ title: 'b', status: 'doing' });
    await svc.create({ title: 'c' });
    await svc.update('OP-3', { status: 'In Progress' });
    expect((await svc.list()).filter((c) => c.status === 'doing').map((c) => c.key)).toEqual(['OP-1', 'OP-2', 'OP-3']);
  });

  it('an explicit rank in the patch wins over the automatic bottom placement', async () => {
    const svc = service();
    await svc.create({ title: 'a', status: 'doing', rank: 'M' });
    await svc.create({ title: 'b' });
    await svc.update('OP-2', { status: 'doing', rank: 'A' });
    expect((await svc.list()).filter((c) => c.status === 'doing').map((c) => c.key)).toEqual(['OP-2', 'OP-1']);
  });

  it('replacing the description keeps every comment, even when the description is cleared', async () => {
    const svc = service();
    await svc.create({ title: 'Talk', body: 'old' });
    await svc.addComment('OP-1', { text: 'first' });
    await svc.addComment('OP-1', { text: 'second', author: 'Bruno' });
    const replaced = await svc.update('OP-1', { body: 'new description\n\n- [x] done' });
    expect(replaced.comments.map((c) => c.text)).toEqual(['first', 'second']);
    expect(replaced.checklist).toEqual({ done: 1, total: 1 });
    const cleared = await svc.update('OP-1', { body: '' });
    expect(cleared.body.trim()).toBe('');
    expect(cleared.comments.map((c) => c.text)).toEqual(['first', 'second']);
  });

  it('normalizes labels and trims the assignee on update', async () => {
    const svc = service();
    await svc.create({ title: 'x' });
    const card = await svc.update('OP-1', { labels: ['#Api', 'api', 'two words', ' '], assignee: '  Bruno ' });
    expect(card.labels).toEqual(['Api', 'api', 'two-words']);
    expect(card.assignee).toBe('Bruno');
  });
});

describe('move', () => {
  async function board() {
    const svc = service();
    for (const title of ['a', 'b', 'c', 'd']) await svc.create({ title });
    return svc;
  }
  const order = async (svc: CardService, column = 'todo') =>
    (await svc.list()).filter((c) => c.status === column).map((c) => c.key);

  it('puts a card before or after another card of the destination column', async () => {
    const svc = await board();
    await svc.move('OP-4', 'todo', { before: 'OP-1' });
    expect(await order(svc)).toEqual(['OP-4', 'OP-1', 'OP-2', 'OP-3']);
    await svc.move('OP-4', 'todo', { after: 'OP-2' });
    expect(await order(svc)).toEqual(['OP-1', 'OP-2', 'OP-4', 'OP-3']);
    await svc.move('OP-1', 'todo');
    expect(await order(svc)).toEqual(['OP-2', 'OP-4', 'OP-3', 'OP-1']);
  });

  it('moves across columns next to an anchor there and accepts a display name', async () => {
    const svc = await board();
    await svc.move('OP-1', 'In Progress');
    await svc.move('OP-2', 'doing', { before: 'OP-1' });
    expect(await order(svc, 'doing')).toEqual(['OP-2', 'OP-1']);
    expect(await order(svc)).toEqual(['OP-3', 'OP-4']);
  });

  it('moving a card to the place it already has changes nothing in the order', async () => {
    const svc = await board();
    await svc.move('OP-2', 'todo', { after: 'OP-1' });
    await svc.move('OP-3', 'todo', { before: 'OP-4' });
    expect(await order(svc)).toEqual(['OP-1', 'OP-2', 'OP-3', 'OP-4']);
  });

  it('rejects an anchor that is not in the destination column, or the card itself, naming the problem', async () => {
    const svc = await board();
    await svc.move('OP-4', 'doing');
    await expect(svc.move('OP-1', 'todo', { before: 'OP-4' })).rejects.toThrow('Card OP-4 is not in column "todo"');
    await expect(svc.move('OP-1', 'todo', { after: 'OP-1' })).rejects.toThrow('Card OP-1 is not in column "todo"');
    await expect(svc.move('OP-1', 'limbo')).rejects.toThrow('Unknown status "limbo"');
    expect(await order(svc)).toEqual(['OP-1', 'OP-2', 'OP-3']);
  });

  it('survives hundreds of repeated moves to the top without breaking the order', async () => {
    const svc = await board();
    for (let i = 0; i < 150; i++) {
      const moving = `OP-${(i % 4) + 1}`;
      const [top, second] = await order(svc);
      await svc.move(moving, 'todo', { before: top === moving ? second! : top! });
    }
    const keys = await order(svc);
    expect(new Set(keys).size).toBe(4);
    const ranks = (await svc.list()).map((c) => c.rank);
    expect(ranks).toEqual([...ranks].sort());
    expect(new Set(ranks).size).toBe(4);
  });
});

describe('comments', () => {
  it('signs with the given author, else with the board user, and rejects when there is neither', async () => {
    const svc = service();
    await svc.create({ title: 'Talk' });
    expect((await svc.addComment('OP-1', { text: 'one', author: 'Bruno' })).comments[0]!.author).toBe('Bruno');
    expect((await svc.addComment('OP-1', { text: 'two' })).comments[1]!.author).toBe('Ana');
    expect((await svc.addComment('OP-1', { text: 'three', author: '   ' })).comments[2]!.author).toBe('Ana');
    const anonymous = new CardService(new MemoryStorage(), normalizeConfig({ ...DEFAULT_CONFIG, me: '' }), {
      now: clock,
    });
    await anonymous.create({ title: 'x' });
    await expect(anonymous.addComment('OP-1', { text: 'who?' })).rejects.toThrow('Who is commenting?');
  });

  it('cleans the author the way the note format needs, and rejects one that cleans to nothing', async () => {
    const svc = service();
    await svc.create({ title: 'Talk' });
    const card = await svc.addComment('OP-1', { text: 'x', author: 'Ana · [admin]\nSouza' });
    expect(card.comments[0]!.author).toBe('Ana admin Souza');
    await expect(svc.addComment('OP-1', { text: 'x', author: '[]' })).rejects.toThrow('Who is commenting?');
  });

  it('rejects an empty or blank comment, on add and on edit, leaving the card untouched', async () => {
    const storage = new MemoryStorage();
    const svc = service(storage);
    await svc.create({ title: 'Talk' });
    const card = await svc.addComment('OP-1', { text: 'real' });
    const before = storage.files.get('Cards/OP-1.md');
    for (const text of ['', '   ', '\n\n', '\t']) {
      await expect(svc.addComment('OP-1', { text })).rejects.toThrow('A comment cannot be empty');
      await expect(svc.editComment('OP-1', card.comments[0]!.id, text)).rejects.toThrow('A comment cannot be empty');
    }
    expect(storage.files.get('Cards/OP-1.md')).toBe(before);
  });

  it('normalizes CRLF and drops leading blank lines and trailing whitespace', async () => {
    const svc = service();
    await svc.create({ title: 'Talk' });
    const card = await svc.addComment('OP-1', { text: '\r\n\r\nline one\r\nline two  \r\n\r\n' });
    expect(card.comments[0]!.text).toBe('line one\nline two');
  });

  it('gives every comment of a card a distinct id, even when the id generator repeats itself', async () => {
    const ids = ['dup', 'dup', 'dup', 'fresh'];
    const svc = service(new MemoryStorage(), { newId: () => ids.shift() ?? 'later' });
    await svc.create({ title: 'Talk' });
    await svc.addComment('OP-1', { text: 'one' });
    const card = await svc.addComment('OP-1', { text: 'two' });
    expect(card.comments.map((c) => c.id)).toEqual(['dup', 'fresh']);
  });

  it('timestamps each comment with the clock and bumps the card `updated`', async () => {
    const svc = service();
    const created = await svc.create({ title: 'Talk' });
    const card = await svc.addComment('OP-1', { text: 'when?' });
    expect(card.comments[0]!.at > created.created).toBe(true);
    expect(card.updated >= card.comments[0]!.at).toBe(true);
  });

  it('edit and remove report an unknown comment id with NotFoundError naming the card, and change nothing', async () => {
    const storage = new MemoryStorage();
    const svc = service(storage);
    await svc.create({ title: 'Talk' });
    await svc.addComment('OP-1', { text: 'x' });
    const before = storage.files.get('Cards/OP-1.md');
    await expect(svc.editComment('OP-1', 'nope', 'y')).rejects.toThrow('Comment nope on OP-1 not found');
    await expect(svc.removeComment('OP-1', 'nope')).rejects.toThrow('Comment nope on OP-1 not found');
    await expect(svc.editComment('OP-9', 'nope', 'y')).rejects.toThrow('Card OP-9 not found');
    expect(storage.files.get('Cards/OP-1.md')).toBe(before);
  });

  it('removing the only comment brings back a note without a comments section', async () => {
    const storage = new MemoryStorage();
    const svc = service(storage);
    await svc.create({ title: 'Talk', body: 'text' });
    const withComment = await svc.addComment('OP-1', { text: 'x' });
    expect(storage.files.get('Cards/OP-1.md')).toContain('## Comments');
    const without = await svc.removeComment('OP-1', withComment.comments[0]!.id);
    expect(without.comments).toEqual([]);
    expect(storage.files.get('Cards/OP-1.md')).not.toContain('## Comments');
    expect(without.body.trim()).toBe('text');
  });

  it('searches comment text through `find`', async () => {
    const svc = service();
    await svc.create({ title: 'One' });
    await svc.create({ title: 'Two' });
    await svc.addComment('OP-2', { text: 'the needle is here' });
    expect((await svc.find({ text: 'needle' })).map((c) => c.key)).toEqual(['OP-2']);
  });

  it('persists comments through disk and a fresh service', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oprojects-cm-'));
    try {
      await mkdir(path.join(root, '.obsidian'));
      const first = service(new FsStorage(root));
      await first.create({ title: 'Disk talk' });
      await first.addComment('OP-1', { text: 'kept\n\n- [ ] item', author: 'Zoë' });
      const second = service(new FsStorage(root));
      const card = await second.get('OP-1');
      expect(card.comments).toHaveLength(1);
      expect(card.comments[0]).toMatchObject({ author: 'Zoë', text: 'kept\n\n- [ ] item' });
      expect(await readFile(path.join(root, 'Cards', 'OP-1.md'), 'utf8')).toContain('> [!comment|');
      expect((await readdir(path.join(root, 'Cards'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      await writeFile(
        path.join(root, 'Cards', 'OP-1.md'),
        (await readFile(path.join(root, 'Cards', 'OP-1.md'), 'utf8')).replace('kept', 'kept (edited by hand)'),
      );
      expect((await second.get('OP-1')).comments[0]!.text).toContain('edited by hand');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
