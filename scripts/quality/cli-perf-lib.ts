// The pure part of the command line's performance gate: the budgets, the median and the comparison. Unit-tested; the
// runner that drives the real binary lives in cli-perf.ts and is exercised by CI.

export interface Budgets {
  /** Milliseconds to start the program and print its version (the TypeScript one, on Node, takes about 50). */
  startupMs: number;
  /** Median milliseconds of `list` over the whole vault. */
  listMs: number;
  /** Median milliseconds of `show` for one card. */
  showMs: number;
  /** Median milliseconds of `add`, which also reads the vault to number the card. */
  addMs: number;
  /** Size of the executable, in MB. */
  binaryMB: number;
}

export const BUDGETS: Budgets = {
  startupMs: 25,
  listMs: 400,
  showMs: 100,
  addMs: 400,
  binaryMB: 3,
};

export interface Measurements extends Record<keyof Budgets, number> {
  cards: number;
}

/** The middle sample (the mean of the two middle ones for an even count); NaN for no samples. */
export function median(samples: number[]): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const LABELS: Record<keyof Budgets, string> = {
  startupMs: 'start and print the version (ms)',
  listMs: 'list the whole vault (ms)',
  showMs: 'show one card (ms)',
  addMs: 'add a card (ms)',
  binaryMB: 'size of the executable (MB)',
};

/** One line per budget that was exceeded (or not measurable). */
export function overBudget(measured: Measurements, budgets: Budgets = BUDGETS): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(budgets) as (keyof Budgets)[]) {
    const value = measured[key];
    if (Number.isNaN(value)) problems.push(`${LABELS[key]}: could not be measured`);
    else if (value > budgets[key])
      problems.push(`${LABELS[key]}: ${value.toFixed(1)} is over the budget of ${budgets[key]}`);
  }
  return problems;
}

export function report(m: Measurements, budgets: Budgets = BUDGETS): string {
  const rows = (Object.keys(budgets) as (keyof Budgets)[]).map(
    (k) => `  ${LABELS[k].padEnd(38)} ${m[k].toFixed(1).padStart(8)}   (budget ${budgets[k]})`,
  );
  return [`Command line on a vault of ${m.cards} cards:`, ...rows].join('\n');
}
