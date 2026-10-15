import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { normalizeLabels } from '../src/card';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config';
import { FsStorage } from '../src/node';
import { isValidRank } from '../src/rank';
import { CardService, ValidationError } from '../src/service';
import { MemoryStorage, NotFoundError, type Storage } from '../src/storage';
import type { CardType, Priority } from '../src/types';

// Property tests run many cases; a loaded machine (CI, parallel test runs) must not trip the default 5 s limit.
vi.setConfig({ testTimeout: 30_000 });

type ValueOf<A> = A extends fc.Arbitrary<infer T> ? T : never;

const config = normalizeConfig({ ...DEFAULT_CONFIG, prefix: 'OP', me: 'Ana' });
const COLUMNS = ['todo', 'doing', 'review', 'done'];
const DONE = 'done';

// --- the model: a few plain arrays and maps --------------------------------------------------------------

interface MComment {
  id: string;
  author: string;
  text: string;
}

interface MCard {
  key: string;
  title: string;
  status: string;
  type: CardType;
  priority: Priority;
  assignee?: string;
  labels: string[];
  due?: string;
  estimate?: number;
  parent?: string;
  body: string;
  comments: MComment[];
}

class Model {
  readonly cards = new Map<string, MCard>();
  /** Ordered keys per column: the order the board must show. */
  readonly columns: Record<string, string[]> = Object.fromEntries(COLUMNS.map((c) => [c, [] as string[]]));

  keys(): string[] {
    return [...this.cards.keys()];
  }

  nextKey(): string {
    const max = Math.max(0, ...this.keys().map((k) => Number(k.split('-')[1])));
    return `OP-${max + 1}`;
  }

  detach(key: string): void {
    for (const list of Object.values(this.columns)) {
      const at = list.indexOf(key);
      if (at >= 0) list.splice(at, 1);
    }
  }

  /** Put `key` in `column` at the requested spot among the other cards of that column. */
  place(key: string, column: string, where: 'bottom' | 'before' | 'after', ref: number): void {
    this.detach(key);
    const list = this.columns[column]!;
    if (list.length === 0 || where === 'bottom') list.push(key);
    else {
      const anchor = ref % list.length;
      list.splice(where === 'before' ? anchor : anchor + 1, 0, key);
    }
    this.cards.get(key)!.status = column;
  }
}

// --- operations --------------------------------------------------------------------------------------

const TITLES = ['  Fix  login ', 'Zoë', 'a: b', '# hash', 'Straße', 'plain', '日本語'];
const COMMENT_TEXTS = [
  'hello',
  'two\nlines',
  '- [ ] a\n- [x] b',
  'a > b',
  '[!comment|x] injected',
  '## Comments',
  '> quoted\n> [!comment|y] nested',
  '```\ncode\n```',
];
const BODIES = ['', 'Some description', '- [ ] one\n- [x] two', '## Heading\n\ntext', 'line1\nline2'];
const DATES = ['2026-10-14', '2027-01-01', '2024-02-29'];

const patchArb = fc.record(
  {
    title: fc.constantFrom(...TITLES),
    priority: fc.constantFrom<Priority>('highest', 'high', 'medium', 'low', 'lowest'),
    type: fc.constantFrom<CardType>('task', 'story', 'bug', 'epic'),
    assignee: fc.option(fc.constantFrom('Ana', 'Bruno', '  Zoë  '), { nil: null }),
    labels: fc.array(fc.constantFrom('api', 'ux', '#Café', 'two words', 'api'), { maxLength: 3 }),
    due: fc.option(fc.constantFrom(...DATES), { nil: null }),
    estimate: fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }),
    body: fc.constantFrom(...BODIES),
    col: fc.integer({ min: 0, max: 3 }),
    parent: fc.option(fc.nat(), { nil: null }),
  },
  { requiredKeys: [] },
);

