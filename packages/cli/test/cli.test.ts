import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDue, run, type IO } from '../src/run';

let vault: string;
let opened: string[];
let stdin = '';

const NOW = new Date(2026, 9, 14, 12, 0, 0); // local time: 2026-10-14

async function oprojects(...argv: string[]) {
  let out = '';
  let err = '';
  const io: IO = {
    cwd: vault,
    env: {},
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    readStdin: async () => stdin,
    isTTY: false,
    columns: 100,
    now: () => NOW,
    openUrl: async (u) => void opened.push(u),
  };
  const code = await run(argv, io);
  return { code, out, err };
}

const json = async (...argv: string[]) => JSON.parse((await oprojects(...argv, '--json')).out);

beforeEach(async () => {
  vault = await mkdtemp(path.join(tmpdir(), 'oprojects-cli-'));
  await mkdir(path.join(vault, '.obsidian'));
  opened = [];
  stdin = '';
});
afterEach(() => rm(vault, { recursive: true, force: true }));

describe('add / show / list', () => {
  it('creates a card with all options and shows it back', async () => {
    const r = await oprojects('add', 'Fix', 'the', 'login', '-t', 'bug', '-p', 'high', '-a', 'ana', '-l', 'auth,backend', '--due', '+3d', '--estimate', '5');
    expect(r.code).toBe(0);
    expect(r.out).toContain('OP-1');
    const card = await json('show', 'OP-1');
    expect(card).toMatchObject({ key: 'OP-1', title: 'Fix the login', type: 'bug', priority: 'high', assignee: 'ana', labels: ['auth', 'backend'], due: '2026-10-17', estimate: 5, status: 'todo' });
    expect(await readFile(path.join(vault, 'Cards', 'OP-1.md'), 'utf8')).toContain('title: Fix the login');
  });

  it('reads the description from stdin with --body -', async () => {
    stdin = 'Steps:\n- [ ] one\n- [x] two\n';
    await oprojects('add', 'Crash', '--body', '-');
    const card = await json('show', '1');
    expect(card.body).toContain('Steps:');
    expect(card.checklist).toEqual({ done: 1, total: 2 });
  });

  it('lists with filters, and --json omits the body', async () => {
    await oprojects('add', 'Alpha', '-t', 'bug', '-a', 'ana');
    await oprojects('add', 'Beta', '-s', 'doing', '-l', 'ci');
    await oprojects('add', 'Gamma', '-s', 'doing', '-a', 'bia');
    expect((await json('ls')).map((c: { key: string }) => c.key)).toEqual(['OP-1', 'OP-2', 'OP-3']);
    expect((await json('ls', '-s', 'doing')).map((c: { key: string }) => c.key)).toEqual(['OP-2', 'OP-3']);
    expect((await json('ls', '-a', 'none')).map((c: { key: string }) => c.key)).toEqual(['OP-2']);
    expect((await json('ls', '-t', 'bug')).map((c: { key: string }) => c.key)).toEqual(['OP-1']);
    expect((await json('ls', '-l', 'ci')).map((c: { key: string }) => c.key)).toEqual(['OP-2']);
    expect((await json('ls', '-q', 'gam')).map((c: { key: string }) => c.key)).toEqual(['OP-3']);
    expect((await json('ls'))[0]).not.toHaveProperty('body');
    const table = await oprojects('ls');
    expect(table.out).toMatch(/OP-1\s+To Do\s+ana\s+Alpha/);
  });

  it('prints the board with every column, count and card', async () => {
    await oprojects('add', 'Alpha');
    await oprojects('add', 'Beta', '-s', 'done');
    const { out } = await oprojects('board');
    for (const needle of ['TO DO', 'IN PROGRESS', 'REVIEW', 'DONE', 'OP-1', 'OP-2', 'Alpha', 'Beta']) expect(out).toContain(needle);
    expect(Math.max(...out.split('\n').map((l) => l.length))).toBeLessThanOrEqual(100);
  });

  it('falls back to stacked columns on a narrow terminal', async () => {
    await oprojects('add', 'Alpha');
    let out = '';
    await run(['board'], { cwd: vault, env: {}, out: (t) => void (out += t), err: () => {}, readStdin: async () => '', isTTY: false, columns: 50, now: () => NOW, openUrl: async () => {} });
    expect(out.split('\n').some((l) => l.includes('TO DO') && l.includes('IN PROGRESS'))).toBe(false);
    expect(out).toContain('OP-1');
  });
});

