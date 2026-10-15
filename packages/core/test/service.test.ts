import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config';
import { UNASSIGNED, filterCards, groupByColumn, rankForPlacement, dueState, isArchivedDone } from '../src/query';
import { CardService, ValidationError } from '../src/service';
import { MemoryStorage, NotFoundError } from '../src/storage';
import { FsStorage } from '../src/node';

const config = normalizeConfig({ ...DEFAULT_CONFIG, prefix: 'OP', members: ['Ana'] });
let clock = new Date('2026-10-14T12:00:00.000Z');
const tick = () => (clock = new Date(clock.getTime() + 1000));

function setup() {
  const storage = new MemoryStorage();
  const svc = new CardService(storage, config, { now: () => clock });
  return { storage, svc };
}

beforeEach(() => {
  clock = new Date('2026-10-14T12:00:00.000Z');
});

describe('CardService.create', () => {
  it('allocates sequential keys and writes a note per card', async () => {
    const { storage, svc } = setup();
    const a = await svc.create({ title: 'First' });
    const b = await svc.create({ title: 'Second', type: 'bug', priority: 'high', labels: ['x y', 'z'], assignee: 'Ana' });
    expect([a.key, b.key]).toEqual(['OP-1', 'OP-2']);
    expect(storage.files.has('Cards/OP-1.md')).toBe(true);
    expect(b).toMatchObject({ type: 'bug', priority: 'high', labels: ['x-y', 'z'], assignee: 'Ana', status: 'todo' });
  });

  it('puts new cards at the bottom of their column', async () => {
    const { svc } = setup();
    const a = await svc.create({ title: 'a' });
    const b = await svc.create({ title: 'b' });
    const c = await svc.create({ title: 'c' });
    expect(a.rank < b.rank && b.rank < c.rank).toBe(true);
  });

  it('continues numbering after the highest existing key, even with gaps', async () => {
    const { svc } = setup();
    await svc.create({ title: 'a' });
    await svc.create({ title: 'b' });
    await svc.remove('OP-1');
    const c = await svc.create({ title: 'c' });
    expect(c.key).toBe('OP-3');
  });

  it('retries when another writer took the number first', async () => {
    const { storage } = setup();
    // The snapshot is stale: it does not know about OP-1, which already exists on disk.
    const svc = new CardService(storage, config, { now: () => clock, snapshot: () => [] });
    await storage.create('Cards/OP-1.md', '---\nkey: OP-1\ntitle: taken\n---\n');
    const card = await svc.create({ title: 'mine' });
    expect(card.key).toBe('OP-2');
  });

  it('validates input with helpful messages', async () => {
    const { svc } = setup();
    await expect(svc.create({ title: '   ' })).rejects.toThrow(ValidationError);
    await expect(svc.create({ title: 'x', status: 'nope' })).rejects.toThrow(/valid: todo, doing, review, done/);
    await expect(svc.create({ title: 'x', due: '2026-13-01' })).rejects.toThrow(/Invalid due date/);
    await expect(svc.create({ title: 'x', parent: 'OP-99' })).rejects.toThrow(/does not exist/);
  });

  it('accepts a column display name and a bare parent number', async () => {
    const { svc } = setup();
    const epic = await svc.create({ title: 'Epic', type: 'epic' });
    const c = await svc.create({ title: 'child', status: 'in progress', parent: '1' });
    expect(c.status).toBe('doing');
    expect(c.parent).toBe(epic.key);
  });
});