type Op =
  | {
      t: 'create';
      title: string;
      col?: number;
      body?: string;
      labels?: string[];
      priority?: Priority;
      assignee?: string;
      parent?: number;
    }
  | { t: 'update'; pick: number; patch: ValueOf<typeof patchArb> }
  | { t: 'move'; pick: number; col: number; where: 'bottom' | 'before' | 'after'; ref: number }
  | { t: 'remove'; pick: number }
  | { t: 'comment'; pick: number; text: string; author?: string }
  | { t: 'editComment'; pick: number; which: number; text: string }
  | { t: 'removeComment'; pick: number; which: number }
  | { t: 'invalid'; kind: number; pick: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant('create' as const),
      title: fc.constantFrom(...TITLES),
      col: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
      body: fc.option(fc.constantFrom(...BODIES), { nil: undefined }),
      labels: fc.option(fc.array(fc.constantFrom('api', 'ux', 'Café'), { maxLength: 2 }), { nil: undefined }),
      priority: fc.option(fc.constantFrom<Priority>('highest', 'low'), { nil: undefined }),
      assignee: fc.option(fc.constantFrom('Ana', 'Bruno'), { nil: undefined }),
      parent: fc.option(fc.nat(), { nil: undefined }),
    }),
  },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('update' as const), pick: fc.nat(), patch: patchArb }) },
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant('move' as const),
      pick: fc.nat(),
      col: fc.integer({ min: 0, max: 3 }),
      where: fc.constantFrom('bottom' as const, 'before' as const, 'after' as const),
      ref: fc.nat(),
    }),
  },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('remove' as const), pick: fc.nat() }) },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('comment' as const),
      pick: fc.nat(),
      text: fc.constantFrom(...COMMENT_TEXTS),
      author: fc.option(fc.constantFrom('Bruno', 'Zoë'), { nil: undefined }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('editComment' as const),
      pick: fc.nat(),
      which: fc.nat(),
      text: fc.constantFrom(...COMMENT_TEXTS),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('removeComment' as const), pick: fc.nat(), which: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('invalid' as const), kind: fc.nat(), pick: fc.nat() }) },
);

/** How many operations of each kind really ran (not skipped for lack of a card): guards against a vacuous run. */
const stats: Record<Op['t'], number> = {
  create: 0,
  update: 0,
  move: 0,
  remove: 0,
  comment: 0,
  editComment: 0,
  removeComment: 0,
  invalid: 0,
};

const collapse = (title: string) => title.replace(/\s+/g, ' ').trim();

