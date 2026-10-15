// Fills a vault with demo cards:  npm run seed [-- <vault-path>]   (default: ./dev-vault)
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { newCardContent } from '@oprojects/core';
import { FsStorage, saveBoardConfig } from '@oprojects/core/node';
import { SAMPLE_CONFIG, sampleCards } from './sample';

async function main() {
  const vault = path.resolve(process.argv[2] ?? 'dev-vault');
  await mkdir(path.join(vault, '.obsidian'), { recursive: true });
  await saveBoardConfig(vault, SAMPLE_CONFIG);

  const storage = new FsStorage(vault);
  let created = 0;
  let skipped = 0;
  for (const card of sampleCards()) {
    try {
      await storage.create(card.path, newCardContent(card));
      created++;
    } catch {
      skipped++; // already seeded; never overwrite
    }
  }
  console.log(`Seeded ${vault}: ${created} cards created, ${skipped} already existed.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