describe('CardService.update / move', () => {
  it('changes only the requested fields and bumps `updated`', async () => {
    const { svc } = setup();
    const a = await svc.create({ title: 'a', labels: ['k'] });
    tick();
    const b = await svc.update('OP-1', { priority: 'highest', assignee: 'Ana' });
    expect(b).toMatchObject({ title: 'a', priority: 'highest', assignee: 'Ana', labels: ['k'], rank: a.rank });
    expect(b.updated > a.updated).toBe(true);
  });

  it('clears optional fields with null', async () => {
    const { svc } = setup();
    await svc.create({ title: 'a', assignee: 'Ana', due: '2026-10-20', estimate: 2, labels: ['k'] });
    const b = await svc.update('OP-1', { assignee: null, due: null, estimate: null, labels: [] });
    expect(b.assignee).toBeUndefined();
    expect(b.due).toBeUndefined();
    expect(b.estimate).toBeUndefined();
    expect(b.labels).toEqual([]);
  });

  it('rewrites only the frontmatter and keeps the description and unknown keys', async () => {
    const { storage, svc } = setup();
    await svc.create({ title: 'a', body: 'Some **markdown**\n\n- [ ] todo' });
    await storage.modify('Cards/OP-1.md', (c) => c.replace('---\n', '---\nmy-field: hello\n'));
    await svc.update('OP-1', { title: 'renamed' });
    const raw = storage.files.get('Cards/OP-1.md')!;
    expect(raw).toContain('my-field: hello');
    expect(raw).toContain('Some **markdown**');
  });

  it('sets `resolved` when entering a done column and clears it when leaving', async () => {
    const { svc } = setup();
    await svc.create({ title: 'a' });
    tick();
    const done = await svc.move('OP-1', 'done');
    expect(done.resolved).toBe(clock.toISOString());
    const back = await svc.move('OP-1', 'doing');
    expect(back.resolved).toBeUndefined();
  });

  it('lands at the bottom when only the status changes', async () => {
    const { svc } = setup();
    await svc.create({ title: 'a' });
    await svc.create({ title: 'b', status: 'doing' });
    const a = await svc.update('OP-1', { status: 'doing' });
    const all = await svc.list();
    expect(all.filter((c) => c.status === 'doing').map((c) => c.key)).toEqual(['OP-2', 'OP-1']);
    expect(a.status).toBe('doing');
  });

  it('moves before/after a specific card and touches only the moved note', async () => {
    const { storage, svc } = setup();
    for (const t of ['a', 'b', 'c', 'd']) await svc.create({ title: t });
    const before = new Map(storage.files);
    await svc.move('OP-4', 'todo', { before: 'OP-2' });
    expect((await svc.list()).map((c) => c.key)).toEqual(['OP-1', 'OP-4', 'OP-2', 'OP-3']);
    const changed = [...storage.files].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);
    expect(changed).toEqual(['Cards/OP-4.md']);
    await svc.move('OP-1', 'todo', { after: 'OP-3' });
    expect((await svc.list()).map((c) => c.key)).toEqual(['OP-4', 'OP-2', 'OP-3', 'OP-1']);
  });

  it('works across columns and into an empty column', async () => {
    const { svc } = setup();
    await svc.create({ title: 'a' });
    await svc.create({ title: 'b' });
    await svc.move('OP-2', 'review');
    const groups = groupByColumn(await svc.list(), config);
    expect(groups.map((g) => g.cards.map((c) => c.key))).toEqual([['OP-1'], [], ['OP-2'], []]);
  });

  it('rejects unknown statuses, self-parenting and missing cards', async () => {
    const { svc } = setup();
    await svc.create({ title: 'a' });
    await expect(svc.move('OP-1', 'limbo')).rejects.toThrow(ValidationError);
    await expect(svc.update('OP-1', { parent: 'OP-1' })).rejects.toThrow(/own parent/);
    await expect(svc.update('OP-9', { title: 'x' })).rejects.toThrow(NotFoundError);
    await expect(svc.get('banana')).rejects.toThrow(/not a card key/);
  });

  it('finds a card whose note was renamed by hand', async () => {
    const { storage, svc } = setup();
    await svc.create({ title: 'a' });
    storage.files.set('Cards/sub/Renamed.md', storage.files.get('Cards/OP-1.md')!);
    storage.files.delete('Cards/OP-1.md');
    expect((await svc.get('1')).path).toBe('Cards/sub/Renamed.md');
    await svc.update('OP-1', { title: 'still works' });
    expect(storage.files.get('Cards/sub/Renamed.md')).toContain('still works');
  });
});

