// Versioning and releases (see RELEASING.md).
//
//   npm run version:check                      every version in the repo agrees (runs as part of `npm run check`)
//   npm run release -- <major|minor|patch|x.y.z[-pre]> [--dry-run] [--no-git]
//                                               bump every version, date the CHANGELOG, commit "Release x.y.z", tag x.y.z
//   tsx scripts/release.ts check --tag <tag>   (CI) the pushed tag equals the version, and the CHANGELOG has its notes
//   tsx scripts/release.ts notes <version>     print that version's CHANGELOG notes (used as the GitHub release body)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { bump, compareVersions, extractNotes, problems, promoteUnreleased, type RepoVersions } from './release-lib';

const PACKAGE_FILES = [
  'package.json',
  'packages/core/package.json',
  'packages/cli/package.json',
  'packages/plugin/package.json',
];
const LOCK_PATHS = ['', 'packages/core', 'packages/cli', 'packages/plugin'];
const USAGE =
  'Usage: release.ts check [--tag <tag>] | notes <version> | <major|minor|patch|x.y.z> [--dry-run] [--no-git]';

type Json = Record<string, any>;

export interface Output {
  log: (text: string) => void;
  error: (text: string) => void;
}

/** A failure to report to the user (as opposed to a bug): `main` prints it and returns exit code 1. */
class Failure extends Error {}

const fail = (message: string): never => {
  throw new Failure(message);
};

function report(list: string[]): void {
  if (list.length) fail(`Version problems:\n${list.map((p) => `  - ${p}`).join('\n')}`);
}

/**
 * Runs one command of the script against the repository at `root`. Returns the process exit code (0 ok, 1 failure).
 * `today` is injectable so the CHANGELOG date is testable.
 */
export function main(argv: string[], root: string, out: Output, today: () => Date = () => new Date()): number {
  const at = (file: string) => path.join(root, file);
  const readJson = (file: string): Json => JSON.parse(readFileSync(at(file), 'utf8'));
  const writeJson = (file: string, data: unknown) => writeFileSync(at(file), `${JSON.stringify(data, null, 2)}\n`);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

  const load = (): RepoVersions => {
    const lock = readJson('package-lock.json');
    return {
      packages: Object.fromEntries(PACKAGE_FILES.map((f) => [f, readJson(f).version as string | undefined])),
      manifest: readJson('packages/plugin/manifest.json'),
      versions: readJson('versions.json'),
      lock: Object.fromEntries(LOCK_PATHS.map((p) => [p, lock.packages?.[p]?.version as string | undefined])),
      changelog: readFileSync(at('CHANGELOG.md'), 'utf8'),
    };
  };

  const [command, ...rest] = argv;
  const flag = (name: string) => rest.includes(name);

  try {
    if (command === 'check') {
      const tagAt = rest.indexOf('--tag');
      const tag = tagAt >= 0 ? rest[tagAt + 1] : undefined;
      if (tagAt >= 0 && !tag) fail('--tag needs a value');
      const repo = load();
      report(problems(repo, { tag, requireChangelog: tag !== undefined }));
      out.log(`Versions are consistent (${repo.manifest.version}).`);
      return 0;
    }

    if (command === 'notes') {
      const version = rest[0];
      if (!version) fail('Usage: release.ts notes <version>');
      const notes = extractNotes(readFileSync(at('CHANGELOG.md'), 'utf8'), version!);
      if (notes === null) fail(`CHANGELOG.md has no filled-in "## [${version}]" section`);
      out.log(notes!);
      return 0;
    }

    if (!command) return fail(USAGE);
    return bumpCommand(command, flag, load, { at, readJson, writeJson, git }, out, today());
  } catch (e) {
    if (!(e instanceof Failure)) throw e;
    out.error(e.message);
    return 1;
  }
}

interface Env {
  at: (file: string) => string;
  readJson: (file: string) => Json;
  writeJson: (file: string, data: unknown) => void;
  git: (...args: string[]) => string;
}

function bumpCommand(
  spec: string,
  flag: (name: string) => boolean,
  load: () => RepoVersions,
  env: Env,
  out: Output,
  now: Date,
): number {
  const dryRun = flag('--dry-run');
  const repo = load();
  report(problems(repo)); // never build on top of an inconsistent state

  const current = repo.manifest.version!;
  let next: string;
  try {
    next = bump(current, spec);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (compareVersions(next, current) <= 0) fail(`${next} is not newer than the current version ${current}`);

  let changelog: string;
  try {
    changelog = promoteUnreleased(repo.changelog, next, now.toISOString().slice(0, 10));
  } catch (e) {
    return fail((e as Error).message);
  }

  const useGit = !flag('--no-git') && !dryRun;
  if (useGit) {
    if (env.git('status', '--porcelain'))
      fail('The working tree is not clean. Commit or stash your changes first (or pass --no-git).');
    if (env.git('tag', '--list', next)) fail(`The tag ${next} already exists.`);
  }

  out.log(`${current} → ${next}${dryRun ? '  (dry run, nothing written)' : ''}`);
  if (dryRun) return 0;

  for (const file of PACKAGE_FILES) env.writeJson(file, { ...env.readJson(file), version: next });
  env.writeJson('packages/plugin/manifest.json', { ...repo.manifest, version: next });
  env.writeJson('versions.json', { ...repo.versions, [next]: repo.manifest.minAppVersion });
  const lock = env.readJson('package-lock.json');
  lock.version = next;
  for (const p of LOCK_PATHS) if (lock.packages?.[p]) lock.packages[p].version = next;
  env.writeJson('package-lock.json', lock);
  writeFileSync(env.at('CHANGELOG.md'), changelog);
  report(problems(load(), { requireChangelog: true })); // belt and braces: what we just wrote must pass the check

  if (useGit) {
    env.git(
      'add',
      ...PACKAGE_FILES,
      'packages/plugin/manifest.json',
      'versions.json',
      'package-lock.json',
      'CHANGELOG.md',
    );
    env.git('commit', '-m', `Release ${next}`);
    env.git('tag', '-a', next, '-m', next);
    out.log(
      `Committed "Release ${next}" and tagged ${next}.\nNext: git push origin main ${next}   (the tag push builds and publishes the GitHub release)`,
    );
  } else {
    out.log('Files updated. Review them, then commit and tag by hand.');
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.exitCode = main(process.argv.slice(2), root, { log: (t) => console.log(t), error: (t) => console.error(t) });
}
