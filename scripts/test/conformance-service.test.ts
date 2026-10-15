import { describe, expect, it } from 'vitest';
import { generate } from '../conformance/service.fixture';
import { render } from '../conformance/lib';

type Outcome = { ok: true; value: unknown } | { ok: false; kind: string; error: string };
type Expected = { exactText: boolean; outcomes: Outcome[]; files: { path: string; text?: string; card: unknown }[] };

describe('the service conformance generator', () => {
  it('is deterministic', async () => {
    expect(render(await generate())).toBe(render(await generate()));
  });

  it('has hand-written and random scenarios, with enough steps to mean something', async () => {
    const { cases } = await generate();
    expect(cases.filter((c) => c.id.startsWith('scenario:')).length).toBeGreaterThan(15);
    expect(cases.filter((c) => c.id.startsWith('ordinary:')).length).toBeGreaterThan(80);
    expect(cases.filter((c) => c.id.startsWith('tricky:')).length).toBeGreaterThan(50);
    const steps = cases.reduce((n, c) => n + (c.expected as Expected).outcomes.length, 0);
    expect(steps).toBeGreaterThan(2500);
  });

  it('records errors of every kind the service can throw, and successes of every operation', async () => {
    const { cases } = await generate();
    const kinds = new Set<string>();
    const succeeded = new Set<string>();
    for (const c of cases) {
      const scenario = c.input as { steps: { op: string }[] };
      (c.expected as Expected).outcomes.forEach((outcome, i) => {
        if (outcome.ok) succeeded.add(scenario.steps[i]!.op);
        else kinds.add(outcome.kind);
      });
    }
    expect([...kinds].sort()).toEqual(expect.arrayContaining(['not_found', 'validation']));
    for (const op of [
      'create',
      'update',
      'move',
      'remove',
      'get',
      'find',
      'list',
      'addComment',
      'editComment',
      'removeComment',
      'resolveKey',
      'checkStatus',
    ])
      expect(succeeded.has(op), op).toBe(true);
  });

  it('keeps the text of the notes only where the two YAML writers are expected to agree', async () => {
    const { cases } = await generate();
    const exact = cases.filter((c) => (c.expected as Expected).exactText);
    expect(exact.length).toBeGreaterThan(80);
    for (const c of exact)
      for (const f of (c.expected as Expected).files) expect(typeof f.text, `${c.id} ${f.path}`).toBe('string');
    for (const c of cases.filter((x) => !(x.expected as Expected).exactText))
      for (const f of (c.expected as Expected).files) expect(f.text, `${c.id} ${f.path}`).toBeUndefined();
  });
});
