// Infrastructure of the conformance corpus: the TypeScript core is the reference implementation, and the Rust MCP server
// (packages/mcp) is tested against fixtures generated from it. A generator is a module `scripts/conformance/<name>.fixture.ts`
// that exports `name` and `generate()`; `npm run conformance` writes packages/mcp/tests/fixtures/<name>.json and
// `npm run conformance:check` (a CI gate) fails when a committed fixture differs from what the generator produces now.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { at } from '../quality/lib';

export const FIXTURE_DIR = at('packages/mcp/tests/fixtures');

export interface Case {
  /** Unique within the fixture; says what the case is about. */
  id: string;
  input: unknown;
  expected: unknown;
}

export interface FixtureFile {
  /** What the cases exercise, for whoever reads the JSON. */
  description: string;
  cases: Case[];
}

export interface Generator {
  name: string;
  /** Generators that drive an asynchronous service return a promise. */
  generate: () => FixtureFile | Promise<FixtureFile>;
}

/** A small seeded PRNG (mulberry32): the same seed always gives the same cases, on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Random = ReturnType<typeof rng>;

export const int = (r: Random, min: number, max: number): number => min + Math.floor(r() * (max - min + 1));
export const pick = <T>(r: Random, items: readonly T[]): T => items[int(r, 0, items.length - 1)]!;
export const chance = (r: Random, p: number): boolean => r() < p;

/** Characters that have broken parsers before: quotes, colons, hashes, brackets, unicode, whitespace, backslashes. */
const TRICKY = [
  `'`,
  `"`,
  ':',
  '#',
  '[',
  ']',
  '{',
  '}',
  ',',
  '&',
  '*',
  '!',
  '|',
  '>',
  '%',
  '@',
  '`',
  '\\',
  ' ',
  '  ',
  '-',
  '?',
  '~',
  'é',
  'ß',
  '日',
  '🚀',
  ' ',
  '　',
];
const WORDS = [
  'fix',
  'login',
  'redirect',
  'api',
  'Safari',
  'null',
  'true',
  'false',
  '123',
  '0x1f',
  '1e3',
  'yes',
  'no',
  '2026-10-15',
  'a',
  'Zoë',
];

/** A random short string mixing ordinary words with the characters that tend to need quoting. */
export function text(r: Random, maxParts = 5): string {
  const parts = Array.from({ length: int(r, 0, maxParts) }, () => (chance(r, 0.6) ? pick(r, WORDS) : pick(r, TRICKY)));
  return parts.join(chance(r, 0.7) ? ' ' : '');
}

export function fixturePath(name: string): string {
  return path.join(FIXTURE_DIR, `${name}.json`);
}

/** The exact bytes of a fixture file: stable key order comes from the generators, one case per line keeps diffs readable. */
export function render(file: FixtureFile): string {
  const ids = new Set<string>();
  for (const c of file.cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id "${c.id}"`);
    ids.add(c.id);
  }
  const head = JSON.stringify({ description: file.description });
  return `{${head.slice(1, -1)},"cases":[\n${file.cases.map((c) => `  ${JSON.stringify(c)}`).join(',\n')}\n]}\n`;
}

/** Every generator in this folder, by file name `*.fixture.ts`. */
export async function loadGenerators(
  dir: string = path.dirname(new URL(import.meta.url).pathname),
): Promise<Generator[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.fixture.ts'))
    .sort();
  const out: Generator[] = [];
  for (const f of files) {
    const mod = (await import(path.join(dir, f))) as Partial<Generator>;
    if (typeof mod.name !== 'string' || typeof mod.generate !== 'function')
      throw new Error(`${f} must export \`name\` and \`generate()\``);
    out.push({ name: mod.name, generate: mod.generate });
  }
  return out;
}

/** Writes every fixture; returns the names written. */
export async function writeAll(generators: Generator[], dir: string = FIXTURE_DIR): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const g of generators) {
    // one at a time: some generators set the process time zone
    writeFileSync(path.join(dir, `${g.name}.json`), render(await g.generate()));
    written.push(g.name);
  }
  return written;
}

/** What is out of date: fixtures that differ from their generator, are missing, or have no generator any more. */
export async function staleFixtures(generators: Generator[], dir: string = FIXTURE_DIR): Promise<string[]> {
  const problems: string[] = [];
  for (const g of generators) {
    const file = path.join(dir, `${g.name}.json`);
    if (!existsSync(file)) problems.push(`${g.name}.json is missing: run \`npm run conformance\``);
    else if (readFileSync(file, 'utf8') !== render(await g.generate()))
      problems.push(`${g.name}.json is out of date: run \`npm run conformance\` and commit the result`);
  }
  if (existsSync(dir)) {
    const known = new Set(generators.map((g) => `${g.name}.json`));
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')))
      if (!known.has(f)) problems.push(`${f} has no generator in scripts/conformance`);
  }
  return problems;
}
