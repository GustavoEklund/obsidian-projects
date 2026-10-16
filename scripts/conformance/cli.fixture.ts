// Conformance corpus for the command line: the Rust `oprojects` (packages/mcp/src/cli) replays every scenario.
// A scenario is a vault (the notes and the board settings already in it) and a list of invocations: the arguments, what
// is on stdin, the terminal (colors, width), the environment and the clock. Nothing here is hand-computed: the generator
// runs the TypeScript CLI (`run` in packages/cli/src/run.ts) on a real temporary vault and records, for each
// invocation, the exit code, stdout, stderr and the URLs it asked to open, and at the end every file in the vault.
//
// Rules the generator follows so both sides can be compared:
// - The vault's path is a placeholder, `<vault>`, in the arguments and the environment going in, and in the text coming
//   out. `<outside>` is a folder that has no vault above it.
// - The messages Node's `parseArgs` writes for unknown options and for an option that is missing its value differ
//   between Node versions, so only their first line is recorded (`normalizeError`); the Rust side applies the same cut.
// - Notes are compared byte for byte only in scenarios whose text is "ordinary" (plain words, where both YAML writers
//   agree); in the others they are compared as the cards they parse to. The board settings are always compared as text.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CardService, MemoryStorage, normalizeConfig, parseCard, type BoardConfig, type Card } from '@oprojects/core';
import { run, type IO } from '../../packages/cli/src/run';
import { chance, int, pick, rng, text, type Case, type FixtureFile, type Random } from './lib';

// Dates and times come out in local time: the corpus is produced in UTC and Rust is given an offset of 0.
process.env.TZ = 'UTC';

export const name = 'cli';

type Json = Record<string, unknown>;

export interface Invocation {
  argv: string[];
  stdin?: string;
  env?: Record<string, string>;
  /** Is stdout a terminal? Colors are on for a terminal (or with FORCE_COLOR). Default false. */
  tty?: boolean;
  /** The terminal's width. Default 100. */
  columns?: number;
  /** The clock, in milliseconds since the epoch. */
  at: number;
  /** Where the command runs, with `<vault>` and `<outside>` placeholders. Default: the vault. */
  cwd?: string;
  /** Makes the attempt to open a URL fail with this message. */
  openError?: string;
}

export interface Scenario {
  /** The vault folder's name (it shows in `open`'s URL). Default `vault`. */
  vaultName?: string;
  /** Files in the vault before the first invocation, by path inside it. */
  files: Record<string, string>;
  /** The comment ids the service gets, in order (`z<n>` after that). */
  ids: string[];
  runs: Invocation[];
}

interface Result {
  code: number;
  out: string;
  err: string;
  opened: string[];
}

const BASE = Date.parse('2026-10-15T12:00:00.000Z');
const MINUTE = 60_000;
const DAY = 86_400_000;
const SETTINGS = '.obsidian/plugins/obsidian-projects/data.json';

// --- running a scenario on the reference implementation -------------------------------------------------------------

/** Keeps the part of Node's `parseArgs` messages that does not change from one Node version to the next. */
export function normalizeError(err: string): string {
  return err
    .replace(/(Unknown option .*?)\. To specify a positional argument[^\n]*/, '$1')
    .replace(/(argument is ambiguous\.)\nDid you forget[^\n]*\nTo specify an option argument[^\n]*/, '$1');
}

async function listFiles(root: string, dir = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, rel)));
    else out.push(rel);
  }
  return out.sort();
}

async function execute(scenario: Scenario, exactText: boolean): Promise<Case['expected']> {
  const outside = await mkdtemp(path.join(tmpdir(), 'oprojects-cli-corpus-'));
  const root = path.join(outside, scenario.vaultName ?? 'vault');
  try {
    await mkdir(path.join(root, '.obsidian'), { recursive: true });
    for (const [rel, content] of Object.entries(scenario.files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), content);
    }
    const into = (t: string) => t.split('<vault>').join(root).split('<outside>').join(outside);
    const outOf = (t: string) => t.split(root).join('<vault>').split(outside).join('<outside>');

    let nextId = 0;
    const results: Result[] = [];
    for (const inv of scenario.runs) {
      const result: Result = { code: 0, out: '', err: '', opened: [] };
      const env = Object.fromEntries(Object.entries(inv.env ?? {}).map(([k, v]) => [k, into(v)]));
      const io: IO = {
        cwd: into(inv.cwd ?? '<vault>'),
        env,
        out: (t) => void (result.out += t),
        err: (t) => void (result.err += t),
        readStdin: async () => inv.stdin ?? '',
        isTTY: inv.tty ?? false,
        columns: inv.columns ?? 100,
        now: () => new Date(inv.at),
        openUrl: async (u) => {
          result.opened.push(u);
          if (inv.openError) throw new Error(inv.openError);
        },
        newId: () => scenario.ids[nextId++] ?? `z${nextId}`,
      };
      result.code = await run(inv.argv.map(into), io);
      results.push({
        code: result.code,
        out: outOf(result.out),
        err: normalizeError(outOf(result.err)),
        opened: result.opened.map(outOf),
      });
    }

    const files = [];
    for (const rel of await listFiles(root)) {
      const content = await readFile(path.join(root, rel), 'utf8');
      const note: { path: string; text?: string; card?: Card | null } = { path: rel };
      const isNote = rel.endsWith('.md');
      if (isNote) note.card = parseCard(rel, content) ?? null;
      if (exactText || !isNote) note.text = content;
      files.push(note);
    }
    return { exactText, runs: results, files };
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}

// --- the vault a scenario starts from -------------------------------------------------------------------------------

const WORDS = ['fix', 'login', 'redirect', 'api', 'docs', 'parser', 'cache', 'search', 'export', 'billing', 'retry'];
const NAMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Zoë', 'Étienne', 'Maximiliano Fernandez'];
const LABELS = ['api', 'ux', 'backend', 'docs', 'infra', 'Zoë', 'a b'];
const TITLES = [
  'Fix the login redirect',
  'Write the release notes',
  'Parser crashes on empty frontmatter',
  'Zażółć gęślą jaźń: Привет, мир',
  '日本語のタイトルを表示する',
  'A very long title that goes on and on well past any reasonable terminal width so that it has to be cut short somewhere',
  'Supercalifragilisticexpialidocious_and_one_more_word_without_any_spaces_at_all_to_wrap',
  'Emoji 🚀 in the title',
  'x',
];

const DEFAULT: Json = { folder: 'Cards', prefix: 'OP', me: 'Ana', members: ['Ana', 'Bruno'], hideDoneAfterDays: 14 };
const NO_ME: Json = { folder: 'Cards', prefix: 'OP', me: '', members: [], hideDoneAfterDays: 14 };
const CUSTOM: Json = {
  folder: 'Work/Board',
  prefix: 'WEB',
  me: 'Zoë',
  members: ['Zoë', 'Bruno'],
  hideDoneAfterDays: 3,
  columns: [
    { id: 'backlog', name: 'Backlog' },
    { id: 'wip', name: 'In Progress', wip: 2 },
    { id: 'shipped', name: 'Shipped', done: true },
  ],
};

const settings = (board: Json, extra: Json = {}) => JSON.stringify({ ...extra, board }, null, 2) + '\n';

