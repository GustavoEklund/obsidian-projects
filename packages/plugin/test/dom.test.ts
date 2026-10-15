import { describe, expect, it } from 'vitest';
import { distinctHues, hueOf, initials } from '../src/ui/dom';

const circularDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe('hueOf', () => {
  it('is stable and within 0–359', () => {
    expect(hueOf('OP-1')).toBe(hueOf('OP-1'));
    for (const s of ['', 'a', 'OP-12', 'Ana', 'Zoë']) {
      expect(hueOf(s)).toBeGreaterThanOrEqual(0);
      expect(hueOf(s)).toBeLessThan(360);
    }
  });

  it('gives sequential epic keys clearly different colors', () => {
    const hues = ['OP-1', 'OP-2', 'OP-3'].map(hueOf);
    for (let i = 0; i < hues.length; i++)
      for (let j = i + 1; j < hues.length; j++) expect(circularDistance(hues[i]!, hues[j]!)).toBeGreaterThan(25);
  });
});

describe('distinctHues', () => {
  const minGap = (m: Map<string, number>) => {
    const v = [...m.values()];
    let gap = 360;
    for (let i = 0; i < v.length; i++)
      for (let j = i + 1; j < v.length; j++) gap = Math.min(gap, circularDistance(v[i]!, v[j]!));
    return gap;
  };

  it('keeps the demo team visually apart', () => {
    expect(minGap(distinctHues(['ana', 'bruno', 'carla', 'diego']))).toBeGreaterThanOrEqual(36);
  });

  it('does not depend on input order or duplicates', () => {
    expect(distinctHues(['carla', 'ana', 'bruno', 'ana'])).toEqual(distinctHues(['ana', 'bruno', 'carla']));
  });

  it('keeps a name on its own hash hue when nothing is in the way', () => {
    expect(distinctHues(['ana']).get('ana')).toBe(hueOf('ana'));
  });

  it('degrades gracefully with more names than fit the gap', () => {
    const many = Array.from({ length: 30 }, (_, i) => `person-${i}`);
    const hues = distinctHues(many);
    expect(hues.size).toBe(30);
    for (const h of hues.values()) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe('initials', () => {
  it('uses first+last word, or the first two letters of a single word', () => {
    expect(initials('Ana')).toBe('AN');
    expect(initials('Ana Maria Souza')).toBe('AS');
    expect(initials('  ')).toBe('?');
  });
});
