import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CONFIG, normalizeConfig, type BoardConfig } from '../config';

/** The plugin's `data.json`; the CLI/MCP read the board config from the same file. */
export const PLUGIN_ID = 'obsidian-projects';
export const PLUGIN_DATA_PATH = `.obsidian/plugins/${PLUGIN_ID}/data.json`;

export class VaultNotFoundError extends Error {}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where the vault is: explicit path (flag/env) wins, otherwise the nearest
 * ancestor of `start` that has an `.obsidian` folder.
 */
export async function findVaultRoot(start: string, explicit?: string): Promise<string> {
  if (explicit) {
    const root = path.resolve(explicit);
    if (!(await isDir(path.join(root, '.obsidian'))))
      throw new VaultNotFoundError(`"${root}" is not an Obsidian vault (no .obsidian folder)`);
    return root;
  }
  let dir = path.resolve(start);
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- walking up one folder at a time, stopping at the first vault
    if (await isDir(path.join(dir, '.obsidian'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new VaultNotFoundError(
        'No Obsidian vault found. Run inside a vault, or pass --vault <path> / set OPROJECTS_VAULT.',
      );
    }
    dir = parent;
  }
}

async function readPluginData(root: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(root, PLUGIN_DATA_PATH), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function loadBoardConfig(root: string): Promise<BoardConfig> {
  const data = await readPluginData(root);
  return normalizeConfig(data.board ?? DEFAULT_CONFIG);
}

/** Writes `board` while keeping any other settings the plugin stored. */
export async function saveBoardConfig(root: string, board: BoardConfig): Promise<void> {
  const data = await readPluginData(root);
  const file = path.join(root, PLUGIN_DATA_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...data, board }, null, 2) + '\n', 'utf8');
}

export async function hasBoardConfig(root: string): Promise<boolean> {
  return 'board' in (await readPluginData(root));
}
