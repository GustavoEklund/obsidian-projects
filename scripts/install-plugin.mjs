// Installs the built plugin into a vault.
//   npm run build
//   npm run install:vault -- <vault-path> [--link] [--enable]
//     --link    symlink instead of copy, so `npm run dev` rebuilds show up after an Obsidian reload
//     --enable  also add the plugin to the vault's community-plugins.json (otherwise enable it in Settings)
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const vault = args.find((a) => !a.startsWith('--'));
const ID = 'obsidian-projects';
const FILES = ['main.js', 'manifest.json', 'styles.css'];

if (!vault) {
  console.error('Usage: npm run install:vault -- <vault-path> [--link] [--enable]');
  process.exit(2);
}
const vaultPath = path.resolve(vault);
if (!existsSync(path.join(vaultPath, '.obsidian'))) {
  console.error(`"${vaultPath}" is not an Obsidian vault (no .obsidian folder). Open it in Obsidian once first.`);
  process.exit(1);
}
const dist = path.join(root, 'packages/plugin/dist');
if (!FILES.every((f) => existsSync(path.join(dist, f)))) {
  console.error('Build output missing. Run `npm run build` first.');
  process.exit(1);
}

const target = path.join(vaultPath, '.obsidian/plugins', ID);
await mkdir(target, { recursive: true });
for (const f of FILES) {
  const dest = path.join(target, f);
  await rm(dest, { force: true }); // data.json is never touched
  if (flags.has('--link')) await symlink(path.join(dist, f), dest);
  else await copyFile(path.join(dist, f), dest);
}
console.log(`${flags.has('--link') ? 'Linked' : 'Copied'} ${FILES.join(', ')} → ${target}`);

if (flags.has('--enable')) {
  const file = path.join(vaultPath, '.obsidian/community-plugins.json');
  let list = [];
  try {
    list = JSON.parse(await readFile(file, 'utf8'));
  } catch {}
  if (!list.includes(ID)) await writeFile(file, JSON.stringify([...list, ID], null, 2) + '\n');
  console.log('Enabled in community-plugins.json');
} else {
  console.log('Next: Obsidian → Settings → Community plugins → enable “Projects”.');
}
