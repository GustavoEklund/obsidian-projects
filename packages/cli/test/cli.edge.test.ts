import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDate } from '@oprojects/core';
import pkg from '../package.json';
import { VERSION, parseDue, run, type IO } from '../src/run';

vi.setConfig({ testTimeout: 30_000 });

const ESC = String.fromCharCode(27);
const NOW = new Date(2026, 9, 14, 12, 0, 0); // local time: 2026-10-14

let vault: string;
let opened: string[];

interface Options {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string | Error;
  columns?: number;
  isTTY?: boolean;
  now?: Date;
  openUrl?: (url: string) => Promise<void>;
}

async function cli(argv: string[], options: Options = {}) {
  let out = '';
  let err = '';
  const io: IO = {
    cwd: options.cwd ?? vault,
    env: options.env ?? {},
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    readStdin: async () => {
      if (options.stdin instanceof Error) throw options.stdin;
      return options.stdin ?? '';
    },
    isTTY: options.isTTY ?? false,
    columns: options.columns ?? 100,
    now: () => options.now ?? NOW,
    openUrl: options.openUrl ?? (async (u) => void opened.push(u)),
  };
  const code = await run(argv, io);
  return { code, out, err };
}

const ok = async (argv: string[], options?: Options) => {
  const r = await cli(argv, options);
  expect({ argv, code: r.code, err: r.err }).toEqual({ argv, code: 0, err: '' });
  return r;
};
const json = async (argv: string[], options?: Options) => JSON.parse((await ok([...argv, '--json'], options)).out);
const keysOf = (value: object) => Object.keys(value).sort();

beforeEach(async () => {
  vault = await mkdtemp(path.join(tmpdir(), 'oprojects-edge-'));
  await mkdir(path.join(vault, '.obsidian'));
  opened = [];
});
afterEach(() => rm(vault, { recursive: true, force: true }));

