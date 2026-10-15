import { describe, expect, it } from 'vitest';
import { generate } from '../conformance/config.fixture';
import { render } from '../conformance/lib';

describe('the config conformance generator', () => {
  it('is deterministic', () => {
    expect(render(generate())).toBe(render(generate()));
  });

  it('is substantial and covers every group of case', () => {
    const { cases } = generate();
    expect(cases.length).toBeGreaterThan(1000);
    for (const group of ['prefix', 'slug', 'folder', 'normalize', 'helper'])
      expect(cases.some((c) => c.id.startsWith(`${group}:`))).toBe(true);
  });

  it('produces both default and customised boards, and rejected and accepted prefixes', () => {
    const { cases } = generate();
    const prefixes = cases.filter((c) => c.id.startsWith('prefix:')).map((c) => c.expected);
    expect(prefixes).toContain(true);
    expect(prefixes).toContain(false);
    const normalized = cases
      .filter((c) => c.id.startsWith('normalize:'))
      .map((c) => (c.expected as { prefix: string }).prefix);
    expect(new Set(normalized).size).toBeGreaterThan(3);
  });
});