describe('move / edit / rm', () => {
  it('moves by id, name or number, and orders with --before', async () => {
    await oprojects('add', 'a');
    await oprojects('add', 'b');
    await oprojects('add', 'c');
    expect((await oprojects('mv', '3', 'In Progress')).out).toContain('In Progress');
    await oprojects('mv', 'OP-1', 'doing', '--before', 'OP-3');
    const doing = (await json('ls', '-s', 'doing')).map((c: { key: string }) => c.key);
    expect(doing).toEqual(['OP-1', 'OP-3']);
    expect((await json('show', '1')).status).toBe('doing');
  });

  it('edits fields, clears with none, and adds/removes labels', async () => {
    await oprojects('add', 'a', '-a', 'ana', '--due', 'today', '-l', 'x,y');
    await oprojects('edit', '1', '--title', 'renamed', '-p', 'lowest', '-a', 'none', '--due', 'none', '--add-label', 'z', '--rm-label', 'x');
    const c = await json('show', '1');
    expect(c).toMatchObject({ title: 'renamed', priority: 'lowest', labels: ['y', 'z'] });
    expect(c.assignee).toBeUndefined();
    expect(c.due).toBeUndefined();
  });

  it('removes to .trash', async () => {
    await oprojects('add', 'a');
    expect((await oprojects('rm', '1')).code).toBe(0);
    expect(await json('ls')).toEqual([]);
    expect((await oprojects('show', '1')).code).toBe(1);
  });
});

describe('errors and ergonomics', () => {
  it('reports validation errors with exit code 1 and valid options', async () => {
    const r = await oprojects('add', 'x', '-s', 'limbo');
    expect(r.code).toBe(1);
    expect(r.err).toContain('valid: todo, doing, review, done');
  });

  it('reports usage errors with exit code 2', async () => {
    expect((await oprojects('add')).code).toBe(2);
    expect((await oprojects('mv', '1')).code).toBe(2);
    expect((await oprojects('ls', '--nope')).code).toBe(2);
    expect((await oprojects('bogus')).code).toBe(2);
    expect((await oprojects('edit', '1')).code).toBe(2);
  });

  it('prints errors as JSON on stderr with --json', async () => {
    const r = await oprojects('show', '99', '--json');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err)).toEqual({ error: 'Card OP-99 not found' });
  });

  it('shows help, per-command help and version', async () => {
    expect((await oprojects()).out).toContain('Commands');
    expect((await oprojects('add', '--help')).out).toContain('Examples');
    expect((await oprojects('help', 'move')).out).toContain('--before');
    expect((await oprojects('--version')).out).toMatch(/\d+\.\d+\.\d+/);
  });

  it('accepts global options before the command and an explicit --vault from anywhere', async () => {
    await oprojects('add', 'a');
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'oprojects-cwd-'));
    let out = '';
    const io = { cwd: elsewhere, env: {}, out: (t: string) => void (out += t), err: () => {}, readStdin: async () => '', isTTY: false, columns: 80, now: () => NOW, openUrl: async () => {} };
    expect(await run(['--vault', vault, '--json', 'ls'], io)).toBe(0);
    expect(JSON.parse(out)).toHaveLength(1);
    out = '';
    expect(await run([`--vault=${vault}`, 'ls', '--json'], io)).toBe(0);
    expect(JSON.parse(out)).toHaveLength(1);
    await rm(elsewhere, { recursive: true, force: true });
  });

  it('fails clearly outside a vault', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'oprojects-nov-'));
    let err = '';
    const code = await run(['ls'], { cwd: outside, env: {}, out: () => {}, err: (t) => void (err += t), readStdin: async () => '', isTTY: false, columns: 80, now: () => NOW, openUrl: async () => {} });
    await rm(outside, { recursive: true, force: true });
    expect(code).toBe(1);
    expect(err).toContain('No Obsidian vault found');
  });

  it('builds an obsidian:// URL for `open`', async () => {
    await oprojects('add', 'a');
    const r = await oprojects('open', '1', '--print');
    expect(r.out.trim()).toBe(`obsidian://open?vault=${encodeURIComponent(path.basename(vault))}&file=Cards%2FOP-1`);
    await oprojects('open', '1');
    expect(opened).toHaveLength(1);
  });
});

describe('init and config', () => {
  it('writes the board config the plugin reads, and then uses it', async () => {
    const r = await oprojects('init', '--prefix', 'web', '--folder', 'Work/Board', '--me', 'Ana');
    expect(r.code).toBe(0);
    const data = JSON.parse(await readFile(path.join(vault, '.obsidian/plugins/obsidian-projects/data.json'), 'utf8'));
    expect(data.board).toMatchObject({ prefix: 'WEB', folder: 'Work/Board', me: 'Ana' });
    await oprojects('add', 'hello', '-a', 'me');
    expect((await json('show', 'WEB-1')).assignee).toBe('Ana');
    expect(await readFile(path.join(vault, 'Work/Board/WEB-1.md'), 'utf8')).toContain('key: WEB-1');
    expect((await json('config')).prefix).toBe('WEB');
    expect((await json('ls', '--mine')).map((c: { key: string }) => c.key)).toEqual(['WEB-1']);
  });

  it('refuses to change prefix on an existing board without --force', async () => {
    await oprojects('init', '--prefix', 'AAA');
    expect((await oprojects('init', '--prefix', 'BBB')).code).toBe(2);
    expect((await oprojects('init', '--prefix', 'BBB', '--force')).code).toBe(0);
  });

  it('--mine explains what is missing', async () => {
    const r = await oprojects('ls', '--mine');
    expect(r.code).toBe(2);
    expect(r.err).toContain('me');
  });
});