describe('help and version', () => {
  const COMMANDS = ['add', 'list', 'board', 'show', 'comment', 'move', 'edit', 'rm', 'open', 'config', 'init'];

  it('prints the top-level help with no arguments, `help`, `--help` and `-h`, exit 0, nothing on stderr', async () => {
    const outputs = await Promise.all([[], ['help'], ['--help'], ['-h']].map((argv) => ok(argv).then((r) => r.out)));
    for (const out of outputs) {
      expect(out).toContain(`oprojects ${VERSION}`);
      for (const name of COMMANDS) expect(out).toContain(name);
      expect(out).toContain('--vault');
      expect(out).toContain('--json');
      expect(out).toContain('--no-color');
    }
    expect(new Set(outputs).size).toBe(1);
  });

  it('prints per-command help for every command, with its usage line and examples where it has them', async () => {
    for (const name of COMMANDS) {
      for (const argv of [
        ['help', name],
        [name, '--help'],
        [name, '-h'],
      ]) {
        const { out } = await ok(argv);
        expect(out).toContain(`${name} —`);
        expect(out).toContain(`oprojects ${name}`);
        expect(out).toContain('Global options');
      }
    }
    expect((await ok(['add', '--help'])).out).toContain('Examples');
    expect((await ok(['config', '--help'])).out).not.toContain('Examples');
  });

  it('answers `help <alias>` and `help <unknown>` without failing', async () => {
    expect((await ok(['help', 'ls'])).out).toContain('list —');
    expect((await ok(['help', 'mv'])).out).toContain('move —');
    expect((await ok(['help', 'nonsense'])).out).toContain('Commands');
  });

  it('prints the version from package.json for --version and -v', async () => {
    for (const flag of ['--version', '-v']) expect((await ok([flag])).out).toBe(`${pkg.version}\n`);
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('shows help even outside a vault: it never looks for one', async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'oprojects-novault-'));
    try {
      expect((await ok(['--help'], { cwd: elsewhere })).out).toContain('Commands');
      expect((await ok(['add', '--help'], { cwd: elsewhere })).out).toContain('add —');
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('aliases', () => {
  it.each([
    ['new', 'add'],
    ['create', 'add'],
    ['ls', 'list'],
    ['b', 'board'],
    ['get', 'show'],
    ['c', 'comment'],
    ['mv', 'move'],
    ['set', 'edit'],
    ['delete', 'rm'],
    ['remove', 'rm'],
  ])('`%s` is `%s`', async (alias, name) => {
    expect((await ok([alias, '--help'])).out).toBe((await ok([name, '--help'])).out);
  });

  it('every alias really runs its command', async () => {
    expect((await ok(['new', 'via new'])).out).toContain('OP-1');
    expect((await ok(['create', 'via create'])).out).toContain('OP-2');
    expect((await ok(['ls'])).out).toContain('via new');
    expect((await ok(['b'])).out).toContain('TO DO');
    expect((await ok(['get', '1'])).out).toContain('via new');
    expect((await ok(['c', '1', 'hello'], { env: { USER: 'tester' } })).out).toContain('Commented');
    expect((await ok(['mv', '1', 'doing'])).out).toContain('In Progress');
    expect((await ok(['set', '1', '-p', 'high'])).out).toContain('Updated');
    expect((await ok(['delete', '1'])).out).toContain('Deleted');
    expect((await ok(['remove', '2'])).out).toContain('Deleted');
  });
});

describe('unknown commands and parse errors (exit code 2)', () => {
  it('rejects an unknown command, naming it on stderr and printing nothing on stdout', async () => {
    const r = await cli(['frobnicate']);
    expect(r).toMatchObject({ code: 2, out: '' });
    expect(r.err).toContain('unknown command "frobnicate"');
    expect(r.err).toContain('oprojects --help');
  });

  it('rejects unknown flags, a flag without its value, and options of another command, pointing at the help', async () => {
    const cases: [string[], string][] = [
      [['ls', '--nope'], 'list'], // the hint names the command, not the alias that was typed
      [['add', 'x', '-t'], 'add'],
      [['add', 'x', '--due'], 'add'],
      [['show', '1', '--print'], 'show'],
      [['list', '--epics'], 'list'],
      [['move', '1', 'doing', '--bogus', 'x'], 'move'],
      [['board', '-z'], 'board'],
    ];
    for (const [argv, name] of cases) {
      const r = await cli(argv);
      expect({ argv, code: r.code }).toEqual({ argv, code: 2 });
      expect(r.err).toContain(`See: oprojects ${name} --help`);
      expect(r.out).toBe('');
    }
  });

  it('reports usage errors on stderr as plain text even with --json (they are not domain errors)', async () => {
    const r = await cli(['add', '--json']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('Missing title');
    expect(r.err).not.toMatch(/^\{/);
  });

  it.each([
    [['add'], 'Missing title'],
    [['show'], 'Missing card key'],
    [['edit'], 'Missing card key'],
    [['rm'], 'Missing card key'],
    [['open'], 'Missing card key'],
    [['comment'], 'Missing card key'],
    [['comment', '1'], 'Missing comment text'],
    [['move'], 'Usage: oprojects move'],
    [['move', '1'], 'Usage: oprojects move'],
    [['edit', '1'], 'Nothing to change'],
    [['move', '1', 'doing', '--before', '2', '--after', '3'], 'either --before or --after'],
    [['comment', '1', 'x', '--rm', 'abc'], '--rm takes no text'],
    [['comment', '1', '--edit', 'a', '--rm', 'b'], 'either --edit or --rm'],
    [['init', '--prefix', 'x'], 'Invalid prefix "X"'],
    [['init', '--prefix', 'WAYTOOLONGPREFIX'], 'Invalid prefix'],
  ])('%j fails with a usage error mentioning "%s"', async (argv, message) => {
    await ok(['add', 'seed']); // so that "Nothing to change" is about the missing options, not a missing card
    const r = await cli(argv);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
  });
});

describe('global options', () => {
  it('accept --json, --no-color and --vault before, between and after the command and its arguments', async () => {
    await ok(['add', 'Placement test']);
    const insideVault = [
      ['--json', 'ls'],
      ['ls', '--json'],
      ['--no-color', '--json', 'ls'],
      ['ls', '--no-color', '--json'],
    ];
    const elsewhere = [
      ['--vault', vault, '--json', 'ls'],
      ['ls', '--vault', vault, '--json'],
      [`--vault=${vault}`, 'ls', '--json'],
      ['ls', '--json', `--vault=${vault}`],
      ['ls', '--json', '--vault', vault],
    ];
    for (const [argv, cwd] of [
      ...insideVault.map((a) => [a, vault] as const),
      ...elsewhere.map((a) => [a, tmpdir()] as const),
    ]) {
      const r = await cli(argv, { cwd });
      expect({ argv, code: r.code }).toEqual({ argv, code: 0 });
      expect(JSON.parse(r.out)).toHaveLength(1);
    }
  });

  it('uses --vault over OPROJECTS_VAULT, and OPROJECTS_VAULT over the working directory', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'oprojects-other-'));
    try {
      await mkdir(path.join(other, '.obsidian'));
      await ok(['add', 'In the main vault']);
      await ok(['add', 'In the other vault'], { cwd: other });
      const titles = async (argv: string[], options: Options) =>
        (await json(argv, options)).map((c: { title: string }) => c.title);
      expect(await titles(['ls'], { cwd: vault })).toEqual(['In the main vault']);
      expect(await titles(['ls'], { cwd: vault, env: { OPROJECTS_VAULT: other } })).toEqual(['In the other vault']);
      expect(await titles(['ls', '--vault', vault], { cwd: other, env: { OPROJECTS_VAULT: other } })).toEqual([
        'In the main vault',
      ]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('finds the vault from a nested working directory', async () => {
    await ok(['add', 'Deep']);
    const deep = path.join(vault, 'Cards', 'a', 'b');
    await mkdir(deep, { recursive: true });
    expect((await json(['ls'], { cwd: deep })).map((c: { key: string }) => c.key)).toEqual(['OP-1']);
  });

  it('fails with exit 1 and a helpful message outside a vault, and as JSON when asked', async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'oprojects-novault-'));
    try {
      const plainFailure = await cli(['ls'], { cwd: elsewhere });
      expect(plainFailure.code).toBe(1);
      expect(plainFailure.err).toContain('No Obsidian vault found');
      expect(plainFailure.err).toContain('OPROJECTS_VAULT');
      const jsonFailure = await cli(['ls', '--json'], { cwd: elsewhere });
      expect(jsonFailure.code).toBe(1);
      expect(JSON.parse(jsonFailure.err)).toEqual({ error: expect.stringContaining('No Obsidian vault found') });
      expect(jsonFailure.out).toBe('');
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('rejects --vault pointing at a folder that is not a vault, naming the folder', async () => {
    const notVault = await mkdtemp(path.join(tmpdir(), 'oprojects-plain-'));
    try {
      const r = await cli(['ls', '--vault', notVault]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(notVault);
      expect(r.err).toContain('not an Obsidian vault');
    } finally {
      await rm(notVault, { recursive: true, force: true });
    }
  });
});

describe('colors', () => {
  it('are off when the output is not a terminal, on for a terminal, and on for FORCE_COLOR', async () => {
    await ok(['add', 'Colorful']);
    expect((await ok(['ls'], { isTTY: false })).out).not.toContain(ESC);
    expect((await ok(['ls'], { isTTY: true })).out).toContain(ESC);
    expect((await ok(['ls'], { isTTY: false, env: { FORCE_COLOR: '1' } })).out).toContain(ESC);
  });

  it('are switched off by --no-color and by NO_COLOR, which beats FORCE_COLOR and a terminal', async () => {
    await ok(['add', 'Colorful']);
    expect((await ok(['ls', '--no-color'], { isTTY: true })).out).not.toContain(ESC);
    expect((await ok(['--no-color', 'ls'], { isTTY: true })).out).not.toContain(ESC);
    expect((await ok(['ls'], { isTTY: true, env: { NO_COLOR: '1' } })).out).not.toContain(ESC);
    expect((await ok(['ls'], { isTTY: true, env: { NO_COLOR: '1', FORCE_COLOR: '1' } })).out).not.toContain(ESC);
  });

  it('never leak into --json output, even on a terminal', async () => {
    await ok(['add', 'Colorful']);
    const r = await ok(['ls', '--json'], { isTTY: true });
    expect(r.out).not.toContain(ESC);
    expect(JSON.parse(r.out)).toHaveLength(1);
    const added = await ok(['add', 'Another', '--json'], { isTTY: true });
    expect(JSON.parse(added.out).key).toBe('OP-2');
  });

  it('colors the help and the messages on a terminal', async () => {
    expect((await ok(['--help'], { isTTY: true })).out).toContain(ESC);
    expect((await ok(['add', 'Pretty'], { isTTY: true })).out).toContain(`${ESC}[32mCreated`);
    const error = await cli(['frobnicate'], { isTTY: true });
    expect(error.err).toContain(`${ESC}[31merror:`);
  });
});

describe('add', () => {
  it('joins every positional into the title and honours every option', async () => {
    await ok(['add', 'Parent']);
    const card = await json([
      'add',
      'Fix',
      'the',
      'login',
      '-t',
      'bug',
      '-p',
      'highest',
      '-s',
      'In Progress',
      '-a',
      'ana',
      '-l',
      'auth',
      '-l',
      'backend,ui',
      '--due',
      '+1w',
      '--estimate',
      '2.5',
      '--parent',
      '1',
      '--body',
      'Steps\n- [ ] one',
    ]);
    expect(card).toMatchObject({
      key: 'OP-2',
      title: 'Fix the login',
      type: 'bug',
      priority: 'highest',
      status: 'doing',
      assignee: 'ana',
      labels: ['auth', 'backend', 'ui'],
      due: '2026-10-21',
      estimate: 2.5,
      parent: 'OP-1',
    });
    expect(card.checklist).toEqual({ done: 0, total: 1 });
    expect(card.body).toContain('Steps');
  });

  it('prints the key, title and the note path in text mode', async () => {
    const { out } = await ok(['add', 'Readable']);
    expect(out).toBe('Created OP-1  Readable\nCards/OP-1.md\n');
  });

  it('resolves "me" for the assignee, using the configured name', async () => {
    await ok(['init', '--me', 'Ana']);
    expect((await json(['add', 'Mine', '-a', 'me'])).assignee).toBe('Ana');
    expect((await json(['add', 'Mine too', '-a', 'ME'])).assignee).toBe('Ana');
    expect((await json(['add', 'Literal', '-a', 'bruno'])).assignee).toBe('bruno');
  });

  it('keeps "me" as typed when the board has no configured user', async () => {
    expect((await json(['add', 'Mine', '-a', 'me'])).assignee).toBe('me');
  });

  it('reads the description from stdin with --body -, normalizing CRLF', async () => {
    const card = await json(['add', 'From stdin', '--body', '-'], { stdin: 'line one\r\nline two\r\n' });
    expect(card.body).toContain('line one\nline two');
    expect(card.body).not.toContain('\r');
  });

  it('accepts an empty description from stdin', async () => {
    const card = await json(['add', 'Empty body', '--body', '-'], { stdin: '' });
    expect(card.body).toBe('');
  });

  it('exits 1 when stdin cannot be read, reporting the cause as plain text', async () => {
    const r = await cli(['add', 'x', '--body', '-'], { stdin: new Error('stdin broke') });
    expect(r.code).toBe(1);
    expect(r.err).toContain('stdin broke');
    expect(await readdir(path.join(vault, 'Cards')).catch(() => [])).toEqual([]);
  });

  it.each([
    [['-t', 'chore'], 'Invalid type "chore"'],
    [['-p', 'urgent'], 'Invalid priority "urgent"'],
    [['-s', 'limbo'], 'valid: todo, doing, review, done'],
    [['--due', '2026-02-30'], 'Invalid date "2026-02-30"'],
    [['--due', 'next week'], 'Invalid date "next week"'],
    [['--estimate', 'lots'], 'Invalid estimate "lots"'],
    [['--estimate=-3'], 'Invalid estimate "-3"'],
    [['--parent', '99'], 'Parent card OP-99 does not exist'],
    [['--parent', 'not a key'], 'is not a card key'],
  ])('rejects %j with exit 1 and a message saying "%s", creating nothing', async (flags, message) => {
    const r = await cli(['add', 'Rejected', ...flags]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect((await json(['ls'])).length).toBe(0);
  });

  it('shows the same error as JSON on stderr when --json is on', async () => {
    const r = await cli(['add', 'x', '-p', 'urgent', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err)).toEqual({ error: expect.stringContaining('Invalid priority "urgent"') });
  });

  it('has a stable JSON shape', async () => {
    const card = await json(['add', 'Shape', '-a', 'ana', '-l', 'x', '--due', 'today', '--estimate', '1']);
    expect(keysOf(card)).toEqual([
      'assignee',
      'body',
      'checklist',
      'comments',
      'created',
      'due',
      'estimate',
      'key',
      'labels',
      'path',
      'priority',
      'rank',
      'status',
      'title',
      'type',
      'updated',
    ]);
    expect(card.checklist).toEqual({ done: 0, total: 0 });
    expect(card.comments).toEqual([]);
    const bare = await json(['add', 'Bare']);
    expect(keysOf(bare)).toEqual([
      'body',
      'checklist',
      'comments',
      'created',
      'key',
      'labels',
      'path',
      'priority',
      'rank',
      'status',
      'title',
      'type',
      'updated',
    ]);
  });

  it('timestamps cards with the injected clock', async () => {
    const card = await json(['add', 'Timed'], { now: new Date('2030-05-06T07:08:09.000Z') });
    expect(card.created).toBe('2030-05-06T07:08:09.000Z');
    expect(card.updated).toBe(card.created);
  });

  it('keeps unicode titles and bodies intact', async () => {
    const card = await json(['add', 'Zoë', '日本語', '🙂', '--body', 'ünïcode ✓']);
    expect(card.title).toBe('Zoë 日本語 🙂');
    expect((await json(['show', '1'])).body.trim()).toBe('ünïcode ✓');
  });

  it('treats an empty or "none" estimate as nothing to set (clearing is meant for edit)', async () => {
    expect((await json(['add', 'a', '--estimate', ''])).estimate).toBeUndefined();
    expect((await json(['add', 'b', '--estimate', 'none'])).estimate).toBeUndefined();
  });

  it('reads a negative number after a space as an option, and the message shows the --estimate=-3 form (usage error)', async () => {
    const r = await cli(['add', 'x', '--estimate', '-3']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--estimate=-XYZ');
  });

  it('accepts a title that starts with a dash after `--`', async () => {
    const card = JSON.parse((await ok(['add', '--json', '--', '-dash', 'title'])).out);
    expect(card.title).toBe('-dash title');
  });

  it('keeps the global flags working next to `--`: they never end up inside the title (regression)', async () => {
    // The flags used to be moved to the end of the arguments, i.e. after `--`, where they became part of the title.
    const flagBefore = JSON.parse((await ok(['add', '--json', '--', '-fix', 'login'])).out) as { title: string };
    const flagFirst = JSON.parse((await ok(['--json', 'add', '--', '-fix', 'login'])).out) as { title: string };
    expect([flagBefore.title, flagFirst.title]).toEqual(['-fix login', '-fix login']);
    expect((await ok(['add', '--', '-fix', 'login'])).out).toContain('Created OP-3  -fix login');
    expect((await json(['ls'])).map((c: { title: string }) => c.title)).toEqual([
      '-fix login',
      '-fix login',
      '-fix login',
    ]);
  });

  it('leaves what follows `--` alone, even when it looks like a global flag', async () => {
    const r = await ok(['add', '--', '--json']);
    expect(r.out).toBe('Created OP-1  --json\nCards/OP-1.md\n'); // text, not JSON: "--json" is the literal title
    expect((await json(['ls'])).map((c: { title: string }) => c.title)).toEqual(['--json']);
  });
});

describe('list', () => {
  beforeEach(async () => {
    await ok(['init', '--me', 'Ana']);
    await ok(['add', 'Login bug', '-t', 'bug', '-p', 'high', '-a', 'Ana', '-l', 'auth']);
    await ok(['add', 'Payments story', '-t', 'story', '-s', 'doing', '-a', 'Bruno', '-l', 'pay,api']);
    await ok(['add', 'Epic parent', '-t', 'epic']);
    await ok(['add', 'Child task', '--parent', '3', '-s', 'review']);
    await ok(['add', 'Finished', '-s', 'done']);
  });
  const keys = async (argv: string[]) => (await json(['ls', ...argv])).map((c: { key: string }) => c.key);

  it('filters by every dimension, with long and short flags, repeated or comma separated', async () => {
    expect(await keys(['-s', 'todo'])).toEqual(['OP-1', 'OP-3']);
    expect(await keys(['--status', 'todo', '--status', 'doing'])).toEqual(['OP-1', 'OP-3', 'OP-2']);
    expect(await keys(['-s', 'In Progress'])).toEqual(['OP-2']);
    expect(await keys(['-t', 'bug,story'])).toEqual(['OP-1', 'OP-2']);
    expect(await keys(['--type', 'epic'])).toEqual(['OP-3']);
    expect(await keys(['-p', 'high'])).toEqual(['OP-1']);
    expect(await keys(['-a', 'ana,bruno'])).toEqual(['OP-1', 'OP-2']);
    expect(await keys(['-a', 'none'])).toEqual(['OP-3', 'OP-4', 'OP-5']);
    expect(await keys(['-a', 'me'])).toEqual(['OP-1']);
    expect(await keys(['--mine'])).toEqual(['OP-1']);
    expect(await keys(['-l', 'pay'])).toEqual(['OP-2']);
    expect(await keys(['-l', 'auth', '-l', 'api'])).toEqual(['OP-1', 'OP-2']);
    expect(await keys(['--label', 'API'])).toEqual(['OP-2']);
    expect(await keys(['--parent', '3'])).toEqual(['OP-4']);
    expect(await keys(['--parent', 'op-3'])).toEqual(['OP-4']);
    expect(await keys(['-q', 'PAYMENTS'])).toEqual(['OP-2']);
    expect(await keys(['--query', 'login bug'])).toEqual(['OP-1']);
  });

  it('combines filters with AND and returns an empty list (not an error) when nothing matches', async () => {
    expect(await keys(['-t', 'bug', '-a', 'Ana', '-l', 'auth'])).toEqual(['OP-1']);
    expect(await keys(['-t', 'bug', '-a', 'Bruno'])).toEqual([]);
    expect((await ok(['ls', '-q', 'zzz-no-match'])).out).toBe('No cards.\n');
  });

  it('rejects --mine without a configured user (exit 2), and invalid values (exit 1)', async () => {
    await writeFile(
      path.join(vault, '.obsidian/plugins/obsidian-projects/data.json'),
      JSON.stringify({ board: { prefix: 'OP', me: '' } }),
    );
    const noMe = await cli(['ls', '--mine']);
    expect(noMe.code).toBe(2);
    expect(noMe.err).toContain('--mine needs "me"');
    expect((await cli(['ls', '-a', 'me'])).code).toBe(1);
    const badType = await cli(['ls', '-t', 'chore']);
    expect(badType).toMatchObject({ code: 1 });
    expect(badType.err).toContain('Invalid type "chore"');
    expect((await cli(['ls', '-p', 'urgent'])).err).toContain('Invalid priority "urgent"');
    expect((await cli(['ls', '-s', 'limbo'])).err).toContain('Unknown status "limbo"');
    expect((await cli(['ls', '--parent', 'nonsense'])).code).toBe(1);
  });

  it('hides done cards older than the archive limit unless --all is given', async () => {
    const later = new Date(2027, 5, 1, 12, 0, 0);
    expect((await json(['ls'], { now: later })).map((c: { key: string }) => c.key)).not.toContain('OP-5');
    expect((await json(['ls', '--all'], { now: later })).map((c: { key: string }) => c.key)).toContain('OP-5');
    expect((await json(['ls'], { now: NOW })).map((c: { key: string }) => c.key)).toContain('OP-5');
  });

  it('lists in board order: by column, then by position', async () => {
    expect(await keys([])).toEqual(['OP-1', 'OP-3', 'OP-2', 'OP-4', 'OP-5']);
  });

  it('omits the body and the comments from JSON lists, giving the number of comments instead (stable shape)', async () => {
    await ok(['comment', '1', 'hello']);
    await ok(['comment', '1', 'again']);
    const [first, second] = await json(['ls']);
    expect(keysOf(first)).toEqual([
      'assignee',
      'checklist',
      'commentCount',
      'created',
      'key',
      'labels',
      'path',
      'priority',
      'rank',
      'status',
      'title',
      'type',
      'updated',
    ]);
    expect(first.commentCount).toBe(2);
    expect(second.commentCount).toBe(0);
    expect(first).not.toHaveProperty('body');
    expect(first).not.toHaveProperty('comments');
  });

  it('renders a table in text mode and respects the terminal width for the title', async () => {
    const long = 'A very long card title that goes on and on and on '.repeat(5).trim();
    await ok(['add', long]);
    const wide = (await ok(['ls'], { columns: 200 })).out.split('\n');
    const narrow = (await ok(['ls'], { columns: 60 })).out.split('\n');
    const longLine = (lines: string[]) => lines.find((l) => l.includes('A very long'))!;
    expect(longLine(narrow).length).toBeLessThan(longLine(wide).length);
    expect(longLine(narrow)).toContain('…');
  });
});

describe('board', () => {
  beforeEach(async () => {
    await ok(['init', '--me', 'Ana']);
    await ok(['add', 'Task one']);
    await ok(['add', 'The epic', '-t', 'epic']);
    await ok(['add', 'In flight', '-s', 'doing', '-a', 'Ana']);
  });

  it('hides epics unless --epics is given', async () => {
    expect((await ok(['board'])).out).not.toContain('The epic');
    expect((await ok(['board', '--epics'])).out).toContain('The epic');
  });

  it('applies the list filters', async () => {
    const out = (await ok(['board', '-a', 'Ana'])).out;
    expect(out).toContain('In flight');
    expect(out).not.toContain('Task one');
  });

  it('has a stable JSON shape: one entry per column, in order, with its cards', async () => {
    const board = await json(['board']);
    expect(board.map((c: { column: string }) => c.column)).toEqual(['todo', 'doing', 'review', 'done']);
    expect(keysOf(board[0])).toEqual(['cards', 'column', 'done', 'name'].sort());
    expect(board.map((c: { name: string }) => c.name)).toEqual(['To Do', 'In Progress', 'Review', 'Done']);
    expect(board.map((c: { done: boolean }) => c.done)).toEqual([false, false, false, true]);
    expect(board[0].cards.map((c: { key: string }) => c.key)).toEqual(['OP-1']);
    expect(board[1].cards.map((c: { key: string }) => c.key)).toEqual(['OP-3']);
    expect(board[0].cards[0]).not.toHaveProperty('body');
    expect(board[0].cards[0]).toHaveProperty('commentCount', 0);
  });

  it('includes epics in the JSON only with --epics', async () => {
    const keys = (board: { cards: { key: string }[] }[]) => board.flatMap((c) => c.cards.map((card) => card.key));
    expect(keys(await json(['board']))).toEqual(['OP-1', 'OP-3']);
    expect(keys(await json(['board', '--epics']))).toEqual(['OP-1', 'OP-2', 'OP-3']);
  });

  it('shows the WIP limit of a column in JSON', async () => {
    await writeFile(
      path.join(vault, '.obsidian/plugins/obsidian-projects/data.json'),
      JSON.stringify({
        board: {
          prefix: 'OP',
          columns: [
            { id: 'todo', name: 'To Do' },
            { id: 'doing', name: 'Doing', wip: 1 },
            { id: 'done', name: 'Done', done: true },
          ],
        },
      }),
    );
    const board = await json(['board']);
    expect(board[1]).toMatchObject({ column: 'doing', wip: 1 });
    expect(board[0]).not.toHaveProperty('wip');
  });

  it('stacks the columns on a narrow terminal and shows them side by side on a wide one', async () => {
    const wide = (await ok(['board'], { columns: 120 })).out.split('\n')[0]!;
    const narrow = (await ok(['board'], { columns: 40 })).out.split('\n');
    expect(wide).toMatch(/TO DO.*IN PROGRESS.*REVIEW.*DONE/);
    expect(narrow.filter((l) => /^(TO DO|IN PROGRESS|REVIEW|DONE)/.test(l))).toHaveLength(4);
  });

  it('is fine with an empty board', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'oprojects-empty-'));
    try {
      await mkdir(path.join(empty, '.obsidian'));
      const out = (await ok(['board'], { cwd: empty })).out;
      expect(out.match(/\(empty\)/g)).toHaveLength(4);
      expect((await json(['board'], { cwd: empty })).every((c: { cards: unknown[] }) => c.cards.length === 0)).toBe(
        true,
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('show', () => {
  it('accepts OP-1, op-1, 1 and 001, and prints description, checklist and comments with their ids', async () => {
    await ok(['add', 'Detailed', '--body', 'Some text\n\n- [x] a\n- [ ] b', '-a', 'Ana', '-l', 'x']);
    const added = await json(['comment', '1', 'first comment', '--author', 'Bruno']);
    const id = added.comments[0].id as string;
    for (const form of ['OP-1', 'op-1', '1', '001']) {
      const out = (await ok(['show', form])).out;
      expect(out).toContain('OP-1  Detailed');
      expect(out).toContain('Some text');
      expect(out).toContain('Checklist 1/2');
      expect(out).toContain('Comments (1)');
      expect(out).toContain(`#${id}`);
    }
  });

  it('fails with exit 1 for a card that does not exist and for a malformed key', async () => {
    expect(await cli(['show', '99'])).toMatchObject({ code: 1, err: expect.stringContaining('Card OP-99 not found') });
    expect((await cli(['show', 'nonsense'])).err).toContain('is not a card key');
  });

  it('has a stable JSON shape including the body and the comments', async () => {
    await ok(['add', 'Complete', '-a', 'Ana', '-l', 'x', '--due', 'today', '--estimate', '3', '--body', 'text']);
    await ok(['comment', '1', 'hi', '--author', 'Bruno']);
    const card = await json(['show', '1']);
    expect(keysOf(card)).toEqual([
      'assignee',
      'body',
      'checklist',
      'comments',
      'created',
      'due',
      'estimate',
      'key',
      'labels',
      'path',
      'priority',
      'rank',
      'status',
      'title',
      'type',
      'updated',
    ]);
    expect(keysOf(card.comments[0])).toEqual(['at', 'author', 'id', 'text']);
    expect(card.comments[0]).toMatchObject({ author: 'Bruno', text: 'hi' });
  });
});

describe('comment', () => {
  beforeEach(async () => {
    await ok(['add', 'Talk']);
  });

  it('signs with --author, else the board user, else $USER, else $LOGNAME', async () => {
    const authors = async () => (await json(['show', '1'])).comments.map((c: { author: string }) => c.author);
    await ok(['comment', '1', 'one', '--author', 'Bruno']);
    await ok(['comment', '1', 'two'], { env: { USER: 'systemuser' } });
    await ok(['comment', '1', 'three'], { env: { LOGNAME: 'loginname' } });
    await ok(['comment', '1', 'four'], { env: { USER: 'systemuser', LOGNAME: 'loginname' } });
    await ok(['init', '--me', 'Ana']);
    await ok(['comment', '1', 'five'], { env: { USER: 'systemuser' } });
    expect(await authors()).toEqual(['Bruno', 'systemuser', 'loginname', 'systemuser', 'Ana']);
  });

  it('fails with exit 1 and a clear message when there is nobody to sign as', async () => {
    const r = await cli(['comment', '1', 'who am i?']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Who is commenting?');
    expect((await json(['show', '1'])).comments).toEqual([]);
  });

  it('joins several words into one comment and keeps multi-line text from stdin', async () => {
    await ok(['comment', '1', 'several', 'words', 'here', '--author', 'A']);
    await ok(['comment', '1', '-', '--author', 'A'], { stdin: 'line 1\r\n\r\n- item\r\n' });
    const comments = (await json(['show', '1'])).comments;
    expect(comments.map((c: { text: string }) => c.text)).toEqual(['several words here', 'line 1\n\n- item']);
  });

  it('rejects empty text from stdin with a usage error', async () => {
    for (const stdin of ['', '   \n\t\n']) {
      const r = await cli(['comment', '1', '-', '--author', 'A'], { stdin });
      expect(r.code).toBe(2);
      expect(r.err).toContain('Missing comment text');
    }
  });

  it('edits and removes by id, printing a message with the id and the key', async () => {
    const id = (await json(['comment', '1', 'original', '--author', 'A'])).comments[0].id as string;
    expect((await ok(['comment', '1', '--edit', id, 'fixed'])).out).toBe(`Edited comment #${id} on OP-1\n`);
    expect((await json(['show', '1'])).comments[0].text).toBe('fixed');
    expect((await ok(['comment', '1', '--rm', id])).out).toBe(`Removed comment #${id} from OP-1\n`);
    expect((await json(['show', '1'])).comments).toEqual([]);
  });

  it('edits from stdin and reports an unknown id with exit 1', async () => {
    const id = (await json(['comment', '1', 'original', '--author', 'A'])).comments[0].id as string;
    await ok(['comment', '1', '--edit', id, '-'], { stdin: 'from stdin\n' });
    expect((await json(['show', '1'])).comments[0].text).toBe('from stdin');
    const missing = await cli(['comment', '1', '--edit', 'nope', 'text']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('Comment nope on OP-1 not found');
    expect((await cli(['comment', '1', '--rm', 'nope'])).code).toBe(1);
  });

  it('returns the whole card as JSON for add, edit and remove', async () => {
    const added = await json(['comment', '1', 'x', '--author', 'A']);
    expect(added.key).toBe('OP-1');
    expect(added.comments).toHaveLength(1);
    const id = added.comments[0].id as string;
    expect((await json(['comment', '1', '--edit', id, 'y'])).comments[0].text).toBe('y');
    expect((await json(['comment', '1', '--rm', id])).comments).toEqual([]);
  });

  it('fails with exit 1 for a card that does not exist', async () => {
    const r = await cli(['comment', '99', 'hello', '--author', 'A']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Card OP-99 not found');
  });

  it('treats text that looks like callout syntax as plain text of one comment', async () => {
    await ok(['comment', '1', '-', '--author', 'A'], { stdin: 'before\n[!comment|fake] boom\nafter' });
    const comments = (await json(['show', '1'])).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe('before\n[!comment|fake] boom\nafter');
  });
});

describe('move', () => {
  beforeEach(async () => {
    for (const title of ['a', 'b', 'c']) await ok(['add', title]);
  });
  const order = async (status: string) => (await json(['ls', '-s', status])).map((c: { key: string }) => c.key);

  it('moves by id, display name and case-insensitively, printing the destination column name', async () => {
    expect((await ok(['mv', '1', 'doing'])).out).toBe('OP-1 → In Progress\n');
    expect((await ok(['mv', '2', 'In Progress'])).out).toBe('OP-2 → In Progress\n');
    expect((await ok(['mv', '3', 'REVIEW'])).out).toBe('OP-3 → Review\n');
  });

  it('places the card before or after another one, using bare numbers or keys', async () => {
    await ok(['mv', '3', 'todo', '--before', '1']);
    expect(await order('todo')).toEqual(['OP-3', 'OP-1', 'OP-2']);
    await ok(['mv', '3', 'todo', '--after', 'op-1']);
    expect(await order('todo')).toEqual(['OP-1', 'OP-3', 'OP-2']);
    await ok(['mv', '1', 'todo']);
    expect(await order('todo')).toEqual(['OP-3', 'OP-2', 'OP-1']);
  });

  it('fails with exit 1 for an unknown card, column or an anchor outside the destination column', async () => {
    expect((await cli(['mv', '99', 'doing'])).code).toBe(1);
    const unknown = await cli(['mv', '1', 'limbo']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('valid: todo, doing, review, done');
    await ok(['mv', '2', 'doing']);
    const anchor = await cli(['mv', '1', 'todo', '--before', '2']);
    expect(anchor.code).toBe(1);
    expect(anchor.err).toContain('Card OP-2 is not in column "todo"');
    expect((await cli(['mv', '1', 'doing', '--before', 'nonsense'])).code).toBe(1);
  });

  it('returns the moved card as JSON', async () => {
    const card = await json(['mv', '2', 'done']);
    expect(card).toMatchObject({ key: 'OP-2', status: 'done' });
    expect(card.resolved).toBe(NOW.toISOString());
  });

  it('resolves a card moved to the done column and un-resolves it when moved out', async () => {
    expect((await json(['mv', '1', 'done'])).resolved).toBeDefined();
    expect((await json(['mv', '1', 'todo'])).resolved).toBeUndefined();
  });
});

describe('edit', () => {
  beforeEach(async () => {
    await ok(['add', 'Subject', '-a', 'Ana', '-l', 'one,two', '--due', '2026-12-01', '--estimate', '5']);
    await ok(['add', 'Other']);
  });

  it('changes the requested fields only, reading the due date with relative formats', async () => {
    const card = await json([
      'edit',
      '1',
      '--title',
      'Renamed',
      '-t',
      'bug',
      '-p',
      'low',
      '-s',
      'review',
      '--due',
      '+2w',
      '--estimate',
      '8',
      '--parent',
      '2',
    ]);
    expect(card).toMatchObject({
      title: 'Renamed',
      type: 'bug',
      priority: 'low',
      status: 'review',
      due: '2026-10-28',
      estimate: 8,
      parent: 'OP-2',
      assignee: 'Ana',
      labels: ['one', 'two'],
    });
  });

  it('clears fields with none or an empty value, and labels with -l none', async () => {
    await ok(['edit', '2', '--parent', '1']);
    const card = await json(['edit', '1', '-a', 'none', '--due', 'NONE', '--estimate', 'none', '-l', 'none']);
    expect(card.assignee).toBeUndefined();
    expect(card.due).toBeUndefined();
    expect(card.estimate).toBeUndefined();
    expect(card.labels).toEqual([]);
    expect((await json(['edit', '2', '--parent', 'none'])).parent).toBeUndefined();
    expect((await json(['edit', '1', '--due', 'today'])).due).toBe('2026-10-14');
    expect((await json(['edit', '1', '--due', ''])).due).toBeUndefined();
  });

  it('assigns "me" using the configured name', async () => {
    await ok(['init', '--me', 'Bruno']);
    expect((await json(['edit', '2', '-a', 'me'])).assignee).toBe('Bruno');
  });

  it('adds and removes labels case-insensitively, combining with -l and keeping the rest', async () => {
    expect((await json(['edit', '1', '--add-label', 'three'])).labels).toEqual(['one', 'two', 'three']);
    expect((await json(['edit', '1', '--add-label', 'four,five', '--rm-label', 'ONE'])).labels).toEqual([
      'two',
      'three',
      'four',
      'five',
    ]);
    expect((await json(['edit', '1', '--rm-label', 'two', '--rm-label', 'three'])).labels).toEqual(['four', 'five']);
    expect((await json(['edit', '1', '-l', 'x,y', '--add-label', 'z', '--rm-label', 'x'])).labels).toEqual(['y', 'z']);
    expect((await json(['edit', '1', '--add-label', 'five'])).labels).toEqual(['y', 'z', 'five']);
  });

  it('replaces the description from --body or stdin, and keeps the comments', async () => {
    await ok(['comment', '1', 'stay', '--author', 'A']);
    const viaFlag = await json(['edit', '1', '--body', 'new text']);
    expect(viaFlag.body.trim()).toBe('new text');
    const viaStdin = await json(['edit', '1', '--body', '-'], { stdin: 'from stdin\r\n- [x] done' });
    expect(viaStdin.body.trim()).toBe('from stdin\n- [x] done');
    expect(viaStdin.checklist).toEqual({ done: 1, total: 1 });
    expect(viaStdin.comments.map((c: { text: string }) => c.text)).toEqual(['stay']);
    expect((await json(['edit', '1', '--body', ''])).body.trim()).toBe('');
  });

  it.each([
    [['-t', 'chore'], 'Invalid type'],
    [['-p', 'urgent'], 'Invalid priority'],
    [['-s', 'limbo'], 'Unknown status'],
    [['--due', 'later'], 'Invalid date "later"'],
    [['--estimate', 'x'], 'Invalid estimate "x"'],
    [['--parent', '1'], 'A card cannot be its own parent'],
    [['--parent', '99'], 'Parent card OP-99 does not exist'],
    [['--title', '   '], 'Title cannot be empty'],
  ])('rejects %j with exit 1 ("%s") and leaves the card untouched', async (flags, message) => {
    const before = await readFile(path.join(vault, 'Cards', 'OP-1.md'), 'utf8');
    const r = await cli(['edit', '1', ...flags]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(await readFile(path.join(vault, 'Cards', 'OP-1.md'), 'utf8')).toBe(before);
  });

  it('fails with exit 1 for an unknown card', async () => {
    expect((await cli(['edit', '99', '-p', 'high'])).code).toBe(1);
    expect((await cli(['edit', '99', '--add-label', 'x'])).code).toBe(1);
  });

  it('prints a short confirmation in text mode', async () => {
    expect((await ok(['edit', '1', '-p', 'low'])).out).toBe('Updated OP-1  Subject\n');
  });
});

describe('rm', () => {
  it('moves the note to .trash, prints what it did, and the card is gone', async () => {
    await ok(['add', 'Doomed']);
    const r = await ok(['rm', '1']);
    expect(r.out).toBe('Deleted OP-1  Doomed (in .trash)\n');
    expect(await readFile(path.join(vault, '.trash', 'OP-1.md'), 'utf8')).toContain('title: Doomed');
    expect(await json(['ls'])).toEqual([]);
    expect((await cli(['rm', '1'])).code).toBe(1);
  });

  it('gives a list-shaped JSON card (no body, comment count)', async () => {
    await ok(['add', 'Doomed']);
    await ok(['comment', '1', 'bye', '--author', 'A']);
    const removed = await json(['rm', '1']);
    expect(removed).toMatchObject({ key: 'OP-1', commentCount: 1 });
    expect(removed).not.toHaveProperty('body');
  });

  it('numbers the next card after the highest remaining one', async () => {
    await ok(['add', 'a']);
    await ok(['add', 'b']);
    await ok(['rm', '1']);
    expect((await json(['add', 'c'])).key).toBe('OP-3');
  });
});

describe('open', () => {
  beforeEach(async () => {
    await ok(['add', 'Open me']);
  });

  it('prints the obsidian:// URL with --print and does not launch anything', async () => {
    const r = await ok(['open', '1', '--print']);
    expect(r.out).toBe(`obsidian://open?vault=${encodeURIComponent(path.basename(vault))}&file=Cards%2FOP-1\n`);
    expect(opened).toEqual([]);
  });

  it('hands the URL to the system opener and says so', async () => {
    const r = await ok(['open', '1']);
    expect(opened).toEqual([`obsidian://open?vault=${encodeURIComponent(path.basename(vault))}&file=Cards%2FOP-1`]);
    expect(r.out).toContain('Opening OP-1 in Obsidian');
  });

  it('percent-encodes vault names with spaces and unicode', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'oprojects-name-'));
    const spaced = path.join(parent, 'My Vault ✓ Zoë');
    try {
      await mkdir(path.join(spaced, '.obsidian'), { recursive: true });
      await ok(['add', 'Spaced'], { cwd: spaced });
      const { out } = await ok(['open', '1', '--print'], { cwd: spaced });
      expect(out.trim()).toBe(`obsidian://open?vault=${encodeURIComponent('My Vault ✓ Zoë')}&file=Cards%2FOP-1`);
      expect(out).toContain('My%20Vault');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('exits 1 when the system opener fails, and 1 for a card that does not exist', async () => {
    const failed = await cli(['open', '1'], { openUrl: async () => Promise.reject(new Error('xdg-open not found')) });
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('xdg-open not found');
    expect((await cli(['open', '99'])).code).toBe(1);
    expect(opened).toEqual([]);
  });
});

describe('config', () => {
  it('prints the vault, folder, prefix, user and the columns with done and WIP markers', async () => {
    const out = (await ok(['config'])).out;
    expect(out).toContain(`vault    ${vault}`);
    expect(out).toContain('folder   Cards');
    expect(out).toContain('prefix   OP');
    expect(out).toContain('me       (not set)');
    expect(out).toContain('columns  todo → doing → review → done✓');
  });

  it('shows the configured user and WIP limits', async () => {
    await ok(['init', '--me', 'Ana']);
    await writeFile(
      path.join(vault, '.obsidian/plugins/obsidian-projects/data.json'),
      JSON.stringify({
        board: {
          prefix: 'WEB',
          me: 'Ana',
          columns: [
            { id: 'a', name: 'A', wip: 3 },
            { id: 'z', name: 'Z', done: true },
          ],
        },
      }),
    );
    const out = (await ok(['config'])).out;
    expect(out).toContain('me       Ana');
    expect(out).toContain('prefix   WEB');
    expect(out).toContain('columns  a(wip 3) → z✓');
  });

  it('has a stable JSON shape: the vault path plus the whole board config', async () => {
    const config = await json(['config']);
    expect(keysOf(config)).toEqual(['columns', 'folder', 'hideDoneAfterDays', 'me', 'members', 'prefix', 'vault']);
    expect(config).toMatchObject({ vault, folder: 'Cards', prefix: 'OP', hideDoneAfterDays: 14, me: '', members: [] });
    expect(config.columns.map((c: { id: string }) => c.id)).toEqual(['todo', 'doing', 'review', 'done']);
  });

  it('reflects a hand-edited, partly broken data file by falling back to defaults field by field', async () => {
    const file = path.join(vault, '.obsidian/plugins/obsidian-projects/data.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ board: { prefix: 'bad prefix', folder: '../../x', hideDoneAfterDays: -2, columns: 'nope' } }),
    );
    const config = await json(['config']);
    expect(config).toMatchObject({ prefix: 'OP', folder: 'x', hideDoneAfterDays: 14 });
    expect(config.columns).toHaveLength(4);
    await writeFile(file, '{ broken json');
    expect((await json(['config'])).prefix).toBe('OP');
  });
});

describe('init', () => {
  const dataFile = () => path.join(vault, '.obsidian/plugins/obsidian-projects/data.json');
  const board = async () =>
    (JSON.parse(await readFile(dataFile(), 'utf8')) as { board: Record<string, unknown> }).board;

  it('sets up a fresh vault: writes the board config and creates the cards folder, then says what to do next', async () => {
    const { out } = await ok(['init', '--prefix', 'web', '--folder', 'Work/Board', '--me', 'Ana']);
    expect(out).toContain('Board ready');
    expect(out).toContain('WEB-<n>');
    expect(out).toContain('Work/Board/');
    expect(out).toContain('oprojects add');
    expect(await board()).toMatchObject({ prefix: 'WEB', folder: 'Work/Board', me: 'Ana' });
    expect((await stat(path.join(vault, 'Work/Board'))).isDirectory()).toBe(true);
    expect((await json(['add', 'First'])).path).toBe('Work/Board/WEB-1.md');
  });

  it('works without any option, keeping the defaults, and the .keep file never shows up as a card', async () => {
    await ok(['init']).catch(() => undefined);
    expect(await board()).toMatchObject({ prefix: 'OP', folder: 'Cards' });
    expect(await json(['ls'])).toEqual([]);
    expect(await readdir(path.join(vault, 'Cards'))).toEqual(['.keep']);
  });

  it('says there is nothing to do when the board exists and no option is given, without touching the file', async () => {
    await ok(['init', '--prefix', 'AAA']);
    const before = await readFile(dataFile(), 'utf8');
    const r = await ok(['init']);
    expect(r.out).toContain('Board already set up');
    expect(r.out).toContain('AAA');
    expect(await readFile(dataFile(), 'utf8')).toBe(before);
  });

  it('lets --me change the user of an existing board without --force, but not the prefix or the folder', async () => {
    await ok(['init', '--prefix', 'AAA', '--folder', 'Cards']);
    await ok(['init', '--me', 'Zoë']);
    expect(await board()).toMatchObject({ prefix: 'AAA', me: 'Zoë' });
    for (const flags of [
      ['--prefix', 'BBB'],
      ['--folder', 'Other'],
    ]) {
      const r = await cli(['init', ...flags]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('already has a board');
      expect(r.err).toContain('--force');
    }
    expect(await board()).toMatchObject({ prefix: 'AAA', folder: 'Cards' });
    await ok(['init', '--prefix', 'BBB', '--folder', 'Other', '--force']);
    expect(await board()).toMatchObject({ prefix: 'BBB', folder: 'Other' });
  });

  it('can clear the user with an empty --me', async () => {
    await ok(['init', '--me', 'Ana']);
    await ok(['init', '--me', '']);
    expect((await board()).me).toBe('');
  });

  it('normalizes the folder and falls back to Cards when nothing is left', async () => {
    await ok(['init', '--folder', '/../Work//Board/']);
    expect((await board()).folder).toBe('Work/Board');
    await ok(['init', '--folder', '../..', '--force']);
    expect((await board()).folder).toBe('Cards');
  });

  it('keeps the other plugin settings and the existing columns when it rewrites the file', async () => {
    await mkdir(path.dirname(dataFile()), { recursive: true });
    await writeFile(
      dataFile(),
      JSON.stringify({
        version: 1,
        ui: { x: 1 },
        board: { prefix: 'KEEP', columns: [{ id: 'only', name: 'Only', done: true }] },
      }),
    );
    await ok(['init', '--me', 'Ana']);
    const data = JSON.parse(await readFile(dataFile(), 'utf8')) as {
      version: number;
      ui: unknown;
      board: { columns: unknown; me: string };
    };
    expect(data.version).toBe(1);
    expect(data.ui).toEqual({ x: 1 });
    expect(data.board.columns).toEqual([{ id: 'only', name: 'Only', done: true }]);
    expect(data.board.me).toBe('Ana');
  });

  it.each(['x', '1AB', 'A B', 'waytoolongprefix', 'a-b'])(
    'rejects the invalid prefix %j with exit 2 and writes nothing',
    async (prefix) => {
      const r = await cli(['init', '--prefix', prefix]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('Invalid prefix');
      await expect(stat(dataFile())).rejects.toThrow(/ENOENT/);
    },
  );

  it('works as the very first command of a vault that has no plugin folder at all', async () => {
    await expect(stat(path.join(vault, '.obsidian/plugins'))).rejects.toThrow(/ENOENT/);
    await ok(['init', '--prefix', 'NEW']);
    expect((await json(['add', 'x'])).key).toBe('NEW-1');
  });
});

describe('parseDue', () => {
  it.each([
    ['today', '2026-10-14'],
    ['TODAY', '2026-10-14'],
    ['  today  ', '2026-10-14'],
    ['tomorrow', '2026-10-15'],
    ['+0d', '2026-10-14'],
    ['+1d', '2026-10-15'],
    ['+3d', '2026-10-17'],
    ['+17d', '2026-10-31'],
    ['+18d', '2026-11-01'],
    ['+1w', '2026-10-21'],
    ['+2w', '2026-10-28'],
    ['+2W', '2026-10-28'],
    ['+80d', '2027-01-02'],
    ['+365d', '2027-10-14'],
    ['2026-10-20', '2026-10-20'],
    ['2028-02-29', '2028-02-29'],
    ['2000-02-29', '2000-02-29'],
    [' 2026-12-31 ', '2026-12-31'],
  ])('reads %j as %s', (input, expected) => {
    expect(parseDue(input, NOW)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    'yesterday',
    'next week',
    '+d',
    '+d3',
    '+3',
    '+3m',
    '+-1d',
    '-1d',
    '++1d',
    '+1.5d',
    '2026-02-29',
    '2100-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-10-32',
    '26-10-14',
    '2026/10/14',
    '14-10-2026',
    '2026-1-1',
  ])('rejects %j with the list of accepted formats', (input) => {
    expect(() => parseDue(input, NOW)).toThrow(`Invalid date "${input}" (use YYYY-MM-DD, today, tomorrow, +3d, +2w)`);
  });

  it('rolls over month and year ends and leap days', () => {
    expect(parseDue('tomorrow', new Date(2026, 11, 31, 23, 59))).toBe('2027-01-01');
    expect(parseDue('+1d', new Date(2028, 1, 28, 8))).toBe('2028-02-29');
    expect(parseDue('+2d', new Date(2028, 1, 28, 8))).toBe('2028-03-01');
    expect(parseDue('+1d', new Date(2027, 1, 28, 8))).toBe('2027-03-01');
    expect(parseDue('+1w', new Date(2026, 0, 28, 8))).toBe('2026-02-04');
  });

  it('adds exactly N days (or N weeks) to the local date, for any N, and does not depend on the time of day', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1500 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        (n, hour, minute) => {
          const now = new Date(2026, 9, 14, hour, minute);
          const expected = new Date(2026, 9, 14 + n);
          expect(parseDue(`+${n}d`, now)).toBe(localDate(expected));
          expect(parseDue(`+${n}w`, now)).toBe(localDate(new Date(2026, 9, 14 + 7 * n)));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('accepts exactly the real calendar dates in ISO form', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('1990-01-01'), max: new Date('2090-01-01'), noInvalidDate: true }), (d) => {
        const iso = d.toISOString().slice(0, 10);
        expect(parseDue(iso, NOW)).toBe(iso);
      }),
      { numRuns: 200 },
    );
  });

  it('never returns anything but a valid YYYY-MM-DD, and never throws anything but its own message', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (input) => {
        const result = (() => {
          try {
            return parseDue(input, NOW);
          } catch (e) {
            return (e as Error).message;
          }
        })();
        expect(/^\d{4}-\d{2}-\d{2}$/.test(result) || result.startsWith('Invalid date')).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe('exit codes', () => {
  it('are 0 for success, 1 for domain errors, 2 for usage errors and 1 for unexpected failures', async () => {
    expect((await cli(['add', 'ok'])).code).toBe(0);
    expect((await cli(['show', '99'])).code).toBe(1);
    expect((await cli(['add', 'x', '-p', 'nope'])).code).toBe(1);
    expect((await cli(['show'])).code).toBe(2);
    expect((await cli(['add', 'x', '--body', '-'], { stdin: new Error('disk on fire') })).code).toBe(1);
  });

  it('keep stdout clean on every failure, and use stderr for the message', async () => {
    for (const argv of [['show', '99'], ['show'], ['bogus'], ['add', 'x', '-p', 'nope'], ['ls', '--nope']]) {
      const r = await cli(argv);
      expect({ argv, out: r.out }).toEqual({ argv, out: '' });
      expect(r.err.length).toBeGreaterThan(0);
    }
  });
});

describe('end to end flow', () => {
  it('runs a whole working session through the CLI and leaves a consistent vault', async () => {
    await ok(['init', '--prefix', 'WEB', '--me', 'Ana']);
    await ok(['add', 'Epic: checkout', '-t', 'epic']);
    await ok(['add', 'Cart page', '--parent', '1', '-a', 'me', '-l', 'ui', '--due', '+3d']);
    await ok(['add', 'Payment API', '--parent', '1', '-a', 'Bruno', '-p', 'high']);
    await ok(['mv', '2', 'doing']);
    await ok(['comment', '2', 'Started', '--author', 'Ana']);
    await ok(['edit', '3', '--add-label', 'api', '--estimate', '5']);
    await ok(['mv', '3', 'doing', '--before', '2']);
    await ok(['mv', '2', 'done']);

    const board = await json(['board', '--epics', '--all']);
    expect(board.map((c: { cards: { key: string }[] }) => c.cards.map((card) => card.key))).toEqual([
      ['WEB-1'],
      ['WEB-3'],
      [],
      ['WEB-2'],
    ]);
    const done = (await json(['show', 'WEB-2'])) as {
      resolved?: string;
      comments: unknown[];
      due: string;
      assignee: string;
    };
    expect(done.resolved).toBeDefined();
    expect(done.comments).toHaveLength(1);
    expect(done).toMatchObject({ due: '2026-10-17', assignee: 'Ana' });

    await ok(['rm', '3']);
    expect((await json(['ls', '--all'])).map((c: { key: string }) => c.key)).toEqual(['WEB-1', 'WEB-2']);
    expect(await readdir(path.join(vault, 'Cards'))).toEqual(expect.arrayContaining(['WEB-1.md', 'WEB-2.md']));
    expect(await readdir(path.join(vault, '.trash'))).toEqual(['WEB-3.md']);
  });
});
