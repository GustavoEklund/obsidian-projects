// Conformance cases for the ranking functions (packages/core/src/rank.ts), which the Rust crate ports.
import { isValidRank, rankBetween, spreadRanks } from '@oprojects/core';
import { attempt } from './outcome';
import { chance, int, pick, rng, type Case, type FixtureFile, type Random } from './lib';

export const name = 'rank';

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const GARBAGE = ['-', ' ', 'é', '日', '.', '_', ' '];

/** A string of base-62 digits; `valid` ones never end in '0'. */
function digits(r: Random, valid: boolean): string {
  const length = int(r, 1, 7);
  let s = '';
  for (let i = 0; i < length; i++) s += pick(r, [...DIGITS]);
  if (valid) while (s.endsWith('0')) s = s.slice(0, -1) + pick(r, Array.from(DIGITS.slice(1)));
  return s;
}

function garbage(r: Random): string {
  let s = digits(r, false);
  const at = int(r, 0, s.length);
  s = s.slice(0, at) + pick(r, GARBAGE) + s.slice(at);
  return chance(r, 0.3) ? '' : s;
}

type Bound = string | null;

function bound(r: Random): Bound {
  const roll = r();
  if (roll < 0.1) return null;
  if (roll < 0.14) return '';
  if (roll < 0.9) return digits(r, true);
  return garbage(r);
}

export function generate(): FixtureFile {
  const r = rng(20261015);
  const cases: Case[] = [];

  // --- isValidRank ----------------------------------------------------------------------------------------------
  const validInputs = [
    '',
    '0',
    'A0',
    'a-b',
    'a b',
    'é',
    '1.5',
    'V',
    'a',
    'zz',
    '1',
    'A',
    'z0z',
    '00',
    '0A',
    '10',
    'Zz9',
    '日本',
  ];
  for (let i = 0; i < 160; i++) validInputs.push(chance(r, 0.6) ? digits(r, chance(r, 0.7)) : garbage(r));
  validInputs.forEach((input, i) => cases.push({ id: `valid:${i}`, input, expected: isValidRank(input) }));

  // --- rankBetween ------------------------------------------------------------------------------------------------
  const pairs: [Bound, Bound][] = [
    [null, null],
    ['V', null],
    [null, 'V'],
    ['', 'V'],
    ['V', ''],
    ['', ''],
    ['b', 'a'],
    ['a', 'a'],
    ['a', 'b'],
    ['A', 'B'],
    ['0V', '1'],
    ['z', 'zz'],
    ['zz', null],
    ['a', 'a0'],
    ['1', '10'],
    ['1', '11'],
    ['1', '2'],
    ['1', '3'],
    ['y', 'z'],
    ['z', 'z1'],
    ['zzz', null],
    ['Vz', 'W'],
    ['é', 'ê'],
    ['a-b', 'c'],
  ];
  for (let i = 0; i < 360; i++) {
    let a = bound(r);
    let b = bound(r);
    if (typeof a === 'string' && typeof b === 'string' && a > b && chance(r, 0.7)) [a, b] = [b, a];
    pairs.push([a, b]);
  }
  pairs.forEach(([a, b], i) =>
    cases.push({ id: `between:${i}`, input: { a, b }, expected: attempt(() => rankBetween(a, b)) }),
  );

  // --- spreadRanks --------------------------------------------------------------------------------------------------
  for (const count of [...Array.from({ length: 41 }, (_, i) => i), 50, 100, 200, 500, 1000]) {
    cases.push({ id: `spread:${count}`, input: count, expected: spreadRanks(count) });
  }

  // --- sequences of insertions ----------------------------------------------------------------------------------------
  // Each op inserts at a position of the current list; the case records the whole list afterwards.
  const kinds: [string, number, (list: string[]) => number][] = [
    ['random', 6, (list) => int(r, 0, list.length)],
    ['top', 2, () => 0],
    ['append', 2, (list) => list.length],
    ['middle', 2, (list) => list.length >> 1],
    ['second', 1, (list) => Math.min(1, list.length)],
  ];
  for (const [kind, copies, position] of kinds) {
    for (let c = 0; c < copies; c++) {
      const length = kind === 'top' ? 200 : 300;
      const list: string[] = [];
      const ops: number[] = [];
      for (let i = 0; i < length; i++) {
        const at = position(list);
        ops.push(at);
        list.splice(at, 0, rankBetween(list[at - 1] ?? null, list[at] ?? null));
      }
      cases.push({ id: `insert:${kind}:${c}`, input: ops, expected: list });
    }
  }

  return {
    description: 'rankBetween (value or error message), isValidRank, spreadRanks and whole insertion sequences.',
    cases,
  };
}
