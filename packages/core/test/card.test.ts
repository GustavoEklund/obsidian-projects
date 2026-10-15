import { describe, expect, it } from 'vitest';
import { countChecklist, isValidDate, keyNumber, parseCard } from '../src/card';

describe('parseCard', () => {
  it('reads a complete card', () => {
    const c = parseCard(
      'Cards/OP-7.md',
      '---\nkey: OP-7\ntitle: Fix login\nstatus: doing\ntype: bug\npriority: high\nassignee: Ana\nlabels: [auth, backend]\ndue: 2026-10-20\nestimate: 3\nparent: OP-1\nrank: V\ncreated: 2026-10-01T10:00:00.000Z\nupdated: 2026-10-02T10:00:00.000Z\n---\n- [x] a\n- [ ] b\n',
    )!;
    expect(c).toMatchObject({
      key: 'OP-7',
      title: 'Fix login',
      status: 'doing',
      type: 'bug',
      priority: 'high',
      assignee: 'Ana',
      labels: ['auth', 'backend'],
      due: '2026-10-20',
      estimate: 3,
      parent: 'OP-1',
      rank: 'V',
      checklist: { done: 1, total: 2 },
    });
  });

  it('returns null for notes that are not cards', () => {
    expect(parseCard('Cards/x.md', '# just a note')).toBeNull();
    expect(parseCard('Cards/x.md', '---\ntitle: no key\n---\n')).toBeNull();
    expect(parseCard('Cards/x.md', '---\nkey: nope\n---\n')).toBeNull();
  });

  it('degrades gracefully on hand-edited values', () => {
    const c = parseCard(
      'Cards/OP-2.md',
      '---\nkey: op-2\ntype: wizard\npriority: urgent\ndue: soon\nlabels: "a, #b, c d"\nparent: banana\n---\n',
    )!;
    expect(c.key).toBe('OP-2');
    expect(c.title).toBe('OP-2');
    expect(c.type).toBe('task');
    expect(c.priority).toBe('medium');
    expect(c.due).toBeUndefined();
    expect(c.labels).toEqual(['a', 'b', 'c-d']);
    expect(c.parent).toBeUndefined();
  });
});

describe('countChecklist', () => {
  it('counts nested and numbered tasks', () => {
    expect(countChecklist('- [x] a\n  - [ ] b\n1. [X] c\n* [ ] d')).toEqual({ done: 2, total: 4 });
  });
  it('ignores tasks inside fenced code', () => {
    expect(countChecklist('```\n- [ ] not a task\n```\n- [x] real')).toEqual({ done: 1, total: 1 });
  });
  it('ignores plain brackets', () => {
    expect(countChecklist('- [link](x)\n[ ] nope')).toEqual({ done: 0, total: 0 });
  });
});

describe('helpers', () => {
  it('keyNumber only matches the configured prefix', () => {
    expect(keyNumber('OP-12', 'OP')).toBe(12);
    expect(keyNumber('XY-12', 'OP')).toBeNull();
  });
  it('isValidDate rejects impossible dates', () => {
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-10-14')).toBe(true);
    expect(isValidDate('14/10/2026')).toBe(false);
  });
});

describe('applyPatch', () => {
  const base = parseCard(
    'Cards/OP-1.md',
    '---\nkey: OP-1\ntitle: A\nassignee: Ana\ndue: 2026-10-20\nlabels: [x]\n---\n- [ ] one\n',
  )!;
  it('applies and clears fields like the service would', async () => {
    const { applyPatch } = await import('../src/card');
    const next = applyPatch(base, {
      title: '  New   title ',
      assignee: null,
      due: null,
      labels: ['b c', 'b-c'],
      body: '- [x] a\n- [x] b\n',
      parent: 'op-9',
    });
    expect(next).toMatchObject({
      title: 'New title',
      assignee: undefined,
      due: undefined,
      labels: ['b-c'],
      parent: 'OP-9',
      checklist: { done: 2, total: 2 },
    });
    expect(base.title).toBe('A'); // original untouched
  });
});
