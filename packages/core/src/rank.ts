/**
 * Fractional ranking: every card has a string rank and a column is ordered by
 * plain string comparison. Putting a card between two others only needs a rank
 * that sorts between theirs, so moving a card rewrites exactly one file.
 *
 * Ranks are base-62 fractions ("0.xyz" without the "0."), digits in ASCII
 * order so `<` on strings is the numeric order. They never end in '0'.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const LAST = DIGITS[BASE - 1]!;

function digit(ch: string | undefined): number {
  const i = ch === undefined ? 0 : DIGITS.indexOf(ch);
  return i < 0 ? 0 : i;
}

/** A string strictly between `a` ('' = start) and `b` (null = end). Requires a < b. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? digit(a[0]) : 0;
  const db = b !== null ? digit(b[0]) : BASE;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

/** Next rank after `a`: bumps the last digit so sequential appends stay short. */
function after(a: string): string {
  const last = a[a.length - 1]!;
  if (last === LAST) return a + DIGITS[BASE >> 1];
  return a.slice(0, -1) + DIGITS[digit(last) + 1];
}

export function isValidRank(rank: string): boolean {
  return rank.length > 0 && rank[rank.length - 1] !== '0' && [...rank].every((c) => DIGITS.includes(c));
}

/**
 * A rank that sorts strictly between `a` and `b`.
 * `null`/`undefined`/'' for `a` means "top", for `b` means "bottom".
 */
export function rankBetween(a?: string | null, b?: string | null): string {
  const lo = a ?? '';
  const hi = b ?? null;
  if (hi !== null && lo >= hi) throw new Error(`rankBetween: lower bound "${lo}" must sort before upper bound "${hi}"`);
  if (hi === null && lo) return after(lo);
  return midpoint(lo, hi);
}

/** `count` evenly spread, ascending ranks (used when seeding or rebalancing). */
export function spreadRanks(count: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i++) {
    prev = rankBetween(prev, null);
    out.push(prev);
  }
  return out;
}
