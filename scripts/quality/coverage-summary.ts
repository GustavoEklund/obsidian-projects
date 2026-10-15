// Prints the coverage report as a Markdown table (CI adds it to the job summary).
//   npm run test:coverage && tsx scripts/quality/coverage-summary.ts >> "$GITHUB_STEP_SUMMARY"
import { existsSync, readFileSync } from 'node:fs';
import { at, isMain } from './lib';

interface Metric {
  total: number;
  covered: number;
  pct: number;
}
export interface Summary {
  total: Record<'lines' | 'statements' | 'functions' | 'branches', Metric>;
  [file: string]: Record<string, Metric>;
}

const pct = (m: Metric | undefined) => (m ? `${m.pct.toFixed(1)}%` : 'n/a');

/** A Markdown table: the total and one row per package (core, cli, plugin, scripts). */
export function summaryMarkdown(summary: Summary, root: string): string {
  const groups = new Map<
    string,
    Record<'lines' | 'statements' | 'functions' | 'branches', { total: number; covered: number }>
  >();
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue;
    const rel = file.startsWith(root) ? file.slice(root.length).replace(/^\//, '') : file;
    const parts = rel.split('/');
    const group = parts[0] === 'packages' ? `packages/${parts[1]}` : (parts[0] ?? rel);
    const acc = groups.get(group) ?? {
      lines: { total: 0, covered: 0 },
      statements: { total: 0, covered: 0 },
      functions: { total: 0, covered: 0 },
      branches: { total: 0, covered: 0 },
    };
    for (const key of ['lines', 'statements', 'functions', 'branches'] as const) {
      acc[key].total += metrics[key]?.total ?? 0;
      acc[key].covered += metrics[key]?.covered ?? 0;
    }
    groups.set(group, acc);
  }
  const ratio = (m: { total: number; covered: number }) =>
    m.total === 0 ? 'n/a' : `${((m.covered / m.total) * 100).toFixed(1)}%`;
  const rows = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, m]) =>
        `| ${name} | ${ratio(m.lines)} | ${ratio(m.statements)} | ${ratio(m.functions)} | ${ratio(m.branches)} |`,
    );
  return [
    '### Test coverage',
    '',
    '| | Lines | Statements | Functions | Branches |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    `| **All files** | **${pct(summary.total.lines)}** | **${pct(summary.total.statements)}** | **${pct(summary.total.functions)}** | **${pct(summary.total.branches)}** |`,
    '',
  ].join('\n');
}

if (isMain(import.meta.url)) {
  const file = at('coverage/coverage-summary.json');
  if (!existsSync(file)) {
    console.error('coverage/coverage-summary.json is missing: run `npm run test:coverage` first.');
    process.exit(1);
  }
  console.log(summaryMarkdown(JSON.parse(readFileSync(file, 'utf8')) as Summary, at()));
}
