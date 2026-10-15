import { describe, expect, it } from 'vitest';
import { summaryMarkdown, type Summary } from '../quality/coverage-summary';

const metric = (covered: number, total: number) => ({
  covered,
  total,
  pct: total === 0 ? 100 : (covered / total) * 100,
});
const file = (covered: number, total: number) => ({
  lines: metric(covered, total),
  statements: metric(covered, total),
  functions: metric(covered, total),
  branches: metric(covered, total),
});

describe('summaryMarkdown', () => {
  const summary: Summary = {
    total: file(70, 100),
    '/repo/packages/core/src/a.ts': file(9, 10),
    '/repo/packages/core/src/b.ts': file(1, 10),
    '/repo/packages/cli/src/c.ts': file(10, 10),
    '/repo/scripts/release-lib.ts': file(0, 0),
  };

  it('groups the files per package and pools their counts (not an average of percentages)', () => {
    const md = summaryMarkdown(summary, '/repo');
    expect(md).toContain('| packages/core | 50.0% | 50.0% | 50.0% | 50.0% |');
    expect(md).toContain('| packages/cli | 100.0% | 100.0% | 100.0% | 100.0% |');
  });

  it('shows n/a for a group with nothing to cover, and the overall total in bold', () => {
    const md = summaryMarkdown(summary, '/repo');
    expect(md).toContain('| scripts | n/a | n/a | n/a | n/a |');
    expect(md).toContain('| **All files** | **70.0%** | **70.0%** | **70.0%** | **70.0%** |');
  });

  it('is a valid table: a header, a separator and one row per group, sorted', () => {
    const lines = summaryMarkdown(summary, '/repo')
      .split('\n')
      .filter((l) => l.startsWith('|'));
    expect(lines[0]).toBe('| | Lines | Statements | Functions | Branches |');
    expect(lines[1]).toBe('| --- | --- | --- | --- | --- |');
    expect(lines.slice(2, -1).map((l) => l.split('|')[1]!.trim())).toEqual([
      'packages/cli',
      'packages/core',
      'scripts',
    ]);
  });
});
