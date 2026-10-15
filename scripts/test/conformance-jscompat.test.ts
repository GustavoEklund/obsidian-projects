import { describe, expect, it } from 'vitest';
import { generate } from '../conformance/jscompat.fixture';
import { render } from '../conformance/lib';

describe('the jscompat conformance generator', () => {
  it('is deterministic', () => {
    expect(render(generate())).toBe(render(generate()));
  });

  it('is substantial, with parsed dates and rejected ones', () => {
    const { cases } = generate();
    expect(cases.length).toBeGreaterThan(700);
    const dates = cases.filter((c) => c.id.startsWith('date:'));
    expect(dates.some((c) => c.expected !== null)).toBe(true);
    expect(dates.some((c) => c.expected === null)).toBe(true);
  });

  it('does not depend on the timezone of the machine', async () => {
    const { execFileSync } = await import('node:child_process');
    const run = (tz: string) =>
      execFileSync(
        'npx',
        [
          'tsx',
          '-e',
          "import('./scripts/conformance/jscompat.fixture').then(async (m) => { const l = await import('./scripts/conformance/lib'); const generate = m.generate ?? m.default.generate; const render = l.render ?? l.default.render; process.stdout.write(render(generate())); })",
        ],
        {
          env: { ...process.env, TZ: tz },
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        },
      );
    expect(run('America/Sao_Paulo')).toBe(run('Asia/Kolkata'));
  }, 60_000);
});
