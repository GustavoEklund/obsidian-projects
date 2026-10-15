import { describe, expect, it } from 'vitest';
import { isValidRank, rankBetween, spreadRanks } from '../src/rank';

const sorted = (xs: string[]) => [...xs].sort();
const isStrictlyAscending = (xs: string[]) => xs.every((x, i) => i === 0 || xs[i - 1]! < x);

describe('rankBetween', () => {
  it('gives a first rank when the column is empty', () => {
    const r = rankBetween(null, null);
    expect(isValidRank(r)).toBe(true);
  });

  it('sorts strictly between its bounds', () => {
    const a = rankBetween(null, null);
    const c = rankBetween(a, null);
    const b = rankBetween(a, c);
    expect(a < b && b < c).toBe(true);
  });

  it('can go above the first and below the last card', () => {
    const first = rankBetween(null, null);
    const above = rankBetween(null, first);
    const below = rankBetween(first, null);
    expect(above < first && first < below).toBe(true);
  });

  it('rejects inverted or equal bounds', () => {
    expect(() => rankBetween('b', 'a')).toThrow('must sort before');
    expect(() => rankBetween('a', 'a')).toThrow('must sort before');
  });

  it('never produces a trailing zero or invalid digit', () => {
    let a: string | null = null;
    for (let i = 0; i < 300; i++) {
      a = rankBetween(a, null);
      expect(isValidRank(a)).toBe(true);
    }
  });

  it('keeps a strict total order under random insertions at random positions', () => {
    // Deterministic PRNG so a failure is reproducible.
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const list: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(rnd() * (list.length + 1));
      const r = rankBetween(list[at - 1] ?? null, list[at] ?? null);
      expect(isValidRank(r)).toBe(true);
      list.splice(at, 0, r);
    }
    expect(isStrictlyAscending(list)).toBe(true);
    expect(sorted(list)).toEqual(list);
  });

  it('keeps ranks short for the common append-only case', () => {
    const ranks = spreadRanks(1000);
    expect(isStrictlyAscending(ranks)).toBe(true);
    expect(Math.max(...ranks.map((r) => r.length))).toBeLessThan(40);
  });

  it('keeps ranks reasonable when always inserting at the very top', () => {
    let top: string | null = null;
    let longest = 0;
    const ranks: string[] = [];
    for (let i = 0; i < 200; i++) {
      const next: string = rankBetween(null, top);
      ranks.push(next);
      top = next;
      longest = Math.max(longest, next.length);
    }
    expect(isStrictlyAscending([...ranks].reverse())).toBe(true); // each new top sorts before the previous one
    expect(longest).toBeLessThan(60);
  });
});
