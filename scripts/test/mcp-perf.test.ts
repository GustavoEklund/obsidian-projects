import { describe, expect, it } from 'vitest';
import { BUDGETS, overBudget, percentile, report, type Measurements } from '../quality/mcp-perf-lib';

const within: Measurements = {
  cards: 100,
  idleRssMB: 4,
  initializeMs: 10,
  indexedRssMB: 10,
  firstListMs: 100,
  readP95Ms: 5,
  searchP95Ms: 20,
  writeP95Ms: 20,
  writeGrowthMB: 1,
  concurrentMs: 200,
};

describe('percentile', () => {
  it('uses the nearest-rank method', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile(samples, 100)).toBe(100);
    expect(percentile(samples, 1)).toBe(1);
  });

  it('does not depend on the order of the samples, and does not modify them', () => {
    const samples = [9, 1, 5, 3, 7];
    expect(percentile(samples, 60)).toBe(5);
    expect(samples).toEqual([9, 1, 5, 3, 7]);
  });

  it('copes with one sample, p0 and no samples', () => {
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([3, 4], 0)).toBe(3);
    expect(percentile([], 95)).toBeNaN();
  });
});

describe('overBudget', () => {
  it('accepts measurements within every budget, boundaries included', () => {
    expect(overBudget(within)).toEqual([]);
    expect(overBudget({ ...within, idleRssMB: BUDGETS.idleRssMB })).toEqual([]);
  });

  it('names each budget that is exceeded, with both numbers', () => {
    const problems = overBudget({ ...within, idleRssMB: 40, readP95Ms: 500 });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toBe('idle memory (MB): 40.0 is over the budget of 8');
    expect(problems[1]).toContain('read tools, p95 (ms): 500.0');
  });

  it('treats a missing measurement as a failure instead of a pass', () => {
    expect(overBudget({ ...within, searchP95Ms: Number.NaN })).toEqual([
      'text search, p95 (ms): could not be measured',
    ]);
  });

  it('has a budget for every measurement it reports', () => {
    expect(Object.keys(BUDGETS).sort()).toEqual(
      Object.keys(within)
        .filter((k) => k !== 'cards')
        .sort(),
    );
  });
});

describe('report', () => {
  it('lists every budget with its measured value', () => {
    const text = report(within);
    expect(text).toContain('vault of 100 cards');
    expect(text).toContain('idle memory (MB)');
    expect(text).toContain('(budget 8)');
    expect(text.split('\n')).toHaveLength(1 + Object.keys(BUDGETS).length);
  });
});
