import { describe, expect, it } from 'vitest';
import { BUDGETS, median, overBudget, report, type Measurements } from '../quality/cli-perf-lib';

const within: Measurements = { cards: 100, startupMs: 3, listMs: 50, showMs: 10, addMs: 60, binaryMB: 1.4 };

describe('median', () => {
  it('is the middle sample, whatever the order, and the mean of the two middle ones for an even count', () => {
    expect(median([5, 1, 9])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });

  it('does not modify the samples and says NaN for none', () => {
    const samples = [3, 1, 2];
    median(samples);
    expect(samples).toEqual([3, 1, 2]);
    expect(median([])).toBeNaN();
  });
});

describe('overBudget', () => {
  it('accepts measurements within every budget, boundaries included', () => {
    expect(overBudget(within)).toEqual([]);
    expect(overBudget({ ...within, ...BUDGETS })).toEqual([]);
  });

  it('names each budget that is exceeded, with the value and the limit', () => {
    const problems = overBudget({ ...within, startupMs: 60, binaryMB: 9.5 });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('start and print the version');
    expect(problems[0]).toContain('60.0 is over the budget of 25');
    expect(problems[1]).toContain('9.5 is over the budget of 3');
  });

  it('treats a measurement that could not be made as a failure, not as a pass', () => {
    expect(overBudget({ ...within, listMs: Number.NaN })).toEqual(['list the whole vault (ms): could not be measured']);
  });
});

describe('report', () => {
  it('shows every measurement next to its budget', () => {
    const text = report(within);
    expect(text).toContain('Command line on a vault of 100 cards:');
    for (const budget of Object.values(BUDGETS)) expect(text).toContain(`(budget ${budget})`);
    expect(text).toContain('1.4');
  });
});
