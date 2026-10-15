import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, normalizeConfig, type BoardConfig } from '../src/config';
import {
  PLUGIN_DATA_PATH,
  PLUGIN_ID,
  VaultNotFoundError,
  findVaultRoot,
  hasBoardConfig,
  loadBoardConfig,
  saveBoardConfig,
} from '../src/node';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'oprojects-vault-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const makeVault = async (dir: string) => mkdir(path.join(dir, '.obsidian'), { recursive: true });
const writeData = async (dir: string, content: string) => {
  const file = path.join(dir, PLUGIN_DATA_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
};

describe('plugin constants', () => {
  it('keep the data file where Obsidian puts a plugin with this id', () => {
    expect(PLUGIN_ID).toBe('obsidian-projects');
    expect(PLUGIN_DATA_PATH).toBe('.obsidian/plugins/obsidian-projects/data.json');
  });
});

describe('findVaultRoot', () => {
  it('returns an explicit vault when it has an .obsidian folder, resolving relative paths', async () => {
    await makeVault(root);
    expect(await findVaultRoot('/somewhere/else', root)).toBe(root);
    expect(await findVaultRoot('/somewhere/else', path.join(root, 'sub', '..'))).toBe(root);
    const rel = path.relative(process.cwd(), root);
    expect(await findVaultRoot('/', rel)).toBe(root);
  });

  it('rejects an explicit folder that is not a vault, naming it', async () => {
    const error = await findVaultRoot(root, root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultNotFoundError);
    expect((error as Error).message).toContain(root);
    expect((error as Error).message).toContain('no .obsidian folder');
  });

  it('rejects an explicit folder that does not exist at all', async () => {
    await expect(findVaultRoot(root, path.join(root, 'missing'))).rejects.toThrow(VaultNotFoundError);
  });

  it('does not let the starting point override an explicit vault, even when the start is inside another vault', async () => {
    const other = path.join(root, 'other');
    const chosen = path.join(root, 'chosen');
    await makeVault(other);
    await makeVault(chosen);
    expect(await findVaultRoot(other, chosen)).toBe(chosen);
  });

  it('walks up from a nested folder to the nearest vault', async () => {
    await makeVault(root);
    const deep = path.join(root, 'a', 'b', 'c');
    await mkdir(deep, { recursive: true });
    expect(await findVaultRoot(deep)).toBe(root);
    expect(await findVaultRoot(root)).toBe(root);
  });

  it('prefers the nearest vault when vaults are nested', async () => {
    const inner = path.join(root, 'work', 'inner');
    await makeVault(root);
    await makeVault(inner);
    const start = path.join(inner, 'notes');
    await mkdir(start, { recursive: true });
    expect(await findVaultRoot(start)).toBe(inner);
  });

  it('ignores an .obsidian that is a file, and keeps walking', async () => {
    await makeVault(root);
    const fake = path.join(root, 'fake');
    await mkdir(fake);
    await writeFile(path.join(fake, '.obsidian'), 'not a folder');
    expect(await findVaultRoot(fake)).toBe(root);
  });

  it('throws a helpful error when no ancestor is a vault', async () => {
    const error = await findVaultRoot(root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultNotFoundError);
    expect((error as Error).message).toContain('--vault');
    expect((error as Error).message).toContain('OPROJECTS_VAULT');
  });
});

describe('loadBoardConfig', () => {
  it('returns the defaults when there is no data file', async () => {
    await makeVault(root);
    expect(await loadBoardConfig(root)).toEqual(DEFAULT_CONFIG);
  });

  it.each([
    ['empty file', ''],
    ['corrupt JSON', '{ "board": '],
    ['JSON null', 'null'],
    ['a number', '42'],
    ['a string', '"board"'],
    ['an array', '[1, 2, 3]'],
    ['no board key', '{ "version": 1 }'],
    ['board is null', '{ "board": null }'],
    ['board is a string', '{ "board": "nope" }'],
  ])('falls back to the defaults for %s', async (_name, content) => {
    await writeData(root, content);
    expect(await loadBoardConfig(root)).toEqual(DEFAULT_CONFIG);
  });

  it('normalizes a hand-edited board: invalid values become defaults, the rest is kept', async () => {
    await writeData(
      root,
      JSON.stringify({
        version: 1,
        board: {
          prefix: 'web',
          folder: '../../Work\\Board/',
          me: ' Ana ',
          hideDoneAfterDays: -5,
          columns: [
            { id: 'Backlog!', name: 'Backlog' },
            { id: 'backlog', name: 'dup' },
            { id: 'done', name: 'Done', done: true, wip: 'x' },
          ],
          members: ['Ana', 'Ana', 7],
        },
      }),
    );
    const config = await loadBoardConfig(root);
    expect(config).toEqual<BoardConfig>({
      prefix: 'WEB',
      folder: 'Work/Board',
      me: 'Ana',
      hideDoneAfterDays: 14,
      columns: [
        { id: 'backlog', name: 'Backlog' },
        { id: 'done', name: 'Done', done: true },
      ],
      members: ['Ana'],
    });
  });

  it('tolerates a BOM and CRLF in the data file only if it is still valid JSON (otherwise defaults)', async () => {
    await writeData(root, `{\r\n  "board": { "prefix": "CRLF" }\r\n}\r\n`);
    expect((await loadBoardConfig(root)).prefix).toBe('CRLF');
    await writeData(root, `﻿{ "board": { "prefix": "BOM" } }`);
    expect((await loadBoardConfig(root)).prefix).toBe(DEFAULT_CONFIG.prefix);
  });
});

describe('hasBoardConfig', () => {
  it('is true only when the data file has a `board` key', async () => {
    await makeVault(root);
    expect(await hasBoardConfig(root)).toBe(false);
    await writeData(root, '{ "version": 1 }');
    expect(await hasBoardConfig(root)).toBe(false);
    await writeData(root, 'garbage');
    expect(await hasBoardConfig(root)).toBe(false);
    await writeData(root, '{ "board": {} }');
    expect(await hasBoardConfig(root)).toBe(true);
    await writeData(root, '{ "board": null }');
    expect(await hasBoardConfig(root)).toBe(true);
  });
});

describe('saveBoardConfig', () => {
  it('creates the plugin folder and writes pretty JSON ending with a newline', async () => {
    await makeVault(root);
    const config = normalizeConfig({ prefix: 'SAVE', me: 'Ana' });
    await saveBoardConfig(root, config);
    const text = await readFile(path.join(root, PLUGIN_DATA_PATH), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "board": {');
    expect(JSON.parse(text)).toEqual({ board: config });
  });

  it('keeps every other setting the plugin stored next to the board', async () => {
    await writeData(root, JSON.stringify({ version: 1, ui: { drawerWidth: 480 }, board: { prefix: 'OLD' } }));
    await saveBoardConfig(root, normalizeConfig({ prefix: 'NEW' }));
    const data = JSON.parse(await readFile(path.join(root, PLUGIN_DATA_PATH), 'utf8')) as Record<string, unknown>;
    expect(data.version).toBe(1);
    expect(data.ui).toEqual({ drawerWidth: 480 });
    expect((data.board as BoardConfig).prefix).toBe('NEW');
  });

  it('replaces a corrupt data file instead of failing', async () => {
    await writeData(root, '{ not json');
    await saveBoardConfig(root, normalizeConfig({ prefix: 'FIX' }));
    expect((await loadBoardConfig(root)).prefix).toBe('FIX');
  });

  it('round-trips: loading what was saved gives the same normalized config', async () => {
    const config = normalizeConfig({
      prefix: 'RT',
      folder: 'Deep/Folder',
      me: 'Zoë',
      hideDoneAfterDays: 0,
      members: ['Zoë', 'Bruno'],
      columns: [
        { id: 'a', name: 'A', wip: 2 },
        { id: 'z', name: 'Z', done: true },
      ],
    });
    await saveBoardConfig(root, config);
    expect(await loadBoardConfig(root)).toEqual(config);
    expect(await hasBoardConfig(root)).toBe(true);
  });

  it('is idempotent: saving twice leaves the same bytes', async () => {
    const config = normalizeConfig({ prefix: 'TWICE' });
    await saveBoardConfig(root, config);
    const first = await readFile(path.join(root, PLUGIN_DATA_PATH), 'utf8');
    await saveBoardConfig(root, config);
    expect(await readFile(path.join(root, PLUGIN_DATA_PATH), 'utf8')).toBe(first);
  });
});
