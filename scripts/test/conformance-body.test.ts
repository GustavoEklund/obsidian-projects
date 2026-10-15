import { describe, expect, it } from 'vitest';
import { generate } from '../conformance/body.fixture';
import { render } from '../conformance/lib';

describe('the body conformance generator', () => {
  it('is deterministic', () => {
    expect(render(generate())).toBe(render(generate()));
  });

  it('is substantial and covers every function', () => {
    const { cases } = generate();
    expect(cases.length).toBeGreaterThan(2000);
    for (const kind of [
      'split',
      'join',
      'parse',
      'clean-author',
      'format',
      'section',
      'add',
      'edit',
      'remove',
      'toggle',
    ]) {
      expect(
        cases.some((c) => c.id.startsWith(`${kind}:`)),
        kind,
      ).toBe(true);
    }
  });

  it('really spreads the formatting over timezones', () => {
    const offsets = new Set(
      generate()
        .cases.filter((c) => c.id.startsWith('format:'))
        .map((c) => (c.input as { offset: number }).offset),
    );
    expect(offsets.size).toBeGreaterThan(4);
    expect([...offsets].some((o) => o % 60 !== 0)).toBe(true); // +5:30, +5:45, +10:30
  });

  it('finds real comments in the parsed documents', () => {
    const parsed = generate()
      .cases.filter((c) => c.id.startsWith('parse:'))
      .filter((c) => (c.expected as unknown[]).length > 0);
    expect(parsed.length).toBeGreaterThan(100);
  });
});
