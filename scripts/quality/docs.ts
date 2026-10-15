// Documentation gate: the docs must not lie. Checks that
//   - every relative link and image in a Markdown file points at a file that exists (and at a heading that exists);
//   - every repo path the docs mention in backticks exists;
//   - every `npm run <script>` in the docs and in the GitHub workflows is a script in package.json;
//   - every CLI command in the README is a real command, and every real command is in the README;
//   - the CHANGELOG is well-formed Keep a Changelog: versions descend, dates are valid, compare links are in place;
//   - the workflows are valid YAML and pin every action.
//
//   npm run check:docs
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { run, type IO } from '../../packages/cli/src/run';
import { SEMVER_RE, compareVersions } from '../release-lib';
import { at, finish, isMain, readText, repoFiles, root } from './lib';

// --- Markdown ------------------------------------------------------------------------------------------------

/** `md` with fenced code blocks blanked out (line numbers are preserved); inline code too when `inline` is true. */
export function withoutCode(md: string, inline = true): string {
  let fence: string | null = null;
  return md
    .split('\n')
    .map((line) => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) {
        const mark = f[1]![0]!;
        if (fence === null) fence = mark;
        else if (fence === mark) fence = null;
        return '';
      }
      if (fence !== null) return '';
      return inline ? line.replace(/`[^`\n]*`/g, '') : line;
    })
    .join('\n');
}

export interface Link {
  target: string;
  line: number;
}

/** Inline links and images `[text](target)`, outside code. */
export function markdownLinks(md: string): Link[] {
  const links: Link[] = [];
  withoutCode(md)
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g))
        links.push({ target: m[1]!, line: i + 1 });
    });
  return links;
}

/** GitHub-style heading anchors of a Markdown document. */
export function headingSlugs(md: string): Set<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of withoutCode(md, false).split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1]!
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

const isExternal = (target: string) => /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');

/** Problems with the links of one Markdown file. `read(path)` returns another file's text, or null when it is missing. */
export function checkLinks(
  file: string,
  md: string,
  read: (repoPath: string) => string | null,
  exists: (repoPath: string) => boolean,
): string[] {
  const problems: string[] = [];
  for (const { target, line } of markdownLinks(md)) {
    if (isExternal(target)) continue;
    const [rawPath = '', anchor] = target.split('#');
    const resolved =
      rawPath === ''
        ? file
        : path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(rawPath)));
    if (!exists(resolved)) {
      problems.push(`${file}:${line}: the link "${target}" points at ${resolved}, which does not exist`);
      continue;
    }
    if (anchor && resolved.endsWith('.md')) {
      const text = resolved === file ? md : read(resolved);
      if (text !== null && !headingSlugs(text).has(anchor.toLowerCase()))
        problems.push(`${file}:${line}: the link "${target}" points at a heading that does not exist in ${resolved}`);
    }
  }
  return problems;
}

/** Repo paths named in inline code (`packages/core/src/x.ts`, `scripts/`, `.github/workflows/ci.yml`). */
export function mentionedPaths(md: string): Link[] {
  const found: Link[] = [];
  withoutCode(md, false)
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(/`((?:packages|scripts|docs|\.github)\/[A-Za-z0-9_./-]*)`/g))
        found.push({ target: m[1]!.replace(/\/$/, ''), line: i + 1 });
    });
  return found;
}

/** Folders that only exist after a build: docs may name files in them (`packages/mcp/target/release/oprojects-mcp`). */
export const isBuildOutput = (repoPath: string): boolean =>
  /(^|\/)(target|dist|coverage|node_modules)(\/|$)/.test(repoPath);

/** Paths the docs mention on purpose before they exist (planned work). */
export const PLANNED_PATHS: ReadonlySet<string> = new Set([]);

// --- npm scripts -----------------------------------------------------------------------------------------------

/** `npm run <name>` mentions in some text (Markdown or a workflow). */
export function npmScriptsMentioned(text: string): Link[] {
  const found: Link[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) found.push({ target: m[1]!, line: i + 1 });
  });
  return found;
}

// --- CLI commands ------------------------------------------------------------------------------------------------

/** The commands the README's CLI block documents, e.g. `oprojects list|ls …` gives `list` and `ls`. */
export function readmeCliCommands(md: string): string[] {
  const block = /^## CLI\n[\s\S]*?```\n([\s\S]*?)```/m.exec(md)?.[1] ?? '';
  const names = new Set<string>();
  for (const m of block.matchAll(/^oprojects ([a-z]+(?:\|[a-z]+)*)((?: \| [a-z]+)*)/gm)) {
    for (const name of m[1]!.split('|')) names.add(name);
    for (const name of m[2]!.split('|')) if (name.trim()) names.add(name.trim());
  }
  return [...names];
}

/** Command names from the CLI's own `--help` text. */
export function commandsFromHelp(help: string): string[] {
  const lines = help.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'Commands');
  if (start < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break;
    const name = /^\s+([a-z]+)\s/.exec(line)?.[1];
    if (name) names.push(name);
  }
  return names;
}

async function cli(...argv: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  const io: IO = {
    cwd: root,
    env: {},
    out: (t) => void (out += t),
    err: (t) => void (out += t),
    readStdin: async () => '',
    isTTY: false,
    columns: 100,
    now: () => new Date(),
    openUrl: async () => {},
  };
  const code = await run([...argv, '--no-color'], io);
  return { code, out };
}

export async function checkCliDocs(readme: string): Promise<string[]> {
  const problems: string[] = [];
  const documented = readmeCliCommands(readme);
  const real = commandsFromHelp((await cli('--help')).out);
  if (real.length === 0) return ['could not read the command list from `oprojects --help`'];
  for (const name of real)
    if (!documented.includes(name))
      problems.push(`README.md: the CLI command "${name}" is not documented in the CLI section`);
  for (const name of documented) {
    const { code, out } = await cli(name, '--help');
    if (code !== 0)
      problems.push(
        `README.md: the CLI section documents "oprojects ${name}", which is not a command (${out.trim().split('\n')[0]})`,
      );
  }
  return problems;
}

// --- CHANGELOG ---------------------------------------------------------------------------------------------------

const isRealDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const date = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(s);
};

export function changelogProblems(changelog: string): string[] {
  const problems: string[] = [];
  const headings = [...changelog.matchAll(/^## \[([^\]]+)\](?: - (\S+))?[ \t]*$/gm)];
  const versions = headings.filter((h) => h[1] !== 'Unreleased');

  if (!headings.some((h) => h[1] === 'Unreleased'))
    problems.push('CHANGELOG.md: there is no "## [Unreleased]" section');
  if (headings[0] && headings[0][1] !== 'Unreleased') problems.push('CHANGELOG.md: "## [Unreleased]" must come first');

  let previous: string | undefined;
  for (const [, version = '', date = ''] of versions) {
    if (!SEMVER_RE.test(version)) {
      problems.push(`CHANGELOG.md: "## [${version}]" is not a valid SemVer version`);
      continue;
    }
    if (!isRealDate(date))
      problems.push(`CHANGELOG.md: "## [${version}]" needs a date like "- 2026-10-15" (found "${date || 'none'}")`);
    if (previous !== undefined && compareVersions(previous, version) <= 0)
      problems.push(`CHANGELOG.md: versions must be listed newest first, but ${version} comes after ${previous}`);
    previous = version;
    if (!new RegExp(`^\\[${version.replace(/[.+-]/g, '\\$&')}\\]: https://`, 'm').test(changelog))
      problems.push(`CHANGELOG.md: no link reference for [${version}] at the bottom`);
  }
  const unreleasedLink = /^\[Unreleased\]: \S+\/compare\/(\S+?)\.\.\.HEAD$/m.exec(changelog);
  if (!unreleasedLink)
    problems.push('CHANGELOG.md: no "[Unreleased]: …/compare/<latest>...HEAD" link reference at the bottom');
  else if (versions[0] && unreleasedLink[1] !== versions[0][1])
    problems.push(
      `CHANGELOG.md: [Unreleased] compares from ${unreleasedLink[1]}, but the latest release is ${versions[0][1]}`,
    );
  return problems;
}

