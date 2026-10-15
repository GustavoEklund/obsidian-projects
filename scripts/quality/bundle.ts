// Build-artifact gate (run it after `npm run build`). The files in packages/*/dist are what users download, so check them:
//   - size budgets (the board must stay light; raise a budget on purpose, in this file, not by accident);
//   - the plugin only requires `obsidian`: no Node modules, so it keeps working on mobile (isDesktopOnly is false);
//   - every third-party package that got bundled is credited, with its license, in the banner of the bundle;
//   - the plugin bundle loads against a stand-in `obsidian` module and exports a plugin class;
//   - the CLI bundle starts with a shebang and is executable; the dist manifest matches the source manifest and version.
//
//   npm run check:bundle
import { build } from 'esbuild';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import * as vm from 'node:vm';
import { at, finish, isMain } from './lib';

/** Maximum size in bytes of each shipped file. */
export const BUDGETS: Readonly<Record<string, number>> = {
  'packages/plugin/dist/main.js': 240_000,
  'packages/plugin/dist/styles.css': 40_000,
  'packages/cli/dist/oprojects.cjs': 420_000,
};

export function sizeProblems(
  sizes: Record<string, number>,
  budgets: Readonly<Record<string, number>> = BUDGETS,
): string[] {
  const problems: string[] = [];
  for (const [file, limit] of Object.entries(budgets)) {
    const size = sizes[file];
    if (size === undefined) problems.push(`${file}: missing (run \`npm run build\` first)`);
    else if (size > limit) problems.push(`${file}: ${size} bytes is over its budget of ${limit} bytes`);
  }
  return problems;
}

// --- what the plugin requires -------------------------------------------------------------------------------------

/** Module names passed to `require("…")` in a bundle. */
export function requiredModules(source: string): string[] {
  return [...new Set([...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!))];
}

const BUILTINS = new Set(builtinModules);
export const isNodeBuiltin = (name: string): boolean => name.startsWith('node:') || BUILTINS.has(name.split('/')[0]!);

/** The plugin may require `obsidian` (provided by the app) and nothing else. */
export function pluginRequireProblems(source: string): string[] {
  return requiredModules(source)
    .filter((name) => name !== 'obsidian')
    .map(
      (name) =>
        `main.js requires "${name}"${isNodeBuiltin(name) ? ', a Node module, which does not exist on mobile' : ', which the app does not provide'}`,
    );
}

// --- credits -------------------------------------------------------------------------------------------------------

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
}

/** Packages from node_modules that esbuild put into a bundle, from its metafile `inputs`. */
export function packagesInMetafile(inputs: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const file of Object.keys(inputs)) {
    const rest = file.split('node_modules/')[1];
    if (!rest) continue;
    const parts = rest.split('/');
    names.add(rest.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
  }
  return [...names].sort();
}

/** Each bundled package must be credited, with its license, in the comment at the top of the bundle. */
export function creditProblems(bundleName: string, source: string, packages: BundledPackage[]): string[] {
  const header = source.substring(0, source.indexOf('*/') + 2);
  return packages
    .filter((p) => !header.includes(`${p.name} ${p.version} (${p.license})`))
    .map(
      (p) =>
        `${bundleName} bundles ${p.name} ${p.version} (${p.license}) but its notice is not in the banner: add it in scripts/build.mjs`,
    );
}

// --- loading the plugin ----------------------------------------------------------------------------------------------

/** A stand-in for the `obsidian` module: every export is a class that can be extended and constructed. */
export function fakeObsidian(): Record<string, unknown> {
  const classes = new Map<string, unknown>();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string' || prop === '__esModule') return undefined;
        if (!classes.has(prop)) classes.set(prop, function Stub() {});
        return classes.get(prop);
      },
    },
  );
}

/** Evaluates the plugin bundle against the stand-in and returns what it exports. */
export function loadPlugin(source: string): { default?: unknown } {
  const module = { exports: {} as { default?: unknown } };
  const obsidian = fakeObsidian();
  const sandbox = {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name === 'obsidian') return obsidian;
      throw new Error(`unexpected require("${name}")`);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'main.js' });
  return module.exports;
}

// --- the gate ---------------------------------------------------------------------------------------------------------

async function bundledPackages(
  entry: string,
  platform: 'browser' | 'node',
  external: string[],
): Promise<BundledPackage[]> {
  const result = await build({
    entryPoints: [at(entry)],
    bundle: true,
    write: false,
    metafile: true,
    platform,
    format: 'cjs',
    logLevel: 'silent',
    external,
    outfile: 'unused.js',
  });
  return packagesInMetafile(result.metafile.inputs).map((name) => {
    const pkg = JSON.parse(readFileSync(at('node_modules', name, 'package.json'), 'utf8')) as {
      version: string;
      license: string;
    };
    return { name, version: pkg.version, license: pkg.license };
  });
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(at(file), 'utf8')) as T;

export async function checkArtifacts(): Promise<string[]> {
  const problems: string[] = [];
  const sizes: Record<string, number> = {};
  for (const file of Object.keys(BUDGETS)) if (existsSync(at(file))) sizes[file] = statSync(at(file)).size;
  problems.push(...sizeProblems(sizes));
  if (problems.some((p) => p.includes('missing'))) return problems;

  const plugin = readFileSync(at('packages/plugin/dist/main.js'), 'utf8');
  const cli = readFileSync(at('packages/cli/dist/oprojects.cjs'), 'utf8');

  problems.push(...pluginRequireProblems(plugin));
  problems.push(
    ...creditProblems(
      'main.js',
      plugin,
      await bundledPackages('packages/plugin/src/main.ts', 'browser', [
        'obsidian',
        'electron',
        '@codemirror/*',
        '@lezer/*',
      ]),
    ),
  );
  problems.push(...creditProblems('oprojects.cjs', cli, await bundledPackages('packages/cli/src/main.ts', 'node', [])));

  try {
    if (typeof loadPlugin(plugin).default !== 'function')
      problems.push('main.js does not export a plugin class as its default export');
  } catch (e) {
    problems.push(`main.js fails to load: ${(e as Error).message}`);
  }

  if (!cli.startsWith('#!/usr/bin/env node\n'))
    problems.push('oprojects.cjs must start with a `#!/usr/bin/env node` line');
  if ((statSync(at('packages/cli/dist/oprojects.cjs')).mode & 0o111) === 0)
    problems.push('oprojects.cjs is not executable');

  const source = readJson<{ id: string; version: string }>('packages/plugin/manifest.json');
  const dist = readJson<{ id: string; version: string }>('packages/plugin/dist/manifest.json');
  if (JSON.stringify(source) !== JSON.stringify(dist))
    problems.push('packages/plugin/dist/manifest.json differs from packages/plugin/manifest.json: rebuild');
  if (source.version !== readJson<{ version: string }>('package.json').version)
    problems.push('the plugin manifest version differs from package.json');
  if (!existsSync(at('packages/plugin/dist/styles.css')) || statSync(at('packages/plugin/dist/styles.css')).size === 0)
    problems.push('styles.css is missing or empty');
  return problems;
}

if (isMain(import.meta.url)) {
  checkArtifacts().then(
    (problems) => finish('Build-artifact gate', problems),
    (e) => {
      console.error(e);
      process.exitCode = 1;
    },
  );
}