/** Applies one operation to the service and (when it must succeed) to the model; asserts failures leave no trace. */
async function applyOp(op: Op, svc: CardService, model: Model, ids: { next: number }): Promise<void> {
  const keys = model.keys();
  const pickKey = (n: number) => (keys.length ? keys[n % keys.length]! : undefined);

  switch (op.t) {
    case 'create': {
      const parentKey = op.parent === undefined ? undefined : pickKey(op.parent);
      const column = COLUMNS[op.col ?? 0]!;
      const key = model.nextKey();
      const card = await svc.create({
        title: op.title,
        status: op.col === undefined ? undefined : column,
        body: op.body,
        labels: op.labels,
        priority: op.priority,
        assignee: op.assignee,
        parent: parentKey,
      });
      expect(card.key).toBe(key);
      stats.create++;
      model.cards.set(key, {
        key,
        title: collapse(op.title),
        status: column,
        type: 'task',
        priority: op.priority ?? 'medium',
        assignee: op.assignee,
        labels: normalizeLabels(op.labels ?? []),
        parent: parentKey,
        body: op.body ?? '',
        comments: [],
      });
      model.columns[column]!.push(key);
      return;
    }
    case 'update': {
      const key = pickKey(op.pick);
      if (!key) return;
      const m = model.cards.get(key)!;
      const p = op.patch;
      const parentKey = p.parent === undefined ? undefined : p.parent === null ? null : pickKey(p.parent);
      if (parentKey === key) return; // a card cannot be its own parent: covered by the invalid operations
      const saved = await svc.update(key, {
        title: p.title,
        priority: p.priority,
        type: p.type,
        assignee: p.assignee,
        labels: p.labels,
        due: p.due,
        estimate: p.estimate,
        body: p.body,
        status: p.col === undefined ? undefined : COLUMNS[p.col],
        parent: parentKey,
      });
      if (p.title !== undefined) m.title = collapse(p.title);
      if (p.priority) m.priority = p.priority;
      if (p.type) m.type = p.type;
      if (p.assignee !== undefined) m.assignee = p.assignee?.trim() || undefined;
      if (p.labels) m.labels = normalizeLabels(p.labels);
      if (p.due !== undefined) m.due = p.due ?? undefined;
      if (p.estimate !== undefined) m.estimate = p.estimate ?? undefined;
      if (p.body !== undefined) m.body = p.body;
      if (parentKey !== undefined) m.parent = parentKey ?? undefined;
      // Changing column without saying where lands at the bottom of the new column.
      const target = p.col === undefined ? undefined : COLUMNS[p.col]!;
      if (target !== undefined && target !== m.status) model.place(key, target, 'bottom', 0);
      expect(saved.key).toBe(key);
      stats.update++;
      return;
    }
    case 'move': {
      const key = pickKey(op.pick);
      if (!key) return;
      const column = COLUMNS[op.col]!;
      const others = model.columns[column]!.filter((k) => k !== key);
      const anchor = others.length ? others[op.ref % others.length]! : undefined;
      const where = anchor === undefined ? 'bottom' : op.where;
      await svc.move(
        key,
        column,
        where === 'bottom' ? {} : where === 'before' ? { before: anchor } : { after: anchor },
      );
      model.place(key, column, where, op.ref);
      stats.move++;
      return;
    }
    case 'remove': {
      const key = pickKey(op.pick);
      if (!key) return;
      const removed = await svc.remove(key);
      expect(removed.key).toBe(key);
      model.detach(key);
      model.cards.delete(key);
      stats.remove++;
      return;
    }
    case 'comment': {
      const key = pickKey(op.pick);
      if (!key) return;
      const id = `c${ids.next}`;
      const card = await svc.addComment(key, { text: op.text, author: op.author });
      expect(card.comments.at(-1)!.id).toBe(id);
      model.cards.get(key)!.comments.push({ id, author: op.author ?? 'Ana', text: op.text });
      stats.comment++;
      return;
    }
    case 'editComment': {
      const key = pickKey(op.pick);
      const m = key ? model.cards.get(key) : undefined;
      if (!key || !m || m.comments.length === 0) return;
      const target = m.comments[op.which % m.comments.length]!;
      await svc.editComment(key, target.id, op.text);
      target.text = op.text;
      stats.editComment++;
      return;
    }
    case 'removeComment': {
      const key = pickKey(op.pick);
      const m = key ? model.cards.get(key) : undefined;
      if (!key || !m || m.comments.length === 0) return;
      const at = op.which % m.comments.length;
      await svc.removeComment(key, m.comments[at]!.id);
      m.comments.splice(at, 1);
      stats.removeComment++;
      return;
    }
    case 'invalid': {
      const key = pickKey(op.pick) ?? 'OP-1';
      const attempts: (() => Promise<unknown>)[] = [
        () => svc.update(key, { priority: 'urgent' as Priority }),
        () => svc.update(key, { type: 'chore' as CardType }),
        () => svc.update(key, { due: '2026-02-30' }),
        () => svc.update(key, { estimate: -1 }),
        () => svc.update(key, { title: '   ' }),
        () => svc.update(key, { status: 'ghost' }),
        () => svc.update(key, { parent: key }),
        () => svc.update(key, { parent: 'OP-99999' }),
        () => svc.move(key, 'ghost'),
        () => svc.create({ title: '' }),
        () => svc.create({ title: 'x', status: 'ghost' }),
        () => svc.create({ title: 'x', parent: 'OP-99999' }),
        () => svc.addComment(key, { text: '   ' }),
        () => svc.addComment(key, { text: 'x', author: '[]' }),
        () => svc.get('not a key'),
      ];
      const failure = await attempts[op.kind % attempts.length]!().then(
        () => null,
        (e: unknown) => e,
      );
      // Always a clean domain error (never a crash), and the board must be exactly as before (checked by the caller).
      expect(failure instanceof ValidationError || failure instanceof NotFoundError).toBe(true);
      stats.invalid++;
    }
  }
}

