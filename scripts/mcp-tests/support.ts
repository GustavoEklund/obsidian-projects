// Shared by the tests that run the real `oprojects-mcp` binary.
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { McpProcess } from '../mcp/client';
import { createVault, type TestVault } from '../mcp/vault';
import { at } from '../quality/lib';

/** The binary under test: `OPROJECTS_MCP_BIN`, else the release build of packages/mcp. Fails clearly when it is missing. */
export function binaryPath(): string {
  const bin = process.env.OPROJECTS_MCP_BIN ?? at('packages/mcp/target/release/oprojects-mcp');
  if (!existsSync(bin)) {
    throw new Error(
      `The oprojects-mcp binary is missing: ${bin}\nBuild it with \`npm run build -w packages/mcp\`, or set OPROJECTS_MCP_BIN to a built binary.`,
    );
  }
  return path.resolve(bin);
}

export const repoVersion = (): string =>
  (JSON.parse(readFileSync(at('package.json'), 'utf8')) as { version: string }).version;

export interface Running {
  server: McpProcess;
  vault: TestVault;
}

/** A throwaway vault of `cards` cards and a server on it, both cleaned up afterwards (even when `fn` throws). */
export async function withServer<T>(
  options: { cards?: number; args?: string[]; env?: Record<string, string | undefined>; initialize?: boolean },
  fn: (running: Running) => Promise<T>,
): Promise<T> {
  const vault = await createVault(options.cards ?? 12);
  const server = McpProcess.start(binaryPath(), ['--vault', vault.root, ...(options.args ?? [])], { env: options.env });
  try {
    if (options.initialize !== false) await server.initialize();
    return await fn({ server, vault });
  } finally {
    await server.close();
    vault.cleanup();
  }
}

/** The text of a tool result, which is what the model reads. */
export const text = (result: { content: { type: string; text?: string }[] }): string =>
  McpProcess.text({ content: result.content });

/** The card keys on the lines of a `list_cards` answer, in order. */
export function listedKeys(answer: string): string[] {
  return answer
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9]+-\d+) \[/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
}
