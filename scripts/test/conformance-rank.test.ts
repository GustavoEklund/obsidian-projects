import { describe, expect, it } from 'vitest';
import { generate } from '../conformance/rank.fixture';
import { render } from '../conformance/lib';

describe('the rank conformance generator', () => {
  it('is deterministic', () => {
    expect(render(generate())).toBe(render(generate()));
  });

  it('is substantial and has all the kinds of case', () => {
    const { cases } = generate();
    expect(cases.length).toBeGreaterThan(550);
    for (const kind of ['valid', 'between', 'spread', 'insert'])
      expect(cases.some((c) => c.id.startsWith(`${kind}:`))).toBe(true);
  });

  it('records both outcomes of rankBetween', () => {
    const outcomes = generate()
      .cases.filter((c) => c.id.startsWith('between:'))
      .map((c) => (c.expected as { ok: boolean }).ok);
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);
  });
});
