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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (file: string) => path.join(root, file);

const PACKAGE_FILES = ['package.json', 'packages/core/package.json', 'packages/cli/package.json', 'packages/plugin/package.json'];
const LOCK_PATHS = ['', 'packages/core', 'packages/cli', 'packages/plugin'];

type Json = Record<string, any>;
const readJson = (file: string): Json => JSON.parse(readFileSync(at(file), 'utf8'));
const writeJson = (file: string, data: unknown) => writeFileSync(at(file), JSON.stringify(data, null, 2) + '\n');

function load(): RepoVersions {
  const lock = readJson('package-lock.json');
  return {
    packages: Object.fromEntries(PACKAGE_FILES.map((f) => [f, readJson(f).version as string | undefined])),
    manifest: readJson('packages/plugin/manifest.json'),
    versions: readJson('versions.json'),
    lock: Object.fromEntries(LOCK_PATHS.map((p) => [p, lock.packages?.[p]?.version as string | undefined])),
    changelog: readFileSync(at('CHANGELOG.md'), 'utf8'),
  };
}

const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function report(list: string[]): void {
  if (!list.length) return;
  console.error(`Version problems:\n${list.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);

if (command === 'check') {
  const tagAt = rest.indexOf('--tag');
  const tag = tagAt >= 0 ? rest[tagAt + 1] : undefined;
  if (tagAt >= 0 && !tag) fail('--tag needs a value');
  const repo = load();
  report(problems(repo, { tag, requireChangelog: tag !== undefined }));
  console.log(`Versions are consistent (${repo.manifest.version}).`);
} else if (command === 'notes') {
  const version = rest[0];
  if (!version) fail('Usage: release.ts notes <version>');
  const notes = extractNotes(readFileSync(at('CHANGELOG.md'), 'utf8'), version);
  if (notes === null) fail(`CHANGELOG.md has no filled-in "## [${version}]" section`);
  console.log(notes);
} else if (command) {
  const spec = command;
  const dryRun = flag('--dry-run');
  const repo = load();
  report(problems(repo)); // never build on top of an inconsistent state

  const current = repo.manifest.version!;
  let next: string;
  try {
    next = bump(current, spec);
  } catch (e) {
    fail((e as Error).message);
  }
  if (compareVersions(next, current) <= 0) fail(`${next} is not newer than the current version ${current}`);
  const date = new Date().toISOString().slice(0, 10);
  const changelog = (() => {
    try {
      return promoteUnreleased(repo.changelog, next, date);
    } catch (e) {
      fail((e as Error).message);
    }
  })();

  const useGit = !flag('--no-git') && !dryRun;
  if (useGit) {
    if (git('status', '--porcelain')) fail('The working tree is not clean. Commit or stash your changes first (or pass --no-git).');
    if (git('tag', '--list', next)) fail(`The tag ${next} already exists.`);
  }

  console.log(`${current} → ${next}${dryRun ? '  (dry run, nothing written)' : ''}`);
  if (dryRun) process.exit(0);

  for (const file of PACKAGE_FILES) writeJson(file, { ...readJson(file), version: next });
  writeJson('packages/plugin/manifest.json', { ...repo.manifest, version: next });
  writeJson('versions.json', { ...repo.versions, [next]: repo.manifest.minAppVersion });
  const lock = readJson('package-lock.json');
  lock.version = next;
  for (const p of LOCK_PATHS) if (lock.packages?.[p]) lock.packages[p].version = next;
  writeJson('package-lock.json', lock);
  writeFileSync(at('CHANGELOG.md'), changelog);
  report(problems(load(), { requireChangelog: true })); // belt and braces: what we just wrote must pass the check

  if (useGit) {
    git('add', ...PACKAGE_FILES, 'packages/plugin/manifest.json', 'versions.json', 'package-lock.json', 'CHANGELOG.md');
    git('commit', '-m', `Release ${next}`);
    git('tag', '-a', next, '-m', next);
    console.log(`Committed "Release ${next}" and tagged ${next}.\nNext: git push origin main ${next}   (the tag push builds and publishes the GitHub release)`);
  } else {
    console.log('Files updated. Review them, then commit and tag by hand.');
  }
} else {
  fail('Usage: release.ts check [--tag <tag>] | notes <version> | <major|minor|patch|x.y.z> [--dry-run] [--no-git]');
}
