// Smoke test of the shipped CLI: runs the built `oprojects.cjs` as a real process (shebang, bundled yaml, real
// stdin/stdout, exit codes) against a throwaway vault. Run it after `npm run build`.
//
//   npm run test:smoke
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { at } from './quality/lib';

const CLI = at('packages/cli/dist/oprojects.cjs');
if (!existsSync(CLI)) {
  console.error('packages/cli/dist/oprojects.cjs is missing. Run `npm run build` first.');
  process.exit(2);
}

const vault = mkdtempSync(path.join(tmpdir(), 'oprojects-smoke-'));
mkdirSync(path.join(vault, '.obsidian'));
let passed = 0;
let failed = 0;

function oprojects(args: string[], input?: string) {
  const r = spawnSync(CLI, args, {
    cwd: vault,
    input,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', OPROJECTS_VAULT: '' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function check(name: string, ok: boolean, extra = ''): void {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`);
}

try {
  const version = (JSON.parse(readFileSync(at('package.json'), 'utf8')) as { version: string }).version;
  const v = oprojects(['--version']);
  check('--version prints the package version', v.code === 0 && v.out.trim() === version, `got "${v.out.trim()}"`);
  check('help lists the commands', oprojects(['--help']).out.includes('Commands'));

  const init = oprojects(['init', '--prefix', 'SM', '--me', 'Smoke']);
  check(
    'init writes the board config',
    init.code === 0 && existsSync(path.join(vault, '.obsidian/plugins/obsidian-projects/data.json')),
    init.err,
  );

  const added = oprojects(['add', 'First card', '-t', 'bug', '-p', 'high', '--json']);
  const card = JSON.parse(added.out || '{}') as { key?: string; status?: string };
  check(
    'add creates SM-1 as a note',
    added.code === 0 && card.key === 'SM-1' && existsSync(path.join(vault, 'Cards/SM-1.md')),
    added.err,
  );
  check(
    'the note is Markdown with frontmatter',
    readFileSync(path.join(vault, 'Cards/SM-1.md'), 'utf8').startsWith('---\nkey: SM-1\n'),
  );

  const body = oprojects(['add', 'Card with a body', '--body', '-'], 'Line one\n\n- [ ] a task\n');
  check(
    'add reads the description from stdin',
    body.code === 0 && readFileSync(path.join(vault, 'Cards/SM-2.md'), 'utf8').includes('- [ ] a task'),
  );

  const comment = oprojects(['comment', 'SM-1', 'Reproduced on Safari', '--author', 'Smoke']);
  check('comment succeeds', comment.code === 0, comment.err);
  const shown = JSON.parse(oprojects(['show', 'SM-1', '--json']).out) as {
    comments: { author: string; text: string }[];
  };
  check('show returns the comment', shown.comments.length === 1 && shown.comments[0]?.text === 'Reproduced on Safari');

  const moved = oprojects(['mv', 'SM-1', 'In Progress']);
  check('mv moves by column name', moved.code === 0, moved.err);
  const listed = JSON.parse(oprojects(['ls', '--json']).out) as { key: string; status: string }[];
  check(
    'ls --json reflects the move',
    listed.some((c) => c.key === 'SM-1' && c.status === 'doing'),
    JSON.stringify(listed),
  );
  check('board renders the cards', oprojects(['board']).out.includes('SM-1'));

  check(
    'edit changes a field',
    oprojects(['edit', 'SM-2', '--title', 'Renamed', '-p', 'low']).code === 0 &&
      readFileSync(path.join(vault, 'Cards/SM-2.md'), 'utf8').includes('title: Renamed'),
  );

  const removed = oprojects(['rm', 'SM-2']);
  check(
    'rm moves the note to .trash',
    removed.code === 0 &&
      !existsSync(path.join(vault, 'Cards/SM-2.md')) &&
      readdirSync(path.join(vault, '.trash')).some((f) => f.startsWith('SM-2')),
  );

  const missing = oprojects(['show', 'SM-99']);
  check('a missing card exits with 1 and a message on stderr', missing.code === 1 && missing.err.length > 0);
  check('an unknown command exits with 2', oprojects(['frobnicate']).code === 2);
} finally {
  rmSync(vault, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