interface SeedOptions {
  cards: number;
  ordinary: boolean;
  titles?: string[];
}

/** Notes written by the reference service itself: a few cards in different columns, with comments, epics and dates. */
async function seed(r: Random, config: Json, options: SeedOptions): Promise<Record<string, string>> {
  const storage = new MemoryStorage();
  let clock = BASE - 30 * DAY;
  const service = new CardService(storage, normalizeConfig(config) as BoardConfig, {
    now: () => new Date(clock),
    newId: () => Array.from({ length: 5 }, () => pick(r, [...'abcdefghijklmnop'])).join(''),
  });
  const columns = normalizeConfig(config).columns.map((c) => c.id);
  const keys: string[] = [];
  for (let i = 0; i < options.cards; i++) {
    clock += int(r, 1, 20) * 60 * MINUTE;
    const title = options.titles
      ? pick(r, options.titles)
      : options.ordinary
        ? `${pick(r, WORDS)} ${pick(r, WORDS)}`
        : text(r, 4) || 'tricky';
    const due = chance(r, 0.5) ? new Date(BASE + int(r, -5, 20) * DAY).toISOString().slice(0, 10) : undefined;
    const card = await service
      .create({
        title,
        status: pick(r, columns),
        type: pick(r, ['task', 'story', 'bug', 'epic'] as const),
        priority: pick(r, ['highest', 'high', 'medium', 'low', 'lowest'] as const),
        assignee: chance(r, 0.7) ? pick(r, NAMES) : undefined,
        labels: chance(r, 0.5) ? Array.from({ length: int(r, 1, 3) }, () => pick(r, LABELS)) : undefined,
        due,
        estimate: chance(r, 0.4) ? pick(r, [0.5, 1, 2, 3, 5, 8]) : undefined,
        parent: keys.length && chance(r, 0.25) ? pick(r, keys) : undefined,
        body: chance(r, 0.6)
          ? pick(r, ['Plain description.', 'Steps:\n\n- [x] Reproduce\n- [ ] Fix it\n', ''])
          : undefined,
      })
      .catch(() => undefined);
    if (!card) continue;
    keys.push(card.key);
    for (let c = chance(r, 0.35) ? int(r, 1, 3) : 0; c > 0; c--) {
      clock += int(r, 1, 90) * MINUTE;
      await service
        .addComment(card.key, {
          text: options.ordinary ? `${pick(r, WORDS)} soon` : text(r, 4) || 'ok',
          author: pick(r, NAMES),
        })
        .catch(() => undefined);
    }
  }
  return Object.fromEntries(storage.files);
}

const vaultOf = (config: Json, notes: Record<string, string>, extra: Json = {}): Record<string, string> => ({
  [SETTINGS]: settings(config, extra),
  ...notes,
});

// --- invocations ----------------------------------------------------------------------------------------------------

let tick = 0;
const inv = (argv: string[], rest: Partial<Invocation> = {}): Invocation => ({
  argv,
  at: BASE + tick++ * MINUTE,
  ...rest,
});

// --- hand-written scenarios -----------------------------------------------------------------------------------------

