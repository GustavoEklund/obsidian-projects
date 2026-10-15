// Conformance corpus for packages/core/src/service.ts: the Rust port (packages/mcp/src/service.rs) replays every scenario.
// A scenario is a board, some notes already in the vault, and a list of steps (create, update, move, comments, find...).
// Nothing here is hand-computed: the generator runs the TypeScript `CardService` on a `MemoryStorage`, with a fixed clock
// and comment ids, and records for each step what it returned (or the message and kind of what it threw) and, at the end,
// what the notes look like. The Rust service has to do the same on the same notes.
//
// Rules the generator follows so both sides can be compared:
// - A step has at most one defect (one invalid field). TypeScript checks fields in a fixed order and Rust receives them
//   already parsed, so two defects at once would only test who complains first.
// - Notes are compared byte for byte only in scenarios whose text is "ordinary" (plain words, where both YAML writers
//   agree); in the others they are compared as the cards they parse to.
import {
  CardService,
  DEFAULT_CONFIG,
  FileExistsError,
  MemoryStorage,
  NotFoundError,
  ValidationError,
  normalizeConfig,
  parseCard,
  type BoardConfig,
  type Card,
} from '@oprojects/core';
import { chance, int, pick, rng, text, type Case, type FixtureFile, type Random } from './lib';

// Comment titles show local time: the corpus is produced in UTC and Rust is given an offset of 0.
process.env.TZ = 'UTC';

export const name = 'service';

type Json = Record<string, unknown>;

export interface Step {
  /** The clock (milliseconds since the epoch) while this step runs. */
  at: number;
  op: string;
  args: Json;
}

export interface Scenario {
  config: Json;
  /** Notes in the vault before the first step. */
  files: Record<string, string>;
  /** The comment ids the service gets, in order (`z<n>` after that). */
  ids: string[];
  steps: Step[];
}

type Outcome = { ok: true; value: unknown } | { ok: false; kind: string; error: string };

const BASE = Date.parse('2026-10-15T12:00:00.000Z');
const MINUTE = 60_000;
const DAY = 86_400_000;

// --- running a scenario on the reference implementation -------------------------------------------------------------

function kindOf(e: unknown): string {
  if (e instanceof ValidationError) return 'validation';
  if (e instanceof NotFoundError) return 'not_found';
  if (e instanceof FileExistsError) return 'file_exists';
  return 'other';
}

async function attemptAsync(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, kind: kindOf(e), error: e instanceof Error ? e.message : String(e) };
  }
}

const keysOf = (cards: Card[]) => cards.map((c) => c.key);

