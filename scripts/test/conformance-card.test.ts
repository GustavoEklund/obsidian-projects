import { describe, expect, it } from 'vitest';
import { generate } from '../conformance/card.fixture';
import { render } from '../conformance/lib';

describe('the card conformance generator', () => {
  it('is deterministic', () => {
    expect(render(generate())).toBe(render(generate()));
  });

  it('covers every function it checks', () => {
    const { cases } = generate();
    expect(cases.length).toBeGreaterThan(1500);
    for (const kind of ['date', 'key', 'checklist', 'labels', 'parse', 'new', 'same', 'apply'])
      expect(
        cases.some((c) => c.id.startsWith(`${kind}:`)),
        kind,
      ).toBe(true);
  });

  it('parses notes into cards, and some into nothing', () => {
    const parsed = generate()
      .cases.filter((c) => c.id.startsWith('parse:'))
      .map((c) => (c.expected as { ok: boolean; value: unknown }).value);
    expect(parsed.filter((v) => v !== null).length).toBeGreaterThan(300);
    expect(parsed.filter((v) => v === null).length).toBeGreaterThan(10);
  });

  it('writes new cards, some of which are expected byte for byte', () => {
    const written = generate()
      .cases.filter((c) => c.id.startsWith('new:'))
      .map((c) => c.expected as { ok: boolean; exact: boolean });
    expect(written.every((w) => w.ok)).toBe(true);
    expect(written.filter((w) => w.exact).length).toBeGreaterThan(40);
  });

  it('reports both outcomes of the equality and date checks', () => {
    const { cases } = generate();
    for (const kind of ['same', 'date']) {
      const outcomes = cases.filter((c) => c.id.startsWith(`${kind}:`)).map((c) => c.expected);
      expect(outcomes).toContain(true);
      expect(outcomes).toContain(false);
    }
  });
});