describe('CardService.remove', () => {
  it('deletes the note and returns the card', async () => {
    const { storage, svc } = setup();
    await svc.create({ title: 'a' });
    const gone = await svc.remove('OP-1');
    expect(gone.key).toBe('OP-1');
    expect(storage.files.size).toBe(0);
  });
});

describe('queries', () => {
  it('filters by text (accent-insensitive), status, assignee, labels', async () => {
    const { svc } = setup();
    await svc.create({ title: 'Résumé parser', labels: ['ci'], assignee: 'Ana' });
    await svc.create({ title: 'Other', status: 'doing' });
    const cards = await svc.list();
    expect(filterCards(cards, { text: 'resume parser' }, config).map((c) => c.key)).toEqual(['OP-1']);
    expect(filterCards(cards, { status: ['doing'] }, config).map((c) => c.key)).toEqual(['OP-2']);
    expect(filterCards(cards, { assignee: [UNASSIGNED] }, config).map((c) => c.key)).toEqual(['OP-2']);
    expect(filterCards(cards, { assignee: ['ana'], labels: ['CI'] }, config).map((c) => c.key)).toEqual(['OP-1']);
  });

  it('computes due state and hides old done cards', async () => {
    const { svc } = setup();
    const late = await svc.create({ title: 'late', due: '2026-10-10' });
    const soon = await svc.create({ title: 'soon', due: '2026-10-15' });
    const far = await svc.create({ title: 'far', due: '2026-12-01' });
    const now = new Date(2026, 9, 14, 12);
    expect([late, soon, far].map((c) => dueState(c, config, now))).toEqual(['overdue', 'soon', 'later']);
    const done = await svc.move('OP-1', 'done');
    expect(dueState(done, config, now)).toBe('later');
    expect(isArchivedDone(done, config, new Date('2026-10-20T00:00:00Z'))).toBe(false);
    expect(isArchivedDone(done, config, new Date('2026-12-01T00:00:00Z'))).toBe(true);
  });

  it('survives duplicate/equal ranks when computing a placement', async () => {
    const { svc } = setup();
    await svc.create({ title: 'a', rank: 'V' });
    await svc.create({ title: 'b', rank: 'V' });
    await svc.create({ title: 'c', rank: 'V' });
    const cards = await svc.list();
    expect(() => rankForPlacement(cards, config, 'OP-3', 'todo', { before: 'OP-2' })).not.toThrow();
  });
});

