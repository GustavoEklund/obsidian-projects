import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, finish, isMain, readText, repoFiles, root } from '../quality/lib';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'oprojects-lib-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('repoFiles', () => {
  it('lists tracked and untracked files, but not ignored ones, with / separators', () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    git('init', '-q');
    writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\nbuild/\n');
    mkdirSync(path.join(dir, 'src/deep'), { recursive: true });
    mkdirSync(path.join(dir, 'build'));
    writeFileSync(path.join(dir, 'tracked.md'), 'x');
    writeFileSync(path.join(dir, 'src/deep/file.ts'), 'x');
    writeFileSync(path.join(dir, 'ignored.txt'), 'x');
    writeFileSync(path.join(dir, 'build/out.js'), 'x');
    git('add', 'tracked.md');
    expect(repoFiles(dir).sort()).toEqual(['.gitignore', 'src/deep/file.ts', 'tracked.md']);
  });
});

describe('readText', () => {
  it('reads text, including unicode', () => {
    writeFileSync(path.join(dir, 'a.md'), 'Zoë 日本語\n');
    expect(readText('a.md', dir)).toBe('Zoë 日本語\n');
  });

  it('returns null for binary files (a NUL byte) and for files that do not exist', () => {
    writeFileSync(path.join(dir, 'b.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    expect(readText('b.png', dir)).toBeNull();
    expect(readText('missing.md', dir)).toBeNull();
  });
});

describe('paths', () => {
  it('knows the repo root', () => {
    expect(path.basename(at('package.json'))).toBe('package.json');
    expect(at('scripts')).toBe(path.join(root, 'scripts'));
  });

  it('isMain is true only for the script being run', () => {
    expect(isMain(new URL('file:///definitely/not/the/entry.ts').href)).toBe(false);
  });
});

describe('finish', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('prints OK and leaves the exit code alone when there are no problems', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    finish('Gate', []);
    expect(log).toHaveBeenCalledWith('Gate: OK');
    expect(process.exitCode).toBeUndefined();
  });

  it('lists the problems on stderr and sets the exit code to 1', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    finish('Gate', ['first', 'second']);
    expect(error).toHaveBeenCalledWith('Gate: 2 problems\n  - first\n  - second');
    expect(process.exitCode).toBe(1);
  });

  it('uses the singular for one problem', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    finish('Gate', ['only']);
    expect(error).toHaveBeenCalledWith('Gate: 1 problem\n  - only');
  });
});