export async function execute(service: CardService, step: Step, setClock: (ms: number) => void): Promise<Outcome> {
  setClock(step.at);
  const a = step.args as Record<string, any>;
  switch (step.op) {
    case 'create':
      return attemptAsync(() => service.create(a.input));
    case 'update':
      return attemptAsync(() => service.update(a.key, a.patch));
    case 'move':
      return attemptAsync(() => service.move(a.key, a.column, a.placement));
    case 'remove':
      return attemptAsync(() => service.remove(a.key));
    case 'get':
      return attemptAsync(() => service.get(a.key));
    case 'find':
      return attemptAsync(async () => keysOf(await service.find(a.query)));
    case 'list':
      return attemptAsync(async () => keysOf(await service.list()));
    case 'addComment':
      return attemptAsync(() => service.addComment(a.key, a.comment));
    case 'editComment':
      return attemptAsync(() => service.editComment(a.key, a.id, a.text));
    case 'removeComment':
      return attemptAsync(() => service.removeComment(a.key, a.id));
    case 'resolveKey':
      return attemptAsync(async () => service.resolveKey(a.input));
    case 'checkStatus':
      return attemptAsync(async () => service.checkStatus(a.input));
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

export function newService(scenario: Scenario, storage: MemoryStorage) {
  let clock = BASE;
  let nextId = 0;
  const config: BoardConfig = normalizeConfig(scenario.config);
  const service = new CardService(storage, config, {
    now: () => new Date(clock),
    newId: () => scenario.ids[nextId++] ?? `z${nextId}`,
  });
  return { service, setClock: (ms: number) => (clock = ms) };
}

async function run(scenario: Scenario, exactText: boolean): Promise<Case['expected']> {
  const storage = new MemoryStorage();
  for (const [path, content] of Object.entries(scenario.files)) storage.files.set(path, content);
  const { service, setClock } = newService(scenario, storage);
  const outcomes: Outcome[] = [];
  for (const step of scenario.steps) outcomes.push(await execute(service, step, setClock));
  const files = [...storage.files.keys()].sort().map((path) => {
    const content = storage.files.get(path)!;
    const note: { path: string; text?: string; card: Card | null } = { path, card: parseCard(path, content) ?? null };
    if (exactText) note.text = content;
    return note;
  });
  return { exactText, outcomes, files };
}

// --- ordinary and tricky values -------------------------------------------------------------------------------------

const WORDS = [
  'fix',
  'login',
  'redirect',
  'api',
  'docs',
  'parser',
  'cache',
  'search',
  'export',
  'billing',
  'mobile',
  'retry',
];
const NAMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Zoë', 'Étienne'];
const LABELS = ['api', 'ux', 'backend', 'docs', 'a b', '#tag', '##hash', '  spaced  ', 'Zoë', 'x', 'y z', 'backend'];

const ordinaryTitle = (r: Random) => Array.from({ length: int(r, 1, 4) }, () => pick(r, WORDS)).join(' ');
const trickyTitle = (r: Random) => `${text(r, 4)} ${pick(r, WORDS)} ${text(r, 3)}`;

interface Flavor {
  exact: boolean;
  title: (r: Random) => string;
  body: (r: Random) => string;
  comment: (r: Random) => string;
}

const BODIES = [
  '',
  'Plain description.',
  'Steps:\n\n- [x] Reproduce\n- [ ] Fix it\n- [ ] Add a test\n',
  'Line one\nLine two\n\n```\n- [ ] not a task\n```\n',
  '  Indented first line',
  'Ends with spaces   ',
];

const ORDINARY: Flavor = {
  exact: true,
  title: ordinaryTitle,
  body: (r) => pick(r, BODIES),
  comment: (r) => `${ordinaryTitle(r)} ${pick(r, ['soon', 'later', 'again'])}`,
};

const TRICKY: Flavor = {
  exact: false,
  title: trickyTitle,
  body: (r) => `${pick(r, BODIES)}${chance(r, 0.5) ? text(r, 4) : ''}`,
  comment: (r) => `${text(r, 5)}\n${chance(r, 0.3) ? '> [!comment|fake] not another comment' : text(r, 3)}`,
};

// --- hand-written scenarios, after packages/core/test/service*.test.ts ------------------------------------------------

let order = 0;
const at = (n: number) => BASE + n * MINUTE;
const step = (op: string, args: Json = {}): Step => ({ at: at(order++), op, args });
const create = (input: Json) => step('create', { input });
const update = (key: string, patch: Json) => step('update', { key, patch });
const get = (key: string) => step('get', { key });
const find = (query: Json = {}) => step('find', { query });
const move = (key: string, column: string, placement: Json = {}) => step('move', { key, column, placement });
const addComment = (key: string, comment: Json) => step('addComment', { key, comment });
const jump = (s: Step, ms: number): Step => ({ ...s, at: s.at + ms });

const CUSTOM_CONFIG = {
  folder: 'Work/Board',
  prefix: 'WEB',
  me: 'Zoë',
  members: ['Zoë', 'Bruno'],
  hideDoneAfterDays: 3,
  columns: [
    { id: 'backlog', name: 'Backlog' },
    { id: 'wip', name: 'In Progress', wip: 3 },
    { id: 'shipped', name: 'Shipped', done: true },
  ],
};

const DEFAULT = { ...DEFAULT_CONFIG, me: 'Ana', members: ['Ana', 'Bruno'] } as unknown as Json;

const NOTE = (key: string, extra = '', body = '') =>
  `---\nkey: ${key}\ntitle: ${key} by hand\nstatus: todo\nrank: V\ncreated: 2026-10-01T10:00:00.000Z\nupdated: 2026-10-01T10:00:00.000Z\n${extra}---\n${body}`;

function handWritten(): { id: string; scenario: Scenario; exact: boolean }[] {
  const out: { id: string; scenario: Scenario; exact: boolean }[] = [];
  const add = (id: string, scenario: Partial<Scenario> & { steps: Step[] }, exact = true) => {
    out.push({ id, scenario: { config: DEFAULT, files: {}, ids: [], ...scenario }, exact });
    order = 0;
  };
  order = 0;

  add('create:keys-and-defaults', {
    steps: [
      create({ title: 'First' }),
      create({ title: 'Second', type: 'bug', priority: 'high', labels: ['x y', 'z', '#tag', 'z'], assignee: ' Ana ' }),
      create({ title: '  Collapses   the\t\nwhitespace  ' }),
      create({ title: 'Done already', status: 'done' }),
      create({ title: 'Named column', status: 'In Progress' }),
      create({ title: 'Explicit rank', rank: 'Zz' }),
      create({
        title: 'Everything',
        due: '2026-12-31',
        estimate: 5,
        body: 'Text\n\n- [ ] one\n- [x] two',
        parent: 'op-1',
      }),
      create({ title: 'Parent by number', parent: '2' }),
      get('OP-7'),
      find({}),
    ],
  });

  add('create:validation', {
    steps: [
      create({ title: '' }),
      create({ title: '   \n  ' }),
      create({ title: 'x', status: 'nope' }),
      create({ title: 'x', due: '2026-02-30' }),
      create({ title: 'x', due: 'tomorrow' }),
      create({ title: 'x', estimate: -1 }),
      create({ title: 'x', estimate: 1e21 }),
      create({ title: 'x', estimate: 0.1 }),
      create({ title: 'x', parent: 'OP-9' }),
      create({ title: 'x', parent: 'not a key' }),
      create({ title: 'x', parent: '' }),
      create({ title: 'x', assignee: '   ' }),
      create({ title: 'x', labels: [] }),
      find({}),
    ],
  });

  add('create:custom-board', {
    config: CUSTOM_CONFIG,
    steps: [
      create({ title: 'In the backlog' }),
      create({ title: 'Shipped one', status: 'Shipped' }),
      create({ title: 'Wip', status: 'wip', assignee: 'Zoë' }),
      step('resolveKey', { input: '12' }),
      step('resolveKey', { input: 'web-12' }),
      step('resolveKey', { input: 'OP-12' }),
      step('checkStatus', { input: 'IN PROGRESS' }),
      step('checkStatus', { input: ' shipped ' }),
      step('checkStatus', { input: 'todo' }),
      find({ assignee: ['me'] }),
      find({ status: ['In Progress', 'backlog'] }),
    ],
  });

  add('keys:reuse-and-gaps', {
    files: { 'Cards/OP-7.md': NOTE('OP-7'), 'Cards/OP-3.md': NOTE('OP-3'), 'Cards/XY-99.md': NOTE('XY-99') },
    steps: [
      create({ title: 'After the highest' }),
      step('remove', { key: 'OP-8' }),
      create({ title: 'Takes the freed number' }),
      get('8'),
      get('op-8'),
      get(' OP-8 '),
      get('OP-08'),
      get('0'),
      get('99999999999999999999'),
      get('OP-'),
      get('abc'),
      get(''),
      get('XY-99'),
      step('list'),
    ],
  });

  add('get:renamed-and-odd-notes', {
    files: {
      'Cards/renamed-by-hand.md': NOTE('OP-5', 'priority: high\n', 'Moved to another file name.\n'),
      'Cards/lowercase.md': NOTE('op-6'),
      'Cards/not-a-card.md': '# just a note\n',
      'Cards/broken.md': '---\nkey: OP-9\ntitle: [oops\n---\nbody\n',
      'Cards/sub/nested.md': NOTE('OP-11', '', 'in a subfolder\n'),
      'Cards/.hidden.md': NOTE('OP-12'),
    },
    steps: [
      get('5'),
      get('6'),
      get('9'),
      get('11'),
      get('12'),
      step('list'),
      create({ title: 'Next number' }),
      update('5', { title: 'Renamed card' }),
      get('OP-5'),
    ],
  });

  add('update:fields', {
    steps: [
      create({ title: 'To change', labels: ['a', 'b'], assignee: 'Ana', due: '2026-11-01', estimate: 3 }),
      create({ title: 'Parent card', type: 'epic' }),
      update('1', { title: '  New   title ' }),
      update('1', { type: 'story', priority: 'highest' }),
      update('1', { assignee: null }),
      update('1', { assignee: '  Bruno ' }),
      update('1', { assignee: '   ' }),
      update('1', { labels: ['x', '#y', 'x', ''] }),
      update('1', { labels: [] }),
      update('1', { due: null }),
      update('1', { due: '2027-01-31' }),
      update('1', { estimate: null }),
      update('1', { estimate: 2.5 }),
      update('1', { parent: 'OP-2' }),
      update('1', { parent: null }),
      update('1', { body: 'New description\n\n- [x] done\n- [ ] open' }),
      update('1', { body: '' }),
      update('1', {}),
      get('1'),
    ],
  });

  add('update:validation', {
    steps: [
      create({ title: 'Card' }),
      update('1', { title: '   ' }),
      update('1', { due: '2026-13-01' }),
      update('1', { estimate: -0.5 }),
      update('1', { parent: '1' }),
      update('1', { parent: 'OP-1' }),
      update('1', { parent: 'OP-42' }),
      update('1', { parent: 'junk' }),
      update('1', { status: 'nowhere' }),
      update('99', { title: 'Missing card' }),
      update('junk', { title: 'Bad key' }),
      get('1'),
    ],
  });

  add('update:status-and-resolved', {
    steps: [
      create({ title: 'A' }),
      create({ title: 'B' }),
      create({ title: 'C', status: 'doing' }),
      update('1', { status: 'done' }),
      step('update', { key: '1', patch: { status: 'Done' } }),
      jump(update('1', { status: 'review' }), 3 * DAY),
      update('1', { status: 'done', rank: 'a5' }),
      update('2', { status: 'doing' }),
      update('2', { status: 'In Progress' }),
      update('3', { rank: 'Z' }),
      find({}),
      jump(find({}), 20 * DAY),
      jump(find({ includeArchived: true }), 20 * DAY),
      jump(find({ status: ['done'] }), 20 * DAY),
    ],
  });

  add('move:placement', {
    steps: [
      create({ title: 'A' }),
      create({ title: 'B' }),
      create({ title: 'C' }),
      create({ title: 'D', status: 'doing' }),
      move('3', 'todo', { before: 'OP-1' }),
      move('1', 'todo', { after: 'OP-2' }),
      move('2', 'todo', { after: 'OP-3' }),
      find({ status: ['todo'] }),
      move('4', 'todo', { before: 'OP-2' }),
      move('4', 'In Progress'),
      move('1', 'doing', { before: 'OP-4' }),
      move('2', 'done', {}),
      move('2', 'done', { before: 'OP-1' }),
      move('2', 'nowhere'),
      move('99', 'todo'),
      move('3', 'review', { before: 'OP-77' }),
      find({}),
      step('list'),
    ],
  });

  add('comments:lifecycle', {
    ids: ['a1', 'a1', 'b2', 'c3'],
    steps: [
      create({ title: 'Discuss', body: 'Original description.' }),
      addComment('1', { text: 'First comment' }),
      addComment('1', { text: 'Second\n\nwith a blank line', author: 'Bruno' }),
      addComment('1', { text: '  \n  Trimmed  \n\n  ' }),
      addComment('1', { text: '' }),
      addComment('1', { text: ' \n ' }),
      addComment('1', { text: 'Anonymous?', author: '   ' }),
      addComment('99', { text: 'Nobody home' }),
      step('editComment', { key: '1', id: 'a1', text: 'Edited first' }),
      step('editComment', { key: '1', id: 'nope', text: 'x' }),
      step('editComment', { key: '1', id: 'b2', text: '' }),
      step('removeComment', { key: '1', id: 'b2' }),
      step('removeComment', { key: '1', id: 'b2' }),
      update('1', { body: 'Rewritten description keeps the comments' }),
      get('1'),
      find({ text: 'trimmed' }),
      find({ text: 'EDITED' }),
    ],
  });

  add('comments:no-author-board', {
    config: { ...DEFAULT, me: '' },
    steps: [
      create({ title: 'Card' }),
      addComment('1', { text: 'Who am I?' }),
      addComment('1', { text: 'Named', author: 'Ana · [admin]\nSouza' }),
      find({ assignee: ['me'] }),
      find({ assignee: ['none'] }),
      find({ assignee: ['  NONE '] }),
      find({ assignee: ['@none', 'Ana'] }),
    ],
  });

  // Not compared byte for byte (here and in the next scenario): the yaml package rewrites the whole frontmatter and
  // normalizes the spacing before comments and inside flow lists, where the Rust editor leaves every line it did not
  // touch exactly as it was. `tests/service_edge.rs` checks that property directly.
  add(
    'comments:hand-written-notes',
    {
      ids: ['n1'],
      files: {
        'Cards/OP-1.md': NOTE(
          'OP-1',
          'custom: kept  # my own comment\nlabels: [ api ]\n',
          'Description by hand.\n\n## Comments\n\n> [!comment] Bruno\n> written by hand\n\n> [!comment|x1,2026-10-02T10:00:00.000Z] Ana · 2026-10-02 10:00\n> with metadata\n',
        ),
      },
      steps: [
        get('1'),
        addComment('1', { text: 'Machine comment', author: 'Carla' }),
        update('1', { priority: 'high', labels: ['api', 'ux'] }),
        step('removeComment', { key: '1', id: 'x1' }),
        update('1', { body: 'Replaced.' }),
        get('1'),
      ],
    },
    false,
  );

  add('find:filters', {
    steps: [
      create({
        title: 'Login bug',
        type: 'bug',
        priority: 'high',
        assignee: 'Ana',
        labels: ['auth'],
        body: 'Café au lait crashes',
      }),
      create({ title: 'Payments story', type: 'story', assignee: 'Bruno', labels: ['pay'], status: 'doing' }),
      create({ title: 'Unowned task', status: 'review' }),
      create({ title: 'Epic parent', type: 'epic' }),
      create({ title: 'Child of four', parent: '4', assignee: 'Ana' }),
      find({ assignee: ['me'] }),
      find({ assignee: ['ME', 'bruno'] }),
      find({ assignee: ['none'] }),
      find({ status: ['In Progress', 'review'] }),
      find({ type: ['bug', 'epic'] }),
      find({ priority: ['high', 'low'] }),
      find({ labels: ['AUTH', 'pay'] }),
      find({ parent: '4' }),
      find({ parent: 'op-4' }),
      find({ parent: '77' }),
      find({ text: 'CAFE' }),
      find({ text: 'login bug' }),
      find({ text: '   ' }),
      find({ text: 'login', status: ['todo'], assignee: ['Ana'] }),
      find({ status: ['nowhere'] }),
      find({ parent: 'zzz' }),
      find({ labels: [] }),
      step('list'),
    ],
  });

  add('find:me-not-configured', {
    config: { ...DEFAULT, me: '' },
    steps: [create({ title: 'Card' }), find({ assignee: ['me'] }), find({ assignee: ['Ana'] })],
  });

  add(
    'update:hand-edited-frontmatter',
    {
      files: {
        'Cards/OP-1.md':
          '---\n# my note\nkey: OP-1\ntitle: Hand edited   # why\nstatus: doing\nrank: M\ncreated: 2026-10-01T10:00:00.000Z\nupdated: 2026-10-01T10:00:00.000Z\nrelated: ["[[Other]]"]\ncustom:\n  nested: yes\n  list:\n    - a\n    - b\n---\nBody here.\n',
        'Cards/OP-2.md': '---\nkey: OP-2\ntitle: Broken\nstatus: [oops\n---\nBody\n',
      },
      steps: [
        update('1', { title: 'Changed', priority: 'high' }),
        update('1', { status: 'done' }),
        update('1', { assignee: 'Ana', due: '2026-10-20' }),
        update('2', { title: 'Cannot patch broken frontmatter' }),
        addComment('1', { text: 'Comment on a hand edited note' }),
        get('1'),
        find({}),
      ],
    },
    false,
  );

  add('remove:and-trash', {
    steps: [
      create({ title: 'Gone' }),
      create({ title: 'Stays' }),
      step('remove', { key: '1' }),
      step('remove', { key: '1' }),
      get('1'),
      find({}),
      create({ title: 'New one' }),
    ],
  });

  add(
    'create:numbers-as-text',
    {
      steps: [
        create({ title: '123' }),
        create({ title: 'true' }),
        create({ title: 'null' }),
        create({ title: '2026-10-15' }),
        create({ title: 'a: b' }),
        find({ text: 'true' }),
      ],
    },
    false,
  );

  return out;
}

// --- random scenarios ---------------------------------------------------------------------------------------------------

function randomCreate(r: Random, f: Flavor, keys: string[], columns: string[]): Json {
  const input: Json = { title: f.title(r) };
  if (chance(r, 0.4)) input.status = pick(r, columns);
  if (chance(r, 0.3)) input.type = pick(r, ['task', 'story', 'bug', 'epic']);
  if (chance(r, 0.3)) input.priority = pick(r, ['highest', 'high', 'medium', 'low', 'lowest']);
  if (chance(r, 0.4)) input.assignee = pick(r, NAMES);
  if (chance(r, 0.4)) input.labels = Array.from({ length: int(r, 0, 3) }, () => pick(r, LABELS));
  if (chance(r, 0.3)) input.due = `2026-${String(int(r, 10, 12))}-${String(int(r, 10, 28))}`;
  if (chance(r, 0.25)) input.estimate = pick(r, [0, 1, 2, 3, 5, 8, 0.5, 13]);
  if (chance(r, 0.25) && keys.length) input.parent = pick(r, [...keys, ...keys.map((k) => k.split('-')[1]!)]);
  if (chance(r, 0.4)) input.body = f.body(r);
  if (chance(r, 0.05)) input.rank = pick(r, ['V', 'a0', 'Zz', '1']);
  // one defect at most
  if (chance(r, 0.12)) {
    const defect = int(r, 0, 4);
    if (defect === 0) input.title = pick(r, ['', '  ', '\n']);
    if (defect === 1) input.status = 'nowhere';
    if (defect === 2) input.due = pick(r, ['2026-02-30', 'soon', '2026-13-01']);
    if (defect === 3) input.estimate = pick(r, [-1, -0.5]);
    if (defect === 4) input.parent = pick(r, ['OP-9999', 'not a key']);
  }
  return input;
}

function randomPatch(r: Random, f: Flavor, keys: string[], own: string): Json {
  // The yaml package keeps the *format* of a node whose value it replaces: after 1e21 (written `1e+21`) a patch to 0
  // writes `0e+0`. Same value, different text, so exponents stay out of the scenarios compared byte for byte.
  const patch: Json = {};
  if (chance(r, 0.3)) patch.title = f.title(r);
  if (chance(r, 0.15)) patch.type = pick(r, ['task', 'story', 'bug', 'epic']);
  if (chance(r, 0.15)) patch.priority = pick(r, ['highest', 'high', 'medium', 'low', 'lowest']);
  if (chance(r, 0.3)) patch.assignee = pick(r, [null, ...NAMES, '  ', ' Ana ']);
  if (chance(r, 0.3)) patch.labels = Array.from({ length: int(r, 0, 3) }, () => pick(r, LABELS));
  if (chance(r, 0.25)) patch.due = pick(r, [null, '2026-12-24', '2027-01-15']);
  if (chance(r, 0.25)) patch.estimate = pick(r, f.exact ? [null, 0, 3, 2.5] : [null, 0, 3, 2.5, 1e21]);
  if (chance(r, 0.2)) patch.parent = pick(r, [null, ...keys.filter((k) => k !== own)]);
  if (chance(r, 0.25)) patch.body = f.body(r);
  if (chance(r, 0.15)) patch.rank = pick(r, ['M', 'a5', 'Zz']);
  if (chance(r, 0.25))
    patch.status = pick(r, [
      'todo',
      'doing',
      'review',
      'done',
      'To Do',
      'In Progress',
      'DONE',
      'backlog',
      'wip',
      'shipped',
    ]);
  if (chance(r, 0.1)) {
    const defect = int(r, 0, 4);
    if (defect === 0) patch.title = '   ';
    if (defect === 1) patch.due = '2026-02-30';
    if (defect === 2) patch.estimate = -3;
    if (defect === 3) patch.parent = pick(r, [own, 'OP-4242', 'junk']);
    if (defect === 4) patch.status = 'nowhere';
  }
  return patch;
}

const KEY_FORMS = [
  (k: string) => k,
  (k: string) => k.toLowerCase(),
  (k: string) => k.split('-')[1]!,
  (k: string) => ` ${k} `,
];

async function randomScenario(r: Random, flavor: Flavor): Promise<{ scenario: Scenario; exact: boolean }> {
  const custom = chance(r, 0.3);
  const config = (custom ? CUSTOM_CONFIG : { ...DEFAULT, hideDoneAfterDays: pick(r, [0, 2, 14]) }) as Json;
  const columns = custom
    ? ['backlog', 'wip', 'shipped', 'Backlog', 'In Progress']
    : ['todo', 'doing', 'review', 'done', 'To Do', 'In Progress'];
  const prefix = custom ? 'WEB' : 'OP';
  const scenario: Scenario = { config, files: {}, ids: [], steps: [] };

  // a few notes that were already in the vault, written by the reference implementation
  const storage = new MemoryStorage();
  const seedService = newService({ ...scenario, config }, storage);
  for (let i = 0; i < int(r, 0, 3); i++) {
    seedService.setClock(BASE - (3 - i) * DAY);
    await seedService.service
      .create({ title: flavor.title(r), status: pick(r, columns), body: flavor.body(r) })
      .catch(() => undefined);
  }
  for (const [path, content] of storage.files) scenario.files[path] = content;
  if (chance(r, 0.15)) scenario.files['Cards/stray.md'] = '# not a card\n';
  if (chance(r, 0.1)) scenario.files[`Cards/${prefix}-90.md`] = NOTE(`${prefix}-90`, '', 'hand written\n');

  const live = new MemoryStorage();
  for (const [p, c] of Object.entries(scenario.files)) live.files.set(p, c);
  const { service, setClock } = newService(scenario, live);
  scenario.ids = Array.from({ length: 12 }, () => pick(r, ['a', 'b', 'c', 'd', 'e', 'f', 'g']));

  let clock = BASE;
  const count = int(r, 8, 20);
  for (let i = 0; i < count; i++) {
    clock += chance(r, 0.15) ? int(r, 1, 30) * DAY : int(r, 1, 180) * MINUTE;
    const cards = await service.list();
    const keys = cards.map((c) => c.key);
    const some = () => (keys.length && chance(r, 0.9) ? pick(r, keys) : `${prefix}-${int(r, 1, 120)}`);
    const keyArg = () => pick(r, KEY_FORMS)(some());
    const roll = r();
    let s: Step;
    if (roll < 0.26) s = { at: clock, op: 'create', args: { input: randomCreate(r, flavor, keys, columns) } };
    else if (roll < 0.44) {
      const key = some();
      s = { at: clock, op: 'update', args: { key: pick(r, KEY_FORMS)(key), patch: randomPatch(r, flavor, keys, key) } };
    } else if (roll < 0.56) {
      const column = chance(r, 0.93) ? pick(r, columns) : 'nowhere';
      const placement: Json = chance(r, 0.4) ? { [pick(r, ['before', 'after'])]: some() } : {};
      s = { at: clock, op: 'move', args: { key: keyArg(), column, placement } };
    } else if (roll < 0.62) s = { at: clock, op: 'remove', args: { key: keyArg() } };
    else if (roll < 0.68) s = { at: clock, op: 'get', args: { key: keyArg() } };
    else if (roll < 0.76) {
      const query: Json = {};
      if (chance(r, 0.3)) query.text = pick(r, [...WORDS, 'CAFÉ', ' ', flavor.title(r)]);
      if (chance(r, 0.3)) query.status = [pick(r, columns)];
      if (chance(r, 0.2)) query.assignee = [pick(r, ['me', 'none', ...NAMES])];
      if (chance(r, 0.2)) query.labels = [pick(r, LABELS)];
      if (chance(r, 0.15)) query.type = [pick(r, ['bug', 'task', 'epic'])];
      if (chance(r, 0.15)) query.priority = [pick(r, ['high', 'medium'])];
      if (chance(r, 0.15)) query.parent = some();
      if (chance(r, 0.3)) query.includeArchived = chance(r, 0.5);
      s = { at: clock, op: 'find', args: { query } };
    } else if (roll < 0.79) s = { at: clock, op: 'list', args: {} };
    else if (roll < 0.9) {
      const comment: Json = { text: flavor.comment(r) };
      if (chance(r, 0.4)) comment.author = pick(r, NAMES);
      if (chance(r, 0.05)) comment.text = pick(r, ['', '   ']);
      s = { at: clock, op: 'addComment', args: { key: keyArg(), comment } };
    } else if (roll < 0.95) {
      const key = some();
      const card = cards.find((c) => c.key === key);
      const id = card?.comments.length && chance(r, 0.8) ? pick(r, card.comments).id : pick(r, ['a', 'nope']);
      s = chance(r, 0.5)
        ? { at: clock, op: 'editComment', args: { key, id, text: flavor.comment(r) } }
        : { at: clock, op: 'removeComment', args: { key, id } };
    } else if (roll < 0.98)
      s = {
        at: clock,
        op: 'resolveKey',
        args: { input: pick(r, ['1', 'OP-2', ' web-3 ', 'x', '', '007', '12345678901234567890']) },
      };
    else s = { at: clock, op: 'checkStatus', args: { input: pick(r, [...columns, ' DONE ', 'x']) } };
    scenario.steps.push(s);
    await execute(service, s, setClock);
  }
  void setClock;
  return { scenario, exact: flavor.exact };
}

export async function generate(): Promise<FixtureFile> {
  const cases: Case[] = [];
  for (const { id, scenario, exact } of handWritten())
    cases.push({ id: `scenario:${id}`, input: scenario, expected: await run(scenario, exact) });

  const r = rng(20261017);
  for (let i = 0; i < 110; i++) {
    const { scenario, exact } = await randomScenario(r, ORDINARY);
    cases.push({ id: `ordinary:${i}`, input: scenario, expected: await run(scenario, exact) });
  }
  for (let i = 0; i < 70; i++) {
    const { scenario, exact } = await randomScenario(r, TRICKY);
    cases.push({ id: `tricky:${i}`, input: scenario, expected: await run(scenario, exact) });
  }
  return {
    description:
      'Scenarios for the card service: a board, the notes already in the vault, and steps (create, update, move, comments, find, get, remove). Each case records what the TypeScript service returned or threw per step, and the notes at the end.',
    cases,
  };
}
