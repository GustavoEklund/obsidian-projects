import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { distinctHues, hueOf, initials } from '../src/ui/dom';

const circular = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const names = fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 12 });

describe('hueOf (properties)', () => {
  it('is an integer in [0, 360) and a pure function of its input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        const hue = hueOf(s);
        expect(Number.isInteger(hue) && hue >= 0 && hue < 360).toBe(true);
        expect(hueOf(s)).toBe(hue);
      }),
      { numRuns: 300 },
    );
  });

  it('spreads sequential keys: neighbours OP-n and OP-(n+1) rarely look alike', () => {
    let close = 0;
    for (let n = 1; n < 200; n++) if (circular(hueOf(`OP-${n}`), hueOf(`OP-${n + 1}`)) < 10) close++;
    expect(close).toBeLessThan(25); // uniform noise would put ~11% (22) within 10 degrees; a bad hash puts nearly all there
  });

  it('uses the whole wheel', () => {
    const seen = new Set(Array.from({ length: 400 }, (_, i) => Math.floor(hueOf(`key-${i}`) / 30)));
    expect(seen.size).toBe(12);
  });
});

describe('distinctHues (properties)', () => {
  it('never returns 360 (a hue that rounds up from 359.5+ wraps to 0)', () => {
    // Found by the property below: this pair used to produce 360.
    expect([...distinctHues([' j/', 'MJXs[x']).values()].every((h) => h >= 0 && h < 360)).toBe(true);
  });

  it('gives every distinct name exactly one hue in [0, 360)', () => {
    fc.assert(
      fc.property(names, (list) => {
        const hues = distinctHues(list);
        expect(hues.size).toBe(new Set(list).size);
        expect([...hues.values()].every((h) => Number.isInteger(h) && h >= 0 && h < 360)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('does not depend on the order of the names or on duplicates', () => {
    fc.assert(
      fc.property(names, fc.nat(), (list, seed) => {
        const shuffled = [...list].sort((a, b) => ((a.charCodeAt(0) + seed) % 7) - ((b.charCodeAt(0) + seed) % 7));
        expect(distinctHues([...shuffled, ...list])).toEqual(distinctHues(list));
      }),
      { numRuns: 200 },
    );
  });

  it('keeps the first name (alphabetically) on its own hash hue', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 10 }),
        (list) => {
          const first = [...list].sort()[0]!;
          expect(distinctHues(list).get(first)).toBe(hueOf(first));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('keeps small groups apart: three names never end up within 20 degrees of each other', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 3, maxLength: 3 }), (list) => {
        const v = [...distinctHues(list).values()];
        const gaps = [circular(v[0]!, v[1]!), circular(v[0]!, v[2]!), circular(v[1]!, v[2]!)];
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(20);
      }),
      { numRuns: 300 },
    );
  });

  it('is stable as the set grows: names already placed keep their hue when the gap rule leaves them alone', () => {
    // A name only moves off its hash hue to dodge an earlier (alphabetically smaller) name,
    // so adding a name that sorts last never changes anyone else.
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 8 }), (list) => {
        const before = distinctHues(list);
        const added = distinctHues([...list, '￿-last']);
        for (const [name, hue] of before) expect(added.get(name)).toBe(hue);
      }),
      { numRuns: 200 },
    );
  });
});

describe('initials (properties)', () => {
  it('never throws, is uppercase, and gives "?" for a blank name', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (name) => {
        const result = initials(name);
        expect(result).toBe(result.toUpperCase());
        expect(name.trim() !== '' || result === '?').toBe(true); // a blank name always gives "?" (the name "?" does too)
        expect([...result].length).toBeGreaterThanOrEqual(1);
        expect([...result].length).toBeLessThanOrEqual(2 * 2); // two code points, each possibly expanding on uppercasing (ß -> SS)
      }),
      { numRuns: 300 },
    );
  });

  it('uses the first and last word for several words', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 2, maxLength: 5 }), (words) => {
        const expected = `${words[0]![0]}${words.at(-1)![0]}`.toUpperCase();
        expect(initials(words.join('  '))).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});