// --- workflows ----------------------------------------------------------------------------------------------------

export function workflowProblems(file: string, text: string, scripts: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return [`${file}: not valid YAML (${(e as Error).message.split('\n')[0]})`];
  }
  if (!doc || typeof doc !== 'object' || !('jobs' in doc)) problems.push(`${file}: no jobs`);
  text.split('\n').forEach((line, i) => {
    const uses = /^\s*-?\s*uses:\s*(\S+)/.exec(line)?.[1];
    if (uses && !uses.startsWith('./') && !/@(?:v\d+(?:\.\d+)*|[0-9a-f]{40})$/.test(uses))
      problems.push(`${file}:${i + 1}: "${uses}" must be pinned to a version tag (@vN) or a commit SHA`);
  });
  for (const { target, line } of npmScriptsMentioned(text))
    if (!scripts.has(target))
      problems.push(`${file}:${line}: runs "npm run ${target}", which is not a script in package.json`);
  return problems;
}

// --- the gate --------------------------------------------------------------------------------------------------------

export async function checkRepo(): Promise<string[]> {
  const files = repoFiles();
  const fileSet = new Set(files);
  const dirs = new Set(
    files.flatMap((f) =>
      f
        .split('/')
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join('/')),
    ),
  );
  const linkExists = (p: string) => fileSet.has(p) || dirs.has(p);
  const pathExists = (p: string) => linkExists(p) || PLANNED_PATHS.has(p);
  const scripts = new Set(
    Object.keys((JSON.parse(readFileSync(at('package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts),
  );

  const problems: string[] = [];
  for (const file of files.filter((f) => f.endsWith('.md'))) {
    const md = readText(file);
    if (md === null) continue;
    problems.push(...checkLinks(file, md, (p) => readText(p), linkExists));
    for (const { target, line } of mentionedPaths(md)) {
      if (!isBuildOutput(target) && !pathExists(target))
        problems.push(`${file}:${line}: mentions \`${target}\`, which does not exist`);
    }
    for (const { target, line } of npmScriptsMentioned(md))
      if (!scripts.has(target))
        problems.push(`${file}:${line}: mentions "npm run ${target}", which is not a script in package.json`);
  }
  problems.push(...(await checkCliDocs(readFileSync(at('README.md'), 'utf8'))));
  problems.push(...changelogProblems(readFileSync(at('CHANGELOG.md'), 'utf8')));
  for (const file of files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f)))
    problems.push(...workflowProblems(file, readFileSync(at(file), 'utf8'), scripts));
  return problems;
}

if (isMain(import.meta.url)) {
  checkRepo().then(
    (problems) => finish('Documentation gate', problems),
    (e) => {
      console.error(e);
      process.exitCode = 1;
    },
  );
}