async function handWritten(): Promise<{ id: string; scenario: Scenario; exact: boolean }[]> {
  tick = 0;
  const r = rng(11);
  const out: { id: string; scenario: Scenario; exact: boolean }[] = [];
  const add = (id: string, scenario: Partial<Scenario> & { runs: Invocation[] }, exact = true) =>
    out.push({ id, scenario: { files: {}, ids: [], ...scenario }, exact });

  const small = vaultOf(DEFAULT, await seed(r, DEFAULT, { cards: 8, ordinary: true }));
  const rich = vaultOf(DEFAULT, await seed(r, DEFAULT, { cards: 24, ordinary: true, titles: TITLES }));
  const custom = vaultOf(CUSTOM, await seed(r, CUSTOM, { cards: 14, ordinary: true }));
  const noMe = vaultOf(NO_ME, await seed(r, NO_ME, { cards: 6, ordinary: true }));

  // help, version and usage mistakes need no vault at all
  add('help:top', {
    runs: [
      inv([]),
      inv(['--help']),
      inv(['-h']),
      inv(['help']),
      inv(['help'], { tty: true }),
      inv(['help'], { env: { FORCE_COLOR: '1' } }),
      inv(['help'], { tty: true, env: { NO_COLOR: '1' } }),
      inv(['help', '--no-color'], { tty: true }),
      inv(['help', 'nosuchcommand']),
      inv(['--version']),
      inv(['-v']),
    ],
  });
  for (const command of [
    'add',
    'new',
    'create',
    'list',
    'ls',
    'board',
    'b',
    'show',
    'get',
    'comment',
    'c',
    'move',
    'mv',
    'edit',
    'set',
    'rm',
    'delete',
    'remove',
    'open',
    'config',
    'init',
  ])
    add(`help:${command}`, {
      runs: [
        inv(['help', command]),
        inv([command, '--help']),
        inv([command, '-h'], { tty: true }),
        inv([command, '--help', '--json']),
      ],
    });
  add('usage:unknown', {
    runs: [
      inv(['frobnicate']),
      inv(['--json']),
      inv(['--vault', '<vault>']),
      inv(['-x']),
      inv(['LIST']),
      inv(['']),
      inv(['--', 'list']),
    ],
  });

  // no vault
  add('vault:none', {
    runs: [
      inv(['list'], { cwd: '<outside>' }),
      inv(['list', '--vault', '<outside>']),
      inv(['config', '--vault', '<outside>', '--json']),
      inv(['list'], { cwd: '<outside>', env: { OPROJECTS_VAULT: '<outside>' } }),
      inv(['list'], { cwd: '<outside>', env: { OPROJECTS_VAULT: '<vault>' } }),
      inv(['list', '--vault', '<vault>'], { cwd: '<outside>', env: { OPROJECTS_VAULT: '<outside>' } }),
      inv(['list', '--vault='], { cwd: '<outside>' }),
      inv(['list', '--vault=<vault>'], { cwd: '<outside>' }),
      inv(['--vault', '<vault>', 'list'], { cwd: '<outside>' }),
      inv(['--vault=<vault>', 'list'], { cwd: '<outside>' }),
      inv(['--vault=<vault>', '--json', 'config'], { cwd: '<outside>' }),
      inv(['list', '--vault', '<vault>/Cards'], { cwd: '<outside>' }),
      inv(['list', '--vault', '<vault>/../vault'], { cwd: '<outside>' }),
      inv(['init'], { cwd: '<outside>' }),
    ],
    files: small,
  });
  add('vault:cwd-inside', {
    runs: [
      inv(['list'], { cwd: '<vault>/Cards' }),
      inv(['config'], { cwd: '<vault>/Cards' }),
      inv(['config'], { cwd: '<vault>/.obsidian' }),
      inv(['list', '-q', 'fix'], { cwd: '<vault>/Cards/..' }),
    ],
    files: small,
  });

  // an empty vault: defaults, init, then the first cards
  add('init:fresh', {
    runs: [
      inv(['list']),
      inv(['config']),
      inv(['init']),
      inv(['init']),
      inv(['config', '--json']),
      inv(['add', 'First card']),
      inv(['list']),
    ],
  });
  add('init:options', {
    runs: [
      inv(['init', '--prefix', 'web', '--folder', 'Work/Board', '--me', 'Zoë']),
      inv(['config']),
      inv(['add', 'Under the new key']),
      inv(['init', '--prefix', 'API']),
      inv(['init', '--prefix', 'API', '--force']),
      inv(['init', '--me', 'Bruno']),
      inv(['init', '--folder', 'Elsewhere']),
      inv(['init', '--folder', 'Elsewhere', '--force']),
      inv(['config', '--json']),
      inv(['init', '--folder', '/']),
      inv(['init', '--folder', '', '--force']),
      inv(['init', '--folder', '../escape', '--force']),
    ],
  });
  add('init:bad-prefix', {
    runs: [
      inv(['init', '--prefix', 'x']),
      inv(['init', '--prefix', '1AB']),
      inv(['init', '--prefix', 'TOOLONGPREFIX']),
      inv(['init', '--prefix', 'ok1']),
      inv(['init', '--prefix', 'A B']),
      inv(['init', '--prefix', '']),
      inv(['init', '--prefix']),
    ],
  });
  add('init:keeps-other-settings', {
    files: { [SETTINGS]: settings(DEFAULT, { other: { nested: [1, 2, { a: null }] }, flag: true }) },
    runs: [inv(['init', '--me', 'Carla']), inv(['config'])],
  });
  add('init:existing-board-is-left-alone', { files: small, runs: [inv(['init']), inv(['init', '--json'])] });
  add('init:broken-settings', {
    files: { [SETTINGS]: '{ this is not json' },
    runs: [inv(['config']), inv(['init', '--prefix', 'ZZ']), inv(['config'])],
  });
  add('config:variants', {
    files: custom,
    runs: [
      inv(['config']),
      inv(['config', '--json']),
      inv(['config'], { tty: true }),
      inv(['config', '--no-color'], { tty: true }),
    ],
  });
  add('config:no-me', { files: noMe, runs: [inv(['config']), inv(['config'], { tty: true })] });
  add('config:odd-settings', {
    files: {
      [SETTINGS]: JSON.stringify({
        board: {
          prefix: 'bad prefix',
          folder: '/a//b/',
          columns: [{ id: 'x' }, { name: 'Two', done: 'yes', wip: -3 }],
          members: ['a', 'a', 7],
          me: 5,
        },
      }),
    },
    runs: [inv(['config']), inv(['config', '--json'])],
  });

  // reading cards
  for (const [label, files] of [
    ['default', rich],
    ['custom', custom],
    ['empty', {} as Record<string, string>],
  ] as const) {
    add(`list:${label}`, {
      files,
      runs: [
        inv(['list']),
        inv(['ls', '--json']),
        inv(['list'], { tty: true }),
        inv(['list', '--all']),
        inv(['list', '--mine']),
        inv(['list', '-a', 'none']),
        inv(['list', '-a', 'me']),
        inv(['list', '-a', 'ana,bruno']),
        inv(['list', '-a', 'Ana', '-a', 'Bruno']),
        inv(['list', '-t', 'bug']),
        inv(['list', '-t', 'bug,story', '-p', 'high,highest']),
        inv(['list', '-s', 'doing']),
        inv(['list', '-s', 'In Progress', '-s', 'review']),
        inv(['list', '-l', 'api']),
        inv(['list', '-l', 'api,ux']),
        inv(['list', '-q', 'FIX']),
        inv(['list', '-q', '  ']),
        inv(['list', '--parent', '1']),
        inv(['list', '--parent', 'OP-2', '--json']),
        inv(['list', '-s', 'nope']),
        inv(['list', '-t', 'nope']),
        inv(['list', '-p', 'nope']),
        inv(['list', '-t', 'nope', '-p', 'nope']),
        inv(['list', '-s', 'nope', '-t', 'nope']),
        inv(['list', '--parent', 'x']),
        inv(['list', '--parent', 'OP-999']),
        inv(['list', '-s', 'todo', '-t', 'bug', '-p', 'high', '-l', 'api', '-a', 'me', '-q', 'x', '--all', '--mine']),
      ],
    });
  }
  add('list:mine-needs-me', {
    files: noMe,
    runs: [
      inv(['list', '--mine']),
      inv(['list', '-a', 'me']),
      inv(['board', '--mine']),
      inv(['list', '--mine', '--json']),
    ],
  });
  add('list:trailing-and-weird-args', {
    files: small,
    runs: [
      inv(['list', 'stray', 'positionals']),
      inv(['list', '-']),
      inv(['list', '--']),
      inv(['list', '--', '--all']),
      inv(['list', '--json', '--json']),
      inv(['list', '--status=todo']),
      inv(['list', '-stodo']),
      inv(['list', '-s=todo']),
      inv(['list', '-s']),
      inv(['list', '--status']),
      inv(['list', '-s', '--json']),
      inv(['list', '-s', '-']),
      inv(['list', '--status=-x']),
      inv(['list', '--bogus']),
      inv(['list', '-x']),
      inv(['list', '-1']),
      inv(['list', '--json=1']),
      inv(['list', '--no-color=x']),
      inv(['list', '--all=false']),
      inv(['list', '--Status', 'todo']),
      inv(['list', '-hx']),
      inv(['list', '-xh']),
      inv(['list', '-qs']),
      inv(['list', '-mq', 'x']),
      inv(['list', '-q']),
      inv(['list', '--vault']),
      inv(['list', '--vault', '--json']),
      inv(['--json', '--no-color', 'list']),
      inv(['list', '--json', '--', '--no-color']),
      inv(['list', '--', '--json']),
      inv(['list', '--vault=<vault>', '--vault=<outside>']),
    ],
  });
  for (const [label, files] of [
    ['default', rich],
    ['custom', custom],
    ['empty', {} as Record<string, string>],
  ] as const) {
    add(`board:${label}`, {
      files,
      runs: [
        inv(['board']),
        inv(['b', '--epics']),
        inv(['board', '--json']),
        inv(['board', '--json', '--epics']),
        inv(['board'], { tty: true }),
        inv(['board', '--mine']),
        inv(['board', '-t', 'bug']),
        inv(['board', '--all']),
        ...[10, 20, 25, 40, 59, 60, 63, 64, 80, 85, 86, 89, 90, 100, 120, 200].map((columns) =>
          inv(['board'], { columns, tty: columns % 20 === 0 }),
        ),
        ...[10, 30, 50, 79, 80, 100, 200].map((columns) => inv(['list'], { columns, tty: columns % 20 === 0 })),
      ],
    });
  }
  add('show:cards', {
    files: rich,
    runs: [
      ...[
        '1',
        'OP-1',
        'op-2',
        ' OP-3 ',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        '10',
        '11',
        '12',
        '13',
        '14',
        '15',
        '16',
      ].flatMap((key) => [inv(['show', key]), inv(['get', key, '--json'])]),
      inv(['show', '1'], { tty: true }),
      inv(['show']),
      inv(['show', 'OP-999']),
      inv(['show', 'x']),
      inv(['show', '1', '2']),
      inv(['show', '1', '--bogus']),
      inv(['show', '--', '-5']),
      inv(['show', '0']),
      inv(['show', '007']),
    ],
  });
  return out;
}

