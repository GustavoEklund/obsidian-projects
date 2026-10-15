// Shared plumbing for the quality-gate scripts in this folder.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const at = (...parts: string[]): string => path.join(root, ...parts);

/** True when the module at `metaUrl` (an `import.meta.url`) is the script being run, not an import. */
export const isMain = (metaUrl: string): boolean =>
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);

/** Every file git knows about (tracked, or untracked but not ignored), relative to the repo root, with `/` separators. */
export function repoFiles(cwd: string = root): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

/** The file as text, or null when it is binary (contains a NUL byte) or unreadable. */
export function readText(file: string, cwd: string = root): string | null {
  try {
    const buffer = readFileSync(path.join(cwd, file));
    return buffer.includes(0) ? null : buffer.toString('utf8');
  } catch {
    return null;
  }
}

/** Prints the problems and exits 1 when there are any. `gate` names the check in the output. */
export function finish(gate: string, problems: string[]): void {
  if (problems.length === 0) {
    console.log(`${gate}: OK`);
    return;
  }
  console.error(
    `${gate}: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exitCode = 1;
}