describe('FsStorage (real disk)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oprojects-'));
    await mkdir(path.join(root, '.obsidian'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('round-trips cards, ignores non-card notes and hidden files, trashes on remove', async () => {
    const storage = new FsStorage(root);
    const svc = new CardService(storage, config);
    await writeFile(path.join(root, 'Readme.md'), '# not in the cards folder');
    await svc.create({ title: 'one', body: 'hello' });
    await svc.create({ title: 'two' });
    await mkdir(path.join(root, 'Cards'), { recursive: true });
    await writeFile(path.join(root, 'Cards', 'scratch.md'), '# plain note without a key');
    await writeFile(path.join(root, 'Cards', '.hidden.md'), '---\nkey: OP-50\n---\n');

    expect((await svc.list()).map((c) => c.key)).toEqual(['OP-1', 'OP-2']);
    await svc.update('OP-1', { status: 'review', priority: 'low' });
    expect(await readFile(path.join(root, 'Cards', 'OP-1.md'), 'utf8')).toContain('hello');
    expect((await readdir(path.join(root, 'Cards'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    await svc.remove('OP-2');
    expect((await svc.list()).map((c) => c.key)).toEqual(['OP-1']);
    expect(await readdir(path.join(root, '.trash'))).toEqual(['OP-2.md']);
  });

  it('listMarkdown is empty (not an error) when the folder does not exist yet', async () => {
    expect(await new FsStorage(root).listMarkdown('Nope')).toEqual([]);
  });

  it('refuses paths that escape the vault', async () => {
    await expect(new FsStorage(root).read('../etc/passwd')).rejects.toThrow(/escapes/);
  });

  it('two writers racing for the same number never overwrite each other', async () => {
    const a = new CardService(new FsStorage(root), config, { snapshot: () => [] });
    const b = new CardService(new FsStorage(root), config, { snapshot: () => [] });
    const made = await Promise.all([a.create({ title: 'from a' }), b.create({ title: 'from b' }), a.create({ title: 'from a2' })]);
    expect(new Set(made.map((c) => c.key)).size).toBe(3);
    expect((await new CardService(new FsStorage(root), config).list()).length).toBe(3);
  });
});

describe('CardService.find', () => {
  const withMe = normalizeConfig({ ...DEFAULT_CONFIG, me: 'Ana' });
  async function seeded() {
    const storage = new MemoryStorage();
    const svc = new CardService(storage, withMe, { now: () => clock });
    await svc.create({ title: 'mine', assignee: 'Ana', labels: ['x'] });
    await svc.create({ title: 'theirs', assignee: 'Bia', status: 'doing' });
    await svc.create({ title: 'nobody', priority: 'high' });
    return { svc, storage };
  }

  it('resolves me, none and column names', async () => {
    const { svc } = await seeded();
    expect((await svc.find({ assignee: ['me'] })).map((c) => c.title)).toEqual(['mine']);
    expect((await svc.find({ assignee: ['none'] })).map((c) => c.title)).toEqual(['nobody']);
    expect((await svc.find({ status: ['In Progress'] })).map((c) => c.title)).toEqual(['theirs']);
    expect((await svc.find({ priority: ['high'] })).map((c) => c.title)).toEqual(['nobody']);
    expect((await svc.find()).length).toBe(3);
  });

  it('explains what to configure when "me" is unknown', async () => {
    const { svc } = setup();
    await expect(svc.find({ assignee: ['me'] })).rejects.toThrow(/not configured/);
  });

  it('rejects unknown statuses/types/priorities instead of silently matching nothing', async () => {
    const { svc } = await seeded();
    await expect(svc.find({ status: ['limbo'] })).rejects.toThrow(/Unknown status/);
    await expect(svc.find({ type: ['wizard' as never] })).rejects.toThrow(/Invalid type/);
    await expect(svc.find({ priority: ['urgent' as never] })).rejects.toThrow(/Invalid priority/);
  });

  it('hides old done cards unless includeArchived', async () => {
    const { svc, storage } = await seeded();
    await svc.move('OP-1', 'done');
    const later = new CardService(storage, withMe, { now: () => new Date(clock.getTime() + 40 * 86_400_000) });
    expect((await later.find()).map((c) => c.key)).not.toContain('OP-1');
    expect((await later.find({ includeArchived: true })).map((c) => c.key)).toContain('OP-1');
  });
});

describe('comments', () => {
  const meConfig = normalizeConfig({ ...DEFAULT_CONFIG, me: 'Ana' });
  let n = 0;
  const make = () => {
    n = 0;
    const storage = new MemoryStorage();
    const svc = new CardService(storage, meConfig, { now: () => clock, newId: () => `c${++n}` });
    return { storage, svc };
  };

  it('adds comments in order, signed with the board user by default', async () => {
    const { svc } = make();
    await svc.create({ title: 'a', body: 'Description' });
    await svc.addComment('OP-1', { text: 'first' });
    tick();
    const card = await svc.addComment('OP-1', { text: 'second\n\n- item', author: 'Bruno' });
    expect(card.comments.map((x) => [x.id, x.author, x.text])).toEqual([['c1', 'Ana', 'first'], ['c2', 'Bruno', 'second\n\n- item']]);
    expect(card.comments[1]!.at).toBe(clock.toISOString());
    expect(card.body.trim()).toBe('Description');
  });

  it('refuses an unsigned or empty comment', async () => {
    const { svc } = setup(); // config without "me"
    await svc.create({ title: 'a' });
    await expect(svc.addComment('OP-1', { text: 'oi' })).rejects.toThrow(/Who is commenting/);
    const { svc: withMe } = make();
    await withMe.create({ title: 'a' });
    await expect(withMe.addComment('OP-1', { text: '  \n ' })).rejects.toThrow(/cannot be empty/);
    await expect(withMe.addComment('OP-9', { text: 'oi' })).rejects.toThrow(NotFoundError);
  });

  it('changes nothing but `updated` in the frontmatter, and the description is untouched', async () => {
    const { storage, svc } = make();
    await svc.create({ title: 'a', body: 'Description\n\n- [ ] x', labels: ['k'] });
    await storage.modify('Cards/OP-1.md', (t) => t.replace('---\n', '---\nmy-field: stays\n'));
    const before = storage.files.get('Cards/OP-1.md')!;
    tick();
    await svc.addComment('OP-1', { text: 'oi' });
    const after = storage.files.get('Cards/OP-1.md')!;
    const changed = before.split('\n').filter((l, i) => l !== after.split('\n')[i]);
    expect(changed.some((l) => l.startsWith('updated:'))).toBe(true);
    expect(after).toContain('my-field: stays');
    expect(after).toContain('Description\n\n- [ ] x');
  });

  it('editing the description keeps the comments (and the checklist ignores them)', async () => {
    const { svc } = make();
    await svc.create({ title: 'a', body: 'antiga' });
    await svc.addComment('OP-1', { text: 'task to do\n\n- [ ] comment item' });
    const card = await svc.update('OP-1', { body: '\nnew description\n\n- [x] done\n' });
    expect(card.comments.map((x) => x.text)).toEqual(['task to do\n\n- [ ] comment item']);
    expect(card.body.trim()).toBe('new description\n\n- [x] done');
    expect(card.checklist).toEqual({ done: 1, total: 1 });
    expect((await svc.get('OP-1')).comments).toHaveLength(1);
  });

  it('clearing the description keeps the comments too', async () => {
    const { svc } = make();
    await svc.create({ title: 'a', body: 'x' });
    await svc.addComment('OP-1', { text: 'fica' });
    const card = await svc.update('OP-1', { body: '' });
    expect(card.body.trim()).toBe('');
    expect(card.comments).toHaveLength(1);
  });

  it('edits and removes by id; unknown ids are NotFound', async () => {
    const { svc } = make();
    await svc.create({ title: 'a' });
    await svc.addComment('OP-1', { text: 'um' });
    await svc.addComment('OP-1', { text: 'dois' });
    expect((await svc.editComment('OP-1', 'c2', 'two edited')).comments.map((x) => x.text)).toEqual(['um', 'two edited']);
    expect((await svc.removeComment('OP-1', 'c1')).comments.map((x) => x.id)).toEqual(['c2']);
    await expect(svc.editComment('OP-1', 'nope', 'x')).rejects.toThrow(/Comment nope on OP-1 not found/);
    await expect(svc.removeComment('OP-1', 'nope')).rejects.toThrow(NotFoundError);
    const last = await svc.removeComment('OP-1', 'c2');
    expect(last.comments).toEqual([]);
  });

  it('comments are searchable', async () => {
    const { svc } = make();
    await svc.create({ title: 'a' });
    await svc.create({ title: 'b' });
    await svc.addComment('OP-2', { text: 'Reproduced in the Café app' });
    expect((await svc.find({ text: 'cafe' })).map((c) => c.key)).toEqual(['OP-2']);
  });

  it('a comment id is never reused within a card', async () => {
    const storage = new MemoryStorage();
    const ids = ['x', 'x', 'y'];
    const svc = new CardService(storage, meConfig, { now: () => clock, newId: () => ids.shift() ?? 'z' });
    await svc.create({ title: 'a' });
    await svc.addComment('OP-1', { text: 'um' });
    const card = await svc.addComment('OP-1', { text: 'dois' });
    expect(card.comments.map((c) => c.id)).toEqual(['x', 'y']);
  });
});