// --- the commands that write ---------------------------------------------------------------------------------------

async function writing(): Promise<{ id: string; scenario: Scenario; exact: boolean }[]> {
  const r = rng(23);
  const out: { id: string; scenario: Scenario; exact: boolean }[] = [];
  const add = (id: string, scenario: Partial<Scenario> & { runs: Invocation[] }, exact = true) =>
    out.push({ id, scenario: { files: {}, ids: [], ...scenario }, exact });

  const small = vaultOf(DEFAULT, await seed(r, DEFAULT, { cards: 8, ordinary: true }));
  const custom = vaultOf(CUSTOM, await seed(r, CUSTOM, { cards: 10, ordinary: true }));
  const noMe = vaultOf(NO_ME, await seed(r, NO_ME, { cards: 5, ordinary: true }));
  const ids = ['k1a2b', 'k3c4d', 'k5e6f', 'k7g8h', 'k9i0j', 'm1n2o'];

  add('add:basics', {
    files: small,
    runs: [
      inv(['add', 'Fix', 'the', 'login']),
      inv(['new', 'Second card']),
      inv(['create', 'Third']),
      inv(['add', '  padded   title  ']),
      inv(['add', 'Quoted title with  double  spaces']),
      inv(['add', 'Json please', '--json']),
      inv(['add', 'Colors', '--no-color'], { tty: true }),
      inv(['add', 'With colors'], { tty: true }),
      inv(['add', 'With force color'], { env: { FORCE_COLOR: '1' } }),
      inv(['add', 'No color wins'], { tty: true, env: { NO_COLOR: '1' } }),
      inv(['--json', 'add', 'Hoisted json']),
      inv(['add', '--', '--dashes', 'first']),
      inv(['add', '--', '-x']),
      inv(['add', '日本語のタイトル', '🚀']),
      inv(['list', '--all']),
    ],
  });
  add('add:missing-title', {
    files: small,
    runs: [
      inv(['add']),
      inv(['add', '']),
      inv(['add', '   ']),
      inv(['add', '-t', 'bug']),
      inv(['add', '--json']),
      inv(['add', '', '--json']),
    ],
  });
  add('add:every-option', {
    files: small,
    runs: [
      inv([
        'add',
        'All options',
        '-t',
        'bug',
        '-p',
        'highest',
        '-s',
        'doing',
        '-a',
        'Bruno',
        '-l',
        'api,ux',
        '--due',
        '+3d',
        '--estimate',
        '5',
        '--parent',
        '1',
        '--body',
        'The description',
      ]),
      inv([
        'add',
        'Long names',
        '--type',
        'story',
        '--priority',
        'low',
        '--status',
        'In Progress',
        '--assignee',
        'me',
        '--label',
        'a',
        '--label',
        'b',
        '--due',
        'tomorrow',
        '--estimate',
        '2.5',
        '--parent',
        'OP-2',
      ]),
      inv(['add', 'By names', '-s', 'review', '-a', 'ME']),
      inv(['add', 'Shorthand values', '-tbug', '-phigh', '-sdone', '-aAna', '-lx,y']),
      inv([
        'add',
        'Cleared',
        '-a',
        'none',
        '-a',
        '',
        '--due',
        'none',
        '--estimate',
        'none',
        '--parent',
        'none',
        '-l',
        'none',
      ]),
      inv(['add', 'Empty values', '-a', '', '--due', '', '--estimate', '', '--parent', '', '-l', '']),
      inv(['add', 'Many labels', '-l', 'a, b ,,c', '-l', 'A', '-l', '#tag']),
      inv(['add', 'Repeated', '-t', 'bug', '-t', 'epic', '-p', 'low', '-p', 'high']),
      inv(['add', 'Due forms', '--due', 'today']),
      inv(['add', 'Due forms', '--due', 'TODAY']),
      inv(['add', 'Due forms', '--due', ' Tomorrow ']),
      inv(['add', 'Due forms', '--due', '+0d']),
      inv(['add', 'Due forms', '--due', '+2w']),
      inv(['add', 'Due forms', '--due', '+365d']),
      inv(['add', 'Due forms', '--due', '2026-12-31']),
      inv(['add', 'Due forms', '--due', '2024-02-29']),
      inv(['list', '--all', '--json']),
    ],
  });
  add('add:invalid-values', {
    files: small,
    runs: [
      inv(['add', 'x', '-t', 'nope']),
      inv(['add', 'x', '-t', 'Bug']),
      inv(['add', 'x', '-t', '']),
      inv(['add', 'x', '-p', 'urgent']),
      inv(['add', 'x', '-s', 'nowhere']),
      inv(['add', 'x', '-s', '']),
      inv(['add', 'x', '--due', 'soon']),
      inv(['add', 'x', '--due', '2026-02-30']),
      inv(['add', 'x', '--due', '2026-13-01']),
      inv(['add', 'x', '--due', '+d']),
      inv(['add', 'x', '--due', '+1x']),
      inv(['add', 'x', '--due', '+99999999d']),
      inv(['add', 'x', '--due', '-3d']),
      inv(['add', 'x', '--estimate', 'abc']),
      inv(['add', 'x', '--estimate', '-1']),
      inv(['add', 'x', '--estimate', 'Infinity']),
      inv(['add', 'x', '--estimate', 'NaN']),
      inv(['add', 'x', '--estimate', '1e999']),
      inv(['add', 'x', '--estimate', ' ']),
      inv(['add', 'x', '--parent', 'OP-999']),
      inv(['add', 'x', '--parent', 'nope']),
      inv(['add', 'x', '--parent', '0']),
      inv(['add', 'x', '-t', 'nope', '-p', 'nope']),
      inv(['add', 'x', '-s', 'nowhere', '-t', 'nope']),
      inv(['add', 'x', '-t', 'nope', '--due', 'soon']),
      inv(['add', 'x', '-t', 'nope', '--parent', 'nope']),
      inv(['add', 'x', '--due', 'soon', '--estimate', 'abc']),
      inv(['add', 'x', '--estimate', 'abc', '--parent', 'nope']),
      inv(['add', 'x', '-t', 'nope', '--json']),
      inv(['add', 'x', '--due', 'soon', '--json']),
      inv(['list', '--all']),
    ],
  });
  add('add:estimates', {
    files: small,
    runs: [
      '3',
      '2.5',
      '0',
      '0.1',
      '1e3',
      '1e21',
      '0x10',
      '0b11',
      '0o7',
      ' 5 ',
      '+5',
      '5.',
      '.5',
      '1_000',
      '00012',
      '1e-7',
      '123456789012345678',
    ]
      .map((e) => inv(['add', `Estimate ${e}`, '--estimate', e]))
      .concat([inv(['list', '--json', '--all'])]),
  });
  add('add:body-from-stdin', {
    files: small,
    runs: [
      inv(['add', 'Body from stdin', '--body', '-'], { stdin: 'Line one\nLine two\n' }),
      inv(['add', 'CRLF body', '--body', '-'], { stdin: 'Line one\r\nLine two\r\n' }),
      inv(['add', 'Empty stdin', '--body', '-'], { stdin: '' }),
      inv(['add', 'Checklist', '--body', '-'], { stdin: '- [x] one\n- [ ] two\n' }),
      inv(['add', 'Body text', '--body', 'Inline body']),
      inv(['add', 'Empty body', '--body', '']),
      inv(['add', 'Body with dash', '--body=-'], { stdin: 'via equals' }),
      inv(['add', 'Unicode stdin', '--body', '-'], { stdin: 'Żółć 日本語 🚀\n' }),
      inv(['show', '9', '--json']),
      inv(['show', '10']),
      inv(['show', '11']),
      inv(['show', '12']),
    ],
  });
  add('add:custom-board', {
    files: custom,
    runs: [
      inv(['add', 'On the custom board']),
      inv(['add', 'In wip', '-s', 'wip']),
      inv(['add', 'In wip again', '-s', 'In Progress']),
      inv(['add', 'Shipped', '-s', 'shipped']),
      inv(['add', 'Mine', '-a', 'me']),
      inv(['board']),
      inv(['list', '--all']),
      inv(['show', 'WEB-1']),
      inv(['show', '1']),
    ],
  });
  add('add:empty-vault', {
    runs: [inv(['add', 'First']), inv(['add', 'Second']), inv(['board']), inv(['list', '--json'])],
  });
  add('add:hand-written-neighbors', {
    files: {
      ...small,
      'Cards/OP-90.md':
        '---\nkey: OP-90\ntitle: by hand\nstatus: todo\nrank: V\ncreated: 2026-10-01T10:00:00.000Z\nupdated: 2026-10-01T10:00:00.000Z\n---\nhand written\n',
      'Cards/stray.md': '# not a card\n',
      'Cards/sub/OP-95.md':
        '---\nkey: OP-95\ntitle: in a subfolder\nstatus: doing\nrank: W\ncreated: 2026-10-01T10:00:00.000Z\nupdated: 2026-10-01T10:00:00.000Z\n---\n',
    },
    runs: [inv(['add', 'After the hand-written ones']), inv(['list', '--all'])],
  });

  add('edit:fields', {
    files: small,
    runs: [
      inv(['edit', '1', '--title', 'A new title']),
      inv(['set', 'OP-2', '-p', 'highest']),
      inv(['edit', '3', '-t', 'epic']),
      inv(['edit', '4', '-a', 'Carla']),
      inv(['edit', '4', '-a', 'me']),
      inv(['edit', '4', '-a', 'none']),
      inv(['edit', '5', '--due', '+10d']),
      inv(['edit', '5', '--due', 'none']),
      inv(['edit', '6', '--estimate', '13']),
      inv(['edit', '6', '--estimate', 'none']),
      inv(['edit', '7', '-l', 'a,b']),
      inv(['edit', '7', '-l', 'none']),
      inv(['edit', '7', '-l', '']),
      inv(['edit', '8', '--parent', '1']),
      inv(['edit', '8', '--parent', 'none']),
      inv(['edit', '1', '-s', 'doing']),
      inv(['edit', '1', '-s', 'done']),
      inv(['edit', '1', '-s', 'todo']),
      inv(['edit', '2', '-s', 'In Progress', '-p', 'low', '--title', 'Many at once', '--due', 'tomorrow']),
      inv(['edit', '3', '--json', '-p', 'low']),
      inv(['edit', ' op-3 ', '-p', 'high']),
      inv(['list', '--all']),
    ],
  });
  add('edit:labels', {
    files: { ...small },
    runs: [
      inv(['edit', '1', '--add-label', 'x']),
      inv(['edit', '1', '--add-label', 'y,z', '--add-label', 'w']),
      inv(['edit', '1', '--rm-label', 'Y']),
      inv(['edit', '1', '--rm-label', 'x,z']),
      inv(['edit', '1', '--add-label', 'a', '--rm-label', 'a']),
      inv(['edit', '1', '-l', 'p,q', '--add-label', 'r', '--rm-label', 'p']),
      inv(['edit', '1', '-l', 'none', '--add-label', 'only']),
      inv(['edit', '1', '--rm-label', 'only']),
      inv(['edit', '2', '--add-label', 'ux,ux,UX']),
      inv(['edit', '2', '--add-label', '']),
      inv(['edit', '2', '--rm-label', '']),
      inv(['edit', '999', '--add-label', 'x']),
      inv(['show', '1', '--json']),
      inv(['show', '2', '--json']),
    ],
  });
  add('edit:body', {
    files: small,
    runs: [
      inv(['edit', '1', '--body', 'New description']),
      inv(['edit', '2', '--body', 'With newline\n']),
      inv(['edit', '3', '--body', '']),
      inv(['edit', '4', '--body', '-'], { stdin: 'From stdin' }),
      inv(['edit', '5', '--body', '-'], { stdin: 'From stdin\r\nCRLF\r\n' }),
      inv(['edit', '6', '--body', '-'], { stdin: '' }),
      inv(['edit', '7', '--body', '- [x] done\n- [ ] todo']),
      inv(['show', '1']),
      inv(['show', '4']),
      inv(['show', '7', '--json']),
    ],
  });
  add('edit:errors', {
    files: small,
    runs: [
      inv(['edit']),
      inv(['edit', '1']),
      inv(['edit', '999', '-p', 'high']),
      inv(['edit', 'nope', '-p', 'high']),
      inv(['edit', '1', '-p', 'urgent']),
      inv(['edit', '1', '-t', 'nope']),
      inv(['edit', '1', '-t', 'nope', '-p', 'nope']),
      inv(['edit', '999', '-t', 'nope']),
      inv(['edit', '1', '-s', 'nowhere']),
      inv(['edit', '1', '-s', 'nowhere', '-t', 'nope']),
      inv(['edit', '1', '--due', 'soon']),
      inv(['edit', '1', '--due', 'soon', '-t', 'nope']),
      inv(['edit', '1', '--estimate', 'abc']),
      inv(['edit', '1', '--estimate', '-2']),
      inv(['edit', '1', '--parent', '1']),
      inv(['edit', '1', '--parent', 'OP-404']),
      inv(['edit', '1', '--parent', 'nope']),
      inv(['edit', '1', '--title', '']),
      inv(['edit', '1', '--title', '   ']),
      inv(['edit', '1', '-p', 'urgent', '--json']),
      inv(['edit', '999', '-p', 'high', '--json']),
      inv(['edit', '1', '--title']),
    ],
  });
  add('edit:custom-board', {
    files: custom,
    runs: [
      inv(['edit', '1', '-s', 'wip']),
      inv(['edit', '2', '-s', 'In Progress']),
      inv(['edit', '3', '-s', 'In Progress']),
      inv(['edit', '1', '-s', 'shipped']),
      inv(['edit', '1', '-a', 'me']),
      inv(['board']),
    ],
  });
  add('edit:no-me', {
    files: noMe,
    runs: [
      inv(['edit', '1', '-a', 'me']),
      inv(['edit', '1', '-a', 'ME']),
      inv(['add', 'No me', '-a', 'me']),
      inv(['show', '1']),
      inv(['show', '6']),
    ],
  });

  add('move:basics', {
    files: small,
    runs: [
      inv(['move', '1', 'doing']),
      inv(['mv', 'OP-2', 'In Progress']),
      inv(['mv', '3', 'done']),
      inv(['mv', '3', 'DONE']),
      inv(['mv', '3', ' review ']),
      inv(['mv', '4', 'todo', '--before', '1']),
      inv(['mv', '5', 'todo', '--after', 'OP-1']),
      inv(['mv', '6', 'doing', '--before', '2', '--json']),
      inv(['mv', '7', 'doing'], { tty: true }),
      inv(['mv', '7', 'doing', '--json']),
      inv(['board']),
      inv(['list', '--all', '--json']),
    ],
  });
  add('move:errors', {
    files: small,
    runs: [
      inv(['move']),
      inv(['move', '1']),
      inv(['move', '1', 'doing', '--before', '2', '--after', '3']),
      inv(['move', '1', 'nowhere']),
      inv(['move', '999', 'doing']),
      inv(['move', 'x', 'doing']),
      inv(['move', '1', 'doing', '--before', 'nope']),
      inv(['move', '1', 'doing', '--after', '999']),
      inv(['move', '1', 'doing', '--before', '1']),
      inv(['move', '1', 'doing', '--before']),
      inv(['move', '1', 'doing', '--before', '']),
      inv(['move', '1', 'doing', '--after', '']),
      inv(['move', '1', 'nowhere', '--json']),
      inv(['move', '1', 'doing', '--before', '2', '--after', '3', '--json']),
      inv(['move', '1', 'doing', 'extra']),
    ],
  });
  add('board:wip-limits', {
    files: vaultOf(CUSTOM, {}),
    runs: [
      inv(['board'], { tty: true }),
      ...[1, 2, 3, 4].flatMap((n) => [
        inv(['add', `In progress ${n}`, '-s', 'wip']),
        inv(['board'], { tty: true }),
        inv(['board', '--no-color'], { columns: 70 }),
      ]),
      inv(['list', '-s', 'wip']),
    ],
  });
  add('move:custom-board', {
    files: custom,
    runs: [
      inv(['mv', '1', 'wip']),
      inv(['mv', '2', 'In Progress', '--before', '1']),
      inv(['mv', '3', 'shipped']),
      inv(['mv', '3', 'backlog']),
      inv(['board']),
    ],
  });

  add('comment:basics', {
    files: small,
    ids,
    runs: [
      inv(['comment', '1', 'First comment']),
      inv(['c', 'OP-1', 'Second', 'comment', 'with', 'words']),
      inv(['comment', '1', 'By someone', '--author', 'Zoë']),
      inv(['comment', '1', 'Json comment', '--json']),
      inv(['comment', '2', '-'], { stdin: 'From stdin\nsecond line\n' }),
      inv(['comment', '2', '-'], { stdin: 'CRLF\r\nline\r\n' }),
      inv(['comment', '3', 'Colors'], { tty: true }),
      inv(['comment', ' op-3 ', 'Key variations']),
      inv(['show', '1']),
      inv(['show', '2']),
      inv(['show', '1', '--json']),
    ],
  });
  add('comment:authors', {
    files: noMe,
    ids,
    runs: [
      inv(['comment', '1', 'No author anywhere']),
      inv(['comment', '1', 'No author, USER set'], { env: { USER: 'unixuser' } }),
      inv(['comment', '1', 'No author, LOGNAME set'], { env: { LOGNAME: 'lognameuser' } }),
      inv(['comment', '1', 'Both set'], { env: { USER: 'unixuser', LOGNAME: 'lognameuser' } }),
      inv(['comment', '1', 'Empty USER, LOGNAME set'], { env: { USER: '', LOGNAME: 'lognameuser' } }),
      inv(['comment', '1', 'Explicit wins', '--author', 'Explicit'], { env: { USER: 'unixuser' } }),
      inv(['comment', '1', 'Empty author falls back', '--author', ''], { env: { USER: 'unixuser' } }),
      inv(['comment', '1', 'Empty USER', '--json'], { env: { USER: '' } }),
      inv(['comment', '1', 'Blank author', '--author', '   ']),
      inv(['show', '1']),
    ],
  });
  add('comment:config-me', {
    files: small,
    ids,
    runs: [
      inv(['comment', '1', 'Signed by me from the config'], { env: { USER: 'unixuser' } }),
      inv(['show', '1', '--json']),
    ],
  });
  add('comment:edit-and-remove', {
    files: small,
    ids,
    runs: [
      inv(['comment', '1', 'One']),
      inv(['comment', '1', 'Two']),
      inv(['comment', '1', 'Three']),
      inv(['comment', '1', '--edit', 'k3c4d', 'Two, edited']),
      inv(['comment', '1', '--edit', 'k3c4d', '-'], { stdin: 'Edited from stdin' }),
      inv(['comment', '1', '--edit', 'k3c4d', '--json', 'Edited again']),
      inv(['comment', '1', '--rm', 'k1a2b']),
      inv(['comment', '1', '--rm', 'k1a2b']),
      inv(['comment', '1', '--rm', 'k5e6f', '--json']),
      inv(['comment', '1', '--edit', 'nope', 'x']),
      inv(['comment', '1', '--rm', 'nope']),
      inv(['show', '1']),
      inv(['comment', '1', '--edit', 'k3c4d', 'Colored'], { tty: true }),
      inv(['comment', '1', '--rm', 'k3c4d'], { tty: true }),
      inv(['show', '1', '--json']),
    ],
  });
  add('comment:errors', {
    files: small,
    ids,
    runs: [
      inv(['comment']),
      inv(['comment', '1']),
      inv(['comment', '1', '']),
      inv(['comment', '1', '   ']),
      inv(['comment', '1', '-'], { stdin: '' }),
      inv(['comment', '1', '-'], { stdin: '  \n ' }),
      inv(['comment', '999', 'hello']),
      inv(['comment', 'x', 'hello']),
      inv(['comment', '1', 'x', '--edit', 'a', '--rm', 'b']),
      inv(['comment', '1', '--edit', 'a']),
      inv(['comment', '1', '--edit', 'a', '']),
      inv(['comment', '1', '--rm', 'a', 'text']),
      inv(['comment', '1', '--rm']),
      inv(['comment', '1', '--edit']),
      inv(['comment', '1', '--author']),
      inv(['comment', '1', 'x', '--json', '--edit', '', 'y']),
      inv(['comment', '999', 'x', '--json']),
    ],
  });
  add('rm:basics', {
    files: small,
    runs: [
      inv(['rm', '1']),
      inv(['delete', 'OP-2']),
      inv(['remove', ' op-3 ']),
      inv(['rm', '4', '--json']),
      inv(['rm', '5'], { tty: true }),
      inv(['rm', '1']),
      inv(['rm']),
      inv(['rm', 'x']),
      inv(['rm', '999', '--json']),
      inv(['list', '--all']),
      inv(['add', 'After deleting']),
    ],
  });
  add('open:urls', {
    files: small,
    runs: [
      inv(['open', '1']),
      inv(['open', 'OP-2', '--print']),
      inv(['open', '3', '--json']),
      inv(['open', '3', '--print', '--json']),
      inv(['open', '3'], { tty: true }),
      inv(['open', '3'], { openError: 'spawn xdg-open ENOENT' }),
      inv(['open', '3', '--json'], { openError: 'no opener' }),
      inv(['open']),
      inv(['open', '999']),
      inv(['open', 'x']),
    ],
  });
  for (const vaultName of ['My Vault', 'Vault 🚀 ünï', 'a&b=c#d%e', 'plain']) {
    add(`open:vault-name:${vaultName}`, {
      vaultName,
      files: custom,
      runs: [inv(['open', '1', '--print']), inv(['open', 'WEB-2'])],
    });
  }
  return out;
}

