import { describe, expect, it } from 'vitest';
import { generate } from '../conformance/frontmatter.fixture';
import { render } from '../conformance/lib';

describe('the frontmatter conformance generator', () => {
  it('is deterministic', () => {
    expect(render(generate())).toBe(render(generate()));
  });

  it('is substantial and covers split, parse and patch', () => {
    const { cases } = generate();
    expect(cases.length).toBeGreaterThan(800);
    for (const kind of ['split', 'parse', 'patch'])
      expect(
        cases.some((c) => c.id.startsWith(`${kind}:`)),
        kind,
      ).toBe(true);
  });

  it('records successful and refused patches, and byte-exact ones', () => {
    const patches = generate()
      .cases.filter((c) => c.id.startsWith('patch:'))
      .map((c) => c.expected as { ok: boolean; exact?: boolean });
    expect(patches.some((p) => p.ok)).toBe(true);
    expect(patches.some((p) => !p.ok)).toBe(true);
    expect(patches.filter((p) => p.exact).length).toBeGreaterThan(100);
  });

  it('parses some hand-written YAML into non-empty objects, some into nothing, and records where the core throws', () => {
    const outcomes = generate()
      .cases.filter((c) => c.id.startsWith('parse:'))
      .map((c) => c.expected as { ok: boolean; value?: object });
    expect(outcomes.some((o) => o.ok && Object.keys(o.value!).length > 0)).toBe(true);
    expect(outcomes.some((o) => o.ok && Object.keys(o.value!).length === 0)).toBe(true);
    expect(outcomes.some((o) => !o.ok)).toBe(true);
  });

  it('keeps tags and aliases in their own group, and lists the explicit tags the core resolves', () => {
    const { cases } = generate();
    expect(cases.filter((c) => c.id.startsWith('exotic:')).length).toBeGreaterThanOrEqual(3);
    const lenient = cases.filter((c) => (c.expected as { lenient?: boolean }).lenient);
    expect(lenient.length).toBeGreaterThan(5);
  });
});
