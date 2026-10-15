// Builds the CLI, the Obsidian plugin and the browser harness with esbuild.
//   node scripts/build.mjs            production build
//   node scripts/build.mjs --watch    rebuild on change
import { build, context } from 'esbuild';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);
const watch = process.argv.includes('--watch');
const prod = !watch;

// The shipped bundles embed `yaml` (ISC), whose license asks that its notice travel with every copy.
const yamlPkg = JSON.parse(await readFile(at('node_modules/yaml/package.json'), 'utf8'));
const yamlLicense = (await readFile(at('node_modules/yaml/LICENSE'), 'utf8')).trim().split('\n');
const legalNotice = [
  '/*!',
  ` * Obsidian Projects ${JSON.parse(await readFile(at('package.json'), 'utf8')).version}: released into the public domain (Unlicense).`,
  ' * https://github.com/GustavoEklund/obsidian-projects',
  ' *',
  ` * This bundle includes yaml ${yamlPkg.version} (${yamlPkg.license}):`,
  ' *',
  ...yamlLicense.map((l) => ` * ${l}`.trimEnd()),
  ' */',
].join('\n');

const targets = [
  {
    name: 'cli',
    entry: at('packages/cli/src/main.ts'),
    options: {
      outfile: at('packages/cli/dist/oprojects.cjs'),
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      banner: { js: `#!/usr/bin/env node\n${legalNotice}` },
    },
    after: () => chmod(at('packages/cli/dist/oprojects.cjs'), 0o755),
  },
  {
    name: 'plugin',
    entry: at('packages/plugin/src/main.ts'),
    options: {
      outfile: at('packages/plugin/dist/main.js'),
      platform: 'browser',
      target: 'es2020',
      format: 'cjs',
      external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
      minify: prod,
      sourcemap: prod ? false : 'inline',
      treeShaking: true,
      banner: { js: legalNotice },
      logLevel: 'info',
    },
    after: async () => {
      await mkdir(at('packages/plugin/dist'), { recursive: true });
      await copyFile(at('packages/plugin/manifest.json'), at('packages/plugin/dist/manifest.json'));
      await copyFile(at('packages/plugin/src/styles.css'), at('packages/plugin/dist/styles.css'));
    },
  },
  {
    name: 'harness',
    entry: at('packages/plugin/dev/harness.ts'),
    options: {
      outfile: at('packages/plugin/dev/harness.js'),
      platform: 'browser',
      target: 'es2022',
      format: 'iife',
      sourcemap: 'inline',
    },
  },
];

for (const t of targets) {
  if (!existsSync(t.entry)) {
    console.log(`- skip ${t.name} (no ${path.relative(root, t.entry)} yet)`);
    continue;
  }
  const options = { entryPoints: [t.entry], bundle: true, logLevel: 'warning', ...t.options };
  if (watch) {
    const ctx = await context({
      ...options,
      plugins: [
        {
          name: 'after',
          setup: (b) =>
            b.onEnd(async () => {
              await t.after?.();
              console.log(`✓ ${t.name} rebuilt`);
            }),
        },
      ],
    });
    await ctx.watch();
  } else {
    await build(options);
    await t.after?.();
    console.log(`✓ ${t.name}`);
  }
}
if (watch) console.log('watching… (ctrl+c to stop)');