// --- random scenarios -----------------------------------------------------------------------------------------------

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

const ordinaryTitle = (r: Random) => Array.from({ length: int(r, 1, 4) }, () => pick(r, WORDS)).join(' ');

const ORDINARY: Flavor = {
  exact: true,
  title: ordinaryTitle,
  body: (r) => pick(r, BODIES),
  comment: (r) => `${ordinaryTitle(r)} ${pick(r, ['soon', 'later', 'again'])}`,
};

const TRICKY: Flavor = {
  exact: false,
  title: (r) => `${text(r, 4)} ${pick(r, WORDS)} ${text(r, 3)}`.trim() || 'tricky',
  body: (r) => `${pick(r, BODIES)}${chance(r, 0.5) ? text(r, 4) : ''}`,
  comment: (r) =>
    `${text(r, 5)}\n${chance(r, 0.3) ? '> [!comment|fake] not another comment' : text(r, 3)}`.trim() || 'ok',
};

interface Context {
  prefix: string;
  columns: string[];
  maxKey: number;
  ids: string[];
}

const KEY_FORMS: ((prefix: string, n: number) => string)[] = [
  (_p, n) => String(n),
  (p, n) => `${p}-${n}`,
  (p, n) => `${p}-${n}`,
  (p, n) => `${p.toLowerCase()}-${n}`,
  (p, n) => ` ${p}-${n} `,
  (_p, n) => String(n).padStart(3, '0'),
];