/** The service's idea of the board must equal the model's after every operation. */
async function expectBoardMatches(svc: CardService, model: Model): Promise<void> {
  const cards = await svc.list();
  expect(cards.map((c) => c.key).sort()).toEqual(model.keys().sort());

  for (const column of COLUMNS) {
    const inColumn = cards.filter((c) => c.status === column);
    expect(inColumn.map((c) => c.key)).toEqual(model.columns[column]);
    for (const c of inColumn) expect(isValidRank(c.rank)).toBe(true);
    for (let i = 1; i < inColumn.length; i++) expect(inColumn[i - 1]!.rank < inColumn[i]!.rank).toBe(true);
  }

  for (const card of cards) {
    const m = model.cards.get(card.key)!;
    expect({
      title: card.title,
      type: card.type,
      priority: card.priority,
      assignee: card.assignee,
      labels: card.labels,
      due: card.due,
      estimate: card.estimate,
      parent: card.parent,
      body: card.body.trim(),
    }).toEqual({
      title: m.title,
      type: m.type,
      priority: m.priority,
      assignee: m.assignee,
      labels: m.labels,
      due: m.due,
      estimate: m.estimate,
      parent: m.parent,
      body: m.body.trim(),
    });
    expect(card.comments.map((c) => [c.id, c.author])).toEqual(m.comments.map((c) => [c.id, c.author]));
    expect(card.comments.map((c) => c.text)).toEqual(m.comments.map((c) => c.text));
    // `resolved` exists exactly while the card sits in the done column.
    expect(card.resolved !== undefined).toBe(card.status === DONE);
    expect(card.updated >= card.created).toBe(true);
  }
}

async function runSequence(ops: Op[], storage: Storage): Promise<void> {
  let tick = 0;
  const ids = { next: 1 };
  const svc = new CardService(storage, config, {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    newId: () => `c${ids.next++}`,
  });
  const model = new Model();
  for (const op of ops) {
    // A comment consumes one id when it succeeds; an operation that fails must not.
    await applyOp(op, svc, model, ids);
    await expectBoardMatches(svc, model);
  }
}

describe('CardService against a model (random sequences of operations)', () => {
  it('on in-memory storage: order, ranks, fields, comments and resolved always match the model', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 5, maxLength: 40, size: 'max' }), async (ops) => {
        await runSequence(ops, new MemoryStorage());
      }),
      { numRuns: 60 },
    );
    // Every kind of operation must really have run, or the property proves nothing.
    for (const kind of Object.keys(stats) as Op['t'][]) expect(stats[kind], kind).toBeGreaterThan(0);
    expect(Object.values(stats).reduce((a, b) => a + b, 0)).toBeGreaterThan(300);
  }, 60_000);

  it('on a real folder: the same sequences behave identically through FsStorage', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 5, maxLength: 25, size: 'max' }), async (ops) => {
        const root = await mkdtemp(path.join(tmpdir(), 'oprojects-model-'));
        try {
          await mkdir(path.join(root, '.obsidian'));
          await runSequence(ops, new FsStorage(root));
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 12 },
    );
    expect(stats.create + stats.move + stats.comment).toBeGreaterThan(60);
  }, 60_000);
});
