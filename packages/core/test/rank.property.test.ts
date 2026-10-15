import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { isValidRank, rankBetween, spreadRanks } from '../src/rank';

// Property tests run many cases; a loaded machine (CI, parallel test runs) must not trip the default 5 s limit.
vi.setConfig({ testTimeout: 30_000 });

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Any valid rank: base-62 digits, never ending in '0'. */
const rankArb = fc
  .array(fc.constantFrom(...DIGITS), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(''))
  .filter(isValidRank);

/** Two distinct valid ranks, ordered. */
const orderedPair = fc
  .tuple(rankArb, rankArb)
  .filter(([a, b]) => a !== b)
  .map(([a, b]) => (a < b ? ([a, b] as const) : ([b, a] as const)));

describe('isValidRank', () => {
  it('accepts exactly the strings of base-62 digits that do not end in 0', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 10 }), (s) => {
        const expected = s.length > 0 && !s.endsWith('0') && [...s].every((c) => DIGITS.includes(c));
        expect(isValidRank(s)).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it('accepts every generated rank and rejects the usual suspects', () => {
    fc.assert(fc.property(rankArb, (r) => isValidRank(r)));
    for (const bad of ['', '0', 'A0', 'a-b', 'a b', 'é', '1.5']) expect(isValidRank(bad)).toBe(false);
  });
});

describe('rankBetween', () => {
  it('returns a valid rank strictly between any two ordered valid ranks', () => {
    fc.assert(
      fc.property(orderedPair, ([a, b]) => {
        const mid = rankBetween(a, b);
        expect(isValidRank(mid)).toBe(true);
        expect(a < mid).toBe(true);
        expect(mid < b).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('can always go above the first rank (a = top) and below nothing (b = bottom)', () => {
    fc.assert(
      fc.property(rankArb, (r) => {
        const above = rankBetween(null, r);
        expect(isValidRank(above)).toBe(true);
        expect(above < r).toBe(true);
        const below = rankBetween(r, null);
        expect(isValidRank(below)).toBe(true);
        expect(below > r).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('treats undefined, null and the empty string as open bounds', () => {
    const lo = rankBetween(undefined, 'V');
    expect(lo < 'V').toBe(true);
    expect(rankBetween('', 'V')).toBe(lo);
    expect(rankBetween(null, 'V')).toBe(lo);
    expect(isValidRank(rankBetween())).toBe(true);
    expect(rankBetween(undefined, undefined)).toBe(rankBetween(null, null));
  });

  it('refuses inverted or equal bounds, naming them in the message', () => {
    fc.assert(
      fc.property(orderedPair, ([a, b]) => {
        expect(() => rankBetween(b, a)).toThrow(/must sort before/);
        expect(() => rankBetween(a, a)).toThrow(`"${a}"`);
      }),
      { numRuns: 200 },
    );
  });

  it('keeps a strict total order under random insertions at random positions', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 1_000_000 }), { minLength: 1, maxLength: 200 }), (picks) => {
        const ranks: string[] = [];
        for (const pick of picks) {
          const at = pick % (ranks.length + 1); // 0..length: top, between, bottom
          ranks.splice(at, 0, rankBetween(ranks[at - 1] ?? null, ranks[at] ?? null));
        }
        for (let i = 0; i < ranks.length; i++) expect(isValidRank(ranks[i]!)).toBe(true);
        for (let i = 1; i < ranks.length; i++) expect(ranks[i - 1]! < ranks[i]!).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('grows append-only ranks by about one character per 31 appends (never faster)', () => {
    let last: string | null = null;
    for (let i = 1; i <= 2000; i++) {
      last = rankBetween(last, null);
      expect(last.length).toBeLessThanOrEqual(Math.ceil(i / 31) + 1);
    }
  });

  it('degrades gracefully (length grows slowly) when always inserting at the very top', () => {
    let first = rankBetween(null, null);
    for (let i = 0; i < 500; i++) {
      const next = rankBetween(null, first);
      expect(next < first).toBe(true);
      expect(isValidRank(next)).toBe(true);
      first = next;
    }
    expect(first.length).toBeLessThan(120);
  });

  it('keeps splitting the same gap without ever colliding', () => {
    // Always insert right before the last inserted card: the worst case for ever-growing ranks.
    const hi = 'V';
    let lo = 'U';
    const seen = new Set([lo, hi]);
    for (let i = 0; i < 300; i++) {
      const mid = rankBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      expect(seen.has(mid)).toBe(false);
      seen.add(mid);
      lo = mid;
    }
  });
});

describe('spreadRanks', () => {
  it('returns `count` valid, strictly ascending ranks', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 }), (count) => {
        const ranks = spreadRanks(count);
        expect(ranks).toHaveLength(count);
        for (const r of ranks) expect(isValidRank(r)).toBe(true);
        for (let i = 1; i < ranks.length; i++) expect(ranks[i - 1]! < ranks[i]!).toBe(true);
      }),
      { numRuns: 40 },
    );
  });

  it('is a prefix-stable sequence', () => {
    expect(spreadRanks(5)).toEqual(spreadRanks(10).slice(0, 5));
    expect(spreadRanks(0)).toEqual([]);
  });

  it('leaves room to insert between any two neighbours', () => {
    const ranks = spreadRanks(50);
    for (let i = 1; i < ranks.length; i++) {
      const mid = rankBetween(ranks[i - 1], ranks[i]);
      expect(ranks[i - 1]! < mid && mid < ranks[i]!).toBe(true);
    }
  });
});