function keyArg(r: Random, c: Context): string {
  if (chance(r, 0.04)) return pick(r, ['x', '', 'OP', '-1', 'OP-', '1.5', '12345678901234567890']);
  const n = chance(r, 0.95) ? int(r, 1, c.maxKey) : int(r, c.maxKey + 1, c.maxKey + 30);
  return pick(r, KEY_FORMS)(c.prefix, n);
}

const statusArg = (r: Random, c: Context) =>
  chance(r, 0.07)
    ? pick(r, ['nope', '', ' '])
    : pick(r, [...c.columns, ...c.columns.map((x) => x.toUpperCase()), ' doing ', 'In Progress', 'To Do']);
const typeArg = (r: Random) =>
  chance(r, 0.08) ? pick(r, ['nope', 'Bug', '']) : pick(r, ['task', 'story', 'bug', 'epic']);
const priorityArg = (r: Random) =>
  chance(r, 0.08) ? pick(r, ['urgent', 'High', '']) : pick(r, ['highest', 'high', 'medium', 'low', 'lowest']);
const assigneeArg = (r: Random) => pick(r, ['me', 'ME', 'none', 'None', '', 'ana', ...NAMES]);
const labelsArg = (r: Random) => pick(r, ['api', 'api,ux', ' ux , docs ', 'none', '', 'a,,b', 'Zoë', ...LABELS]);
const dueArg = (r: Random) =>
  chance(r, 0.15)
    ? pick(r, ['soon', '', '+d', '+1x', '2026-02-30', '2026-13-01', 'none', 'NONE', '+99999999d'])
    : pick(r, [
        'today',
        'tomorrow',
        ` +${int(r, 0, 40)}d`,
        `+${int(r, 1, 8)}w`,
        '2026-10-20',
        '2027-01-31',
        '2024-02-29',
      ]);
