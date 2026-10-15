// Runs once before the process-level MCP tests: the binary must exist, run, and carry the repository's version.
import { execFileSync } from 'node:child_process';
import { binaryPath, repoVersion } from './support';

export default function setup(): void {
  const bin = binaryPath();
  const out = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  const expected = `oprojects-mcp ${repoVersion()}`;
  if (out !== expected) {
    throw new Error(
      `${bin} says "${out}" but the repository is at ${repoVersion()}: rebuild it (\`npm run build -w packages/mcp\`).`,
    );
  }
}
