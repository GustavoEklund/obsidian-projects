// The pure part of the MCP performance gate: the budgets, percentiles and the comparison. Unit-tested; the runner that
// drives the real binary lives in mcp-perf.ts and is exercised by CI.

export interface Budgets {
  /** Resident memory (MB) after `initialize`, before any card is read. */
  idleRssMB: number;
  /** Milliseconds from spawning the process to the `initialize` response. */
  initializeMs: number;
  /** Resident memory (MB) with the whole vault indexed. */
  indexedRssMB: number;
  /** Milliseconds until the first answer that needs the index (it loads in the background). */
  firstListMs: number;
  /** p95 milliseconds of the read tools once the index is warm. */
  readP95Ms: number;
  /** p95 milliseconds of a text search over every description and comment. */
  searchP95Ms: number;
  /** p95 milliseconds of a write tool (create, update, move, comment). */
  writeP95Ms: number;
  /** Memory growth (MB) across all the writes: a leak check. */
  writeGrowthMB: number;
  /** Milliseconds for 20 simultaneous reads. */
  concurrentMs: number;
}

export const BUDGETS: Budgets = {
  idleRssMB: 8,
  initializeMs: 100,
  indexedRssMB: 22,
  firstListMs: 1500,
  readP95Ms: 15,
  searchP95Ms: 40,
  writeP95Ms: 40,
  writeGrowthMB: 3,
  concurrentMs: 500,
};

export interface Measurements extends Record<keyof Budgets, number> {
  cards: number;
}

/** The p-th percentile (0 to 100) by the nearest-rank method; NaN for no samples. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

const LABELS: Record<keyof Budgets, string> = {
  idleRssMB: 'idle memory (MB)',
  initializeMs: 'time to initialize (ms)',
  indexedRssMB: 'memory with the vault indexed (MB)',
  firstListMs: 'first answer that needs the index (ms)',
  readP95Ms: 'read tools, p95 (ms)',
  searchP95Ms: 'text search, p95 (ms)',
  writeP95Ms: 'write tools, p95 (ms)',
  writeGrowthMB: 'memory growth across writes (MB)',
  concurrentMs: '20 simultaneous reads (ms)',
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
    (k) => `  ${LABELS[k].padEnd(42)} ${m[k].toFixed(1).padStart(8)}   (budget ${budgets[k]})`,
  );
  return [`MCP server on a vault of ${m.cards} cards:`, ...rows].join('\n');
}