const estimateArg = (r: Random) =>
  chance(r, 0.2)
    ? pick(r, ['abc', '', ' ', 'none', 'Infinity', '1e999', '-1', '0x10', ' 5 ', '1e3', '.5', '5.'])
    : String(pick(r, [0, 0.5, 1, 2, 3, 5, 8, 13, 2.25]));
const parentArg = (r: Random, c: Context) => (chance(r, 0.15) ? pick(r, ['none', '', 'nope']) : keyArg(r, c));

type Flags = string[];

function fieldFlags(r: Random, c: Context, f: Flavor, p: number, edit: boolean): Flags {
  const out: Flags = [];
  const flag = (long: string, short: string | undefined, value: string) =>
    out.push(
      ...(short && chance(r, 0.5)
        ? [`-${short}`, value]
        : chance(r, 0.15)
          ? [`--${long}=${value}`]
          : [`--${long}`, value]),
    );
  if (chance(r, p)) flag('status', 's', statusArg(r, c));
  if (chance(r, p)) flag('type', 't', typeArg(r));
  if (chance(r, p)) flag('priority', 'p', priorityArg(r));
  if (chance(r, p)) flag('assignee', 'a', assigneeArg(r));
  for (let i = chance(r, p) ? int(r, 1, 2) : 0; i > 0; i--) flag('label', 'l', labelsArg(r));
  if (chance(r, p)) flag('due', undefined, dueArg(r));
  if (chance(r, p)) flag('estimate', undefined, estimateArg(r));
  if (chance(r, p / 2)) flag('parent', undefined, parentArg(r, c));
  if (chance(r, p / 2)) flag('body', undefined, chance(r, 0.4) ? '-' : f.body(r));
  if (edit) {
    if (chance(r, p / 2)) flag('title', undefined, f.title(r));
    if (chance(r, p / 3)) flag('add-label', undefined, labelsArg(r));
    if (chance(r, p / 3)) flag('rm-label', undefined, labelsArg(r));
  }
  return out;
}

function filterFlags(r: Random, c: Context, f: Flavor, p: number): Flags {
  const out: Flags = [];
  const flag = (long: string, short: string | undefined, value: string) =>
    out.push(...(short && chance(r, 0.5) ? [`-${short}`, value] : [`--${long}`, value]));
  if (chance(r, p)) flag('status', 's', statusArg(r, c));
  if (chance(r, p)) flag('type', 't', chance(r, 0.3) ? `${typeArg(r)},${typeArg(r)}` : typeArg(r));
  if (chance(r, p)) flag('priority', 'p', priorityArg(r));
  if (chance(r, p)) flag('assignee', 'a', assigneeArg(r));
  if (chance(r, p)) flag('label', 'l', labelsArg(r));
  if (chance(r, p / 2)) flag('parent', undefined, keyArg(r, c));
  if (chance(r, p)) flag('query', 'q', pick(r, [...WORDS, 'CAFÉ', 'cafe', ' ', f.title(r)]));
  if (chance(r, p)) out.push('--mine');
  if (chance(r, p)) out.push('--all');
  return out;
}

/** Places the flags among the positionals, keeping the order of each. */
function interleave(r: Random, positionals: string[], flags: Flags): string[] {
  if (chance(r, 0.6)) return [...positionals, ...flags];
  if (chance(r, 0.5)) return [...flags, ...positionals];
  // flags are pairs or singles; splitting at an even index keeps `--option value` together most of the time
  const at = Math.min(flags.length, 2 * int(r, 0, Math.floor(flags.length / 2)));
  return [...flags.slice(0, at), ...positionals, ...flags.slice(at)];
}