describe('parseDue', () => {
  it('understands relative dates', () => {
    expect(parseDue('today', NOW)).toBe('2026-10-14');
    expect(parseDue('tomorrow', NOW)).toBe('2026-10-15');
    expect(parseDue('+2w', NOW)).toBe('2026-10-28');
    expect(parseDue('2026-12-24', NOW)).toBe('2026-12-24');
    expect(() => parseDue('someday', NOW)).toThrow();
  });
});

describe('board epics', () => {
  it('hides epics from the columns unless --epics', async () => {
    await oprojects('add', 'Big thing', '-t', 'epic');
    await oprojects('add', 'Small thing');
    const hidden = await json('board');
    expect(hidden[0].cards.map((c: { key: string }) => c.key)).toEqual(['OP-2']);
    const shown = await json('board', '--epics');
    expect(shown[0].cards.map((c: { key: string }) => c.key)).toEqual(['OP-1', 'OP-2']);
    expect((await json('ls')).length).toBe(2); // list always includes epics
  });
});

describe('comments', () => {
  beforeEach(async () => {
    await oprojects('init', '--me', 'Ana');
    await oprojects('add', 'Card with a conversation', '--body', 'Original description');
  });

  it('adds comments (author defaults to "me"), lists them in show, and counts them in list --json', async () => {
    const added = await oprojects('comment', '1', 'Reproduced', 'on', 'Safari');
    expect(added.code).toBe(0);
    expect(added.out).toMatch(/Commented on OP-1 #\w+/);
    await oprojects('comment', 'OP-1', 'Second comment', '--author', 'Bruno');
    const card = await json('show', '1');
    expect(card.comments.map((c: { author: string; text: string }) => [c.author, c.text])).toEqual([['Ana', 'Reproduced on Safari'], ['Bruno', 'Second comment']]);
    expect(card.body.trim()).toBe('Original description');
    const shown = (await oprojects('show', '1')).out;
    expect(shown).toContain('Comments (2)');
    expect(shown).toContain('Ana');
    expect(shown).toContain(`#${card.comments[0].id}`);
    const listed = await json('ls');
    expect(listed[0].commentCount).toBe(2);
    expect(listed[0]).not.toHaveProperty('comments');
  });

  it('reads multi-line text from stdin with "-"', async () => {
    stdin = 'First line\n\n- item a\n- item b\n';
    await oprojects('comment', '1', '-');
    expect((await json('show', '1')).comments[0].text).toBe('First line\n\n- item a\n- item b');
  });

  it('edits and removes by id', async () => {
    const id = (await json('comment', '1', 'original')).comments[0].id;
    await oprojects('comment', '1', '--edit', id, 'corrigido');
    expect((await json('show', '1')).comments[0].text).toBe('corrigido');
    expect((await oprojects('comment', '1', '--rm', id)).code).toBe(0);
    expect((await json('show', '1')).comments).toEqual([]);
  });

  it('keeps comments when the description is edited from the CLI', async () => {
    await oprojects('comment', '1', 'fica');
    await oprojects('edit', '1', '--body', 'New description');
    const card = await json('show', '1');
    expect(card.body.trim()).toBe('New description');
    expect(card.comments).toHaveLength(1);
  });

  it('writes a plain Markdown callout in the note', async () => {
    await oprojects('comment', '1', 'texto');
    const raw = await readFile(path.join(vault, 'Cards', 'OP-1.md'), 'utf8');
    expect(raw).toMatch(/\n## Comments\n\n> \[!comment\|\w+,\d{4}-\d{2}-\d{2}T[\d:.]+Z\] Ana · \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n> texto\n$/);
  });

  it('reports usage and not-found errors', async () => {
    expect((await oprojects('comment')).code).toBe(2);
    expect((await oprojects('comment', '1')).code).toBe(2); // no text
    expect((await oprojects('comment', '1', 'x', '--rm', 'abc')).code).toBe(2);
    expect((await oprojects('comment', '1', '--edit', 'a', '--rm', 'b')).code).toBe(2);
    const missing = await oprojects('comment', '1', '--rm', 'nope');
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('not found');
    expect((await oprojects('comment', '99', 'oi')).code).toBe(1);
  });

  it('falls back to the OS user when the board has no "me"', async () => {
    const io = (user: string) => ({ cwd: vault, env: { USER: user }, out: () => {}, err: () => {}, readStdin: async () => '', isTTY: false, columns: 80, now: () => NOW, openUrl: async () => {} });
    await oprojects('init', '--me', '');
    await run(['comment', '1', 'oi'], io('gustavo'));
    expect((await json('show', '1')).comments[0].author).toBe('gustavo');
  });
});