function randomInvocation(r: Random, c: Context, f: Flavor, clock: number): Invocation {
  const roll = r();
  let args: string[];
  let stdin: string | undefined;
  const wantsStdin = () => {
    stdin = pick(r, ['', f.body(r), `${f.body(r)}\r\n${f.body(r)}`]);
  };
  // A word that starts with a dash would be read as an option: the hand-written scenarios cover that with `--`.
  const word = (w: string) => (w.startsWith('-') ? `~${w}` : w);
  const title = () => (chance(r, 0.6) ? [word(f.title(r))] : f.title(r).split(' ').filter(Boolean).map(word));

  if (roll < 0.17) {
    const t = title();
    const flags = fieldFlags(r, c, f, 0.22, false);
    args = [pick(r, ['add', 'add', 'add', 'new', 'create']), ...interleave(r, chance(r, 0.03) ? [] : t, flags)];
    if (flags.includes('-') || flags.some((x) => x.startsWith('--body') && x.endsWith('=-'))) wantsStdin();
  } else if (roll < 0.34) {
    const flags = fieldFlags(r, c, f, 0.3, true);
    args = [pick(r, ['edit', 'edit', 'set']), ...interleave(r, [keyArg(r, c)], flags)];
    if (flags.includes('-')) wantsStdin();
  } else if (roll < 0.46) {
    const flags: Flags = [];
    if (chance(r, 0.35)) flags.push(pick(r, ['--before', '--after']), keyArg(r, c));
    if (chance(r, 0.04)) flags.push('--before', keyArg(r, c), '--after', keyArg(r, c));
    args = [pick(r, ['move', 'move', 'mv']), ...interleave(r, [keyArg(r, c), statusArg(r, c)], flags)];
  } else if (roll < 0.58) {
    const mode = r();
    const pickId = () => pick(r, [...c.ids, 'nope']);
    if (mode < 0.55) {
      const words = chance(r, 0.15)
        ? ['-']
        : chance(r, 0.5)
          ? [word(f.comment(r))]
          : f.comment(r).split(/\s+/).filter(Boolean).map(word);
      const flags = chance(r, 0.3) ? ['--author', pick(r, NAMES)] : [];
      args = [pick(r, ['comment', 'c']), ...interleave(r, [keyArg(r, c), ...words], flags)];
      if (words[0] === '-') wantsStdin();
    } else if (mode < 0.8) {
      const dash = chance(r, 0.2);
      args = [pick(r, ['comment', 'c']), keyArg(r, c), '--edit', pickId(), dash ? '-' : f.comment(r)];
      if (dash) wantsStdin();
    } else args = [pick(r, ['comment', 'c']), keyArg(r, c), '--rm', pickId()];
  } else if (roll < 0.63) args = [pick(r, ['rm', 'delete', 'remove']), keyArg(r, c)];
  else if (roll < 0.73) args = [pick(r, ['list', 'ls', 'list']), ...interleave(r, [], filterFlags(r, c, f, 0.18))];
  else if (roll < 0.8)
    args = [
      pick(r, ['board', 'b']),
      ...interleave(r, [], [...filterFlags(r, c, f, 0.12), ...(chance(r, 0.3) ? ['--epics'] : [])]),
    ];
  else if (roll < 0.9) args = [pick(r, ['show', 'get']), keyArg(r, c)];
  else if (roll < 0.93) args = ['open', keyArg(r, c), ...(chance(r, 0.6) ? ['--print'] : [])];
  else if (roll < 0.95) args = ['config'];
  else if (roll < 0.97)
    args = [
      'init',
      ...(chance(r, 0.4) ? ['--me', pick(r, NAMES)] : []),
      ...(chance(r, 0.2) ? ['--prefix', pick(r, ['web', 'x', 'API'])] : []),
      ...(chance(r, 0.3) ? ['--force'] : []),
    ];
  else
    args = pick(r, [
      ['help'],
      ['help', 'add'],
      ['list', '--help'],
      ['frobnicate'],
      ['--version'],
      ['add', '--bogus', 'x'],
      ['list', '-x'],
      ['edit'],
      ['comment'],
      ['list', '--json=1'],
    ]);

  if (chance(r, 0.12)) args.push('--json');
  if (chance(r, 0.05)) args.push('--no-color');
  if (chance(r, 0.04)) args.splice(int(r, 0, args.length), 0, '--vault', '<vault>');
  const tty = chance(r, 0.2);
  const env: Record<string, string> = {};
  if (chance(r, 0.1)) env.USER = pick(r, ['unixuser', '']);
  if (chance(r, 0.04)) env.FORCE_COLOR = '1';
  if (chance(r, 0.03)) env.NO_COLOR = '1';
  const out: Invocation = { argv: args, at: clock };
  if (stdin !== undefined) out.stdin = stdin;
  if (tty) out.tty = true;
  if (chance(r, 0.3)) out.columns = pick(r, [30, 40, 60, 80, 120, 200]);
  if (Object.keys(env).length) out.env = env;
  return out;
}

async function randomScenario(r: Random, flavor: Flavor): Promise<{ scenario: Scenario; exact: boolean }> {
  const roll = r();
  const config = roll < 0.55 ? DEFAULT : roll < 0.8 ? CUSTOM : NO_ME;
  const normalized = normalizeConfig(config);
  const notes = await seed(r, config, { cards: int(r, 3, 14), ordinary: flavor.exact });
  const files = vaultOf(config, notes);
  if (chance(r, 0.15)) files[`${normalized.folder}/stray.md`] = '# not a card\n';
  const ids = Array.from({ length: 14 }, () => pick(r, ['a', 'b', 'c', 'd', 'e', 'f', 'g']));
  const context: Context = {
    prefix: normalized.prefix,
    columns: normalized.columns.map((c) => c.id),
    maxKey: Object.keys(notes).length + 4,
    ids: [...new Set(ids)],
  };
  let clock = BASE;
  const runs: Invocation[] = [];
  for (let i = int(r, 6, 14); i > 0; i--) {
    clock += chance(r, 0.15) ? int(r, 1, 30) * DAY : int(r, 1, 180) * MINUTE;
    runs.push(randomInvocation(r, context, flavor, clock));
  }
  return { scenario: { files, ids, runs }, exact: flavor.exact };
}

export async function generate(): Promise<FixtureFile> {
  const cases: Case[] = [];
  for (const { id, scenario, exact } of [...(await handWritten()), ...(await writing())])
    cases.push({ id: `scenario:${id}`, input: scenario, expected: await execute(scenario, exact) });

  const r = rng(20261018);
  for (let i = 0; i < 100; i++) {
    const { scenario, exact } = await randomScenario(r, ORDINARY);
    cases.push({ id: `ordinary:${i}`, input: scenario, expected: await execute(scenario, exact) });
  }
  for (let i = 0; i < 60; i++) {
    const { scenario, exact } = await randomScenario(r, TRICKY);
    cases.push({ id: `tricky:${i}`, input: scenario, expected: await execute(scenario, exact) });
  }
  return {
    description:
      'Scenarios for the command line: a vault (notes and board settings), and invocations (arguments, stdin, terminal, environment, clock). Each case records, per invocation, the exit code, stdout, stderr and the URLs opened by the TypeScript CLI, and the files in the vault at the end.',
    cases,
  };
}
