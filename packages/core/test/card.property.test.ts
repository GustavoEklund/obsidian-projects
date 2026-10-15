import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  DATE_RE,
  KEY_RE,
  applyPatch,
  countChecklist,
  isCardType,
  isPriority,
  isValidDate,
  keyNumber,
  newCardContent,
  normalizeLabels,
  parseCard,
  sameCard,
} from '../src/card';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config';
import { isValidRank } from '../src/rank';
import { CardService } from '../src/service';
import { MemoryStorage } from '../src/storage';
import { CARD_TYPES, PRIORITIES, type Card, type CardPatch } from '../src/types';

// Property tests run many cases; a loaded machine (CI, parallel test runs) must not trip the default 5 s limit.
vi.setConfig({ testTimeout: 30_000 });

type ValueOf<A> = A extends fc.Arbitrary<infer T> ? T : never;

// --- generators --------------------------------------------------------------------------------------

const wordArb = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.string({ unit: 'grapheme', maxLength: 8 }),
  fc.constantFrom(
    'Fix login',
    'Zoë',
    'Straße',
    '日本語',
    '🙂',
    'a: b',
    '# hash',
    "it's",
    '"quoted"',
    'true',
    'null',
    '123',
    '2026-10-14',
  ),
);
const titleArb = wordArb.map((t) => t.replace(/[\r\n]/g, ' '));

const dateArb = fc
  .date({ min: new Date('2000-01-01'), max: new Date('2060-12-31'), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10));
const isoArb = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2040-01-01'), noInvalidDate: true })
  .map((d) => d.toISOString());
const rankArb = fc.stringMatching(/^[0-9A-Za-z]{0,6}[1-9A-Za-z]$/);
const labelArb = fc.oneof(
  fc.string({ maxLength: 8 }).map((s) => s.replace(/[\r\n]/g, ' ')),
  fc.constantFrom('api', '#ux', 'two words', 'Café', 'a,b', ' padded '),
);

/** A description that cannot be mistaken for a comments section or contain an unclosed fence. */
const bodyArb = fc
  .array(
    fc.oneof(
      fc.string({ maxLength: 20 }).map((s) => s.replace(/[\r\n]/g, ' ')),
      fc.constantFrom('', 'Some text', '- [ ] a', '- [x] b', '## Other', '> quote'),
    ),
    { maxLength: 6 },
  )
  .map((lines) => lines.join('\n'))
  .filter((d) => !/^##[ \t]+comments\s*$/im.test(d) && !/^\s*(```|~~~)/m.test(d));

const commentArb = fc.record({
  id: fc.stringMatching(/^[a-z0-9]{4,6}$/),
  author: fc.constantFrom('Ana', 'Bruno', 'Zoë'),
  at: isoArb,
  text: fc.constantFrom('hello', 'two\nlines', '- [ ] todo\n- [x] done', 'a > b', ''),
});

const cardInputArb = fc.record({
  n: fc.integer({ min: 1, max: 99_999 }),
  title: titleArb,
  status: fc.constantFrom('todo', 'doing', 'review', 'done'),
  type: fc.constantFrom(...CARD_TYPES),
  priority: fc.constantFrom(...PRIORITIES),
  assignee: fc.option(fc.constantFrom('Ana', 'Bruno', 'Zoë Müller'), { nil: undefined }),
  labels: fc.array(labelArb, { maxLength: 5 }),
  due: fc.option(dateArb, { nil: undefined }),
  estimate: fc.option(fc.oneof(fc.integer({ min: 0, max: 100 }), fc.double({ min: 0, max: 100, noNaN: true })), {
    nil: undefined,
  }),
  parent: fc.option(
    fc.integer({ min: 1, max: 99 }).map((n) => `OP-${n}`),
    { nil: undefined },
  ),
  rank: rankArb,
  created: isoArb,
  updated: isoArb,
  resolved: fc.option(isoArb, { nil: undefined }),
  body: bodyArb,
  comments: fc.uniqueArray(commentArb, { selector: (c) => c.id, maxLength: 3 }),
});

const toNew = (i: ValueOf<typeof cardInputArb>): Omit<Card, 'path' | 'checklist'> => ({ ...i, key: `OP-${i.n}` });

// --- parseCard / newCardContent ----------------------------------------------------------------------

describe('newCardContent -> parseCard', () => {
  it('round-trips every field (titles trimmed, labels normalized, body trimmed)', () => {
    fc.assert(
      fc.property(cardInputArb, (input) => {
        const card = toNew(input);
        const parsed = parseCard('Cards/x.md', newCardContent(card))!;
        expect(parsed).not.toBeNull();
        expect(parsed.key).toBe(card.key);
        expect(parsed.path).toBe('Cards/x.md');
        expect(parsed.title).toBe(card.title.trim() || card.key);
        expect(parsed.status).toBe(card.status);
        expect(parsed.type).toBe(card.type);
        expect(parsed.priority).toBe(card.priority);
        expect(parsed.assignee).toBe(card.assignee);
        expect(parsed.labels).toEqual(normalizeLabels(card.labels));
        expect(parsed.due).toBe(card.due);
        expect(parsed.estimate).toBe(card.estimate);
        expect(parsed.parent).toBe(card.parent);
        expect(parsed.rank).toBe(card.rank);
        expect(parsed.created).toBe(card.created);
        expect(parsed.updated).toBe(card.updated);
        expect(parsed.resolved).toBe(card.resolved);
        expect(parsed.body.trim()).toBe(card.body.trim());
        expect(parsed.checklist).toEqual(countChecklist(parsed.body));
        expect(parsed.comments.map((c) => c.id)).toEqual(card.comments.map((c) => c.id));
      }),
      { numRuns: 300 },
    );
  });

  it('keeps comments out of the description and the description out of the comments', () => {
    fc.assert(
      fc.property(cardInputArb, (input) => {
        const parsed = parseCard('Cards/x.md', newCardContent(toNew(input)))!;
        expect(parsed.body).not.toContain('## Comments');
        expect(parsed.comments.length).toBe(input.comments.length);
      }),
      { numRuns: 150 },
    );
  });

  it('is stable: a parsed card written again parses to the same card', () => {
    fc.assert(
      fc.property(cardInputArb, (input) => {
        const first = parseCard('Cards/x.md', newCardContent(toNew(input)))!;
        const { path: _path, checklist: _checklist, ...rest } = first;
        const second = parseCard('Cards/x.md', newCardContent(rest))!;
        expect(sameCard(first, second)).toBe(true);
        expect(second.title).toBe(first.title);
      }),
      { numRuns: 150 },
    );
  });
});

describe('parseCard', () => {
  it('returns null for notes that are not cards', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (text) => {
        expect(parseCard('Cards/x.md', text)).toBeNull();
      }),
      { numRuns: 100 },
    );
    for (const key of ['nope', 'op-', '1-1', 'A-1', 'OP', 'OP-x', 'LONGPREFIX1-1', '']) {
      expect(parseCard('x.md', `---\nkey: ${JSON.stringify(key)}\n---\n`)).toBeNull();
    }
  });

  it('upper-cases the key and the parent', () => {
    const card = parseCard('x.md', '---\nkey: op-7\nparent: op-1\n---\n')!;
    expect(card.key).toBe('OP-7');
    expect(card.parent).toBe('OP-1');
  });

  it('degrades every field to a sane default for arbitrary hand-edited values, and never throws', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(
            'title',
            'status',
            'type',
            'priority',
            'assignee',
            'labels',
            'due',
            'estimate',
            'parent',
            'rank',
            'created',
            'updated',
            'resolved',
          ),
          fc.jsonValue(),
        ),
        (garbage) => {
          const content = `---\n${JSON.stringify({ key: 'OP-1', ...garbage })}\n---\nBody\n`;
          const card = parseCard('Cards/OP-1.md', content)!;
          expect(card).not.toBeNull();
          expect(card.key).toBe('OP-1');
          expect(card.title.length).toBeGreaterThan(0);
          expect(isCardType(card.type)).toBe(true);
          expect(isPriority(card.priority)).toBe(true);
          expect(Array.isArray(card.labels)).toBe(true);
          expect(
            card.labels.every((l) => typeof l === 'string' && l.length > 0 && !/\s/.test(l) && !l.startsWith('#')),
          ).toBe(true);
          expect(card.due === undefined || isValidDate(card.due)).toBe(true);
          expect(card.estimate === undefined || Number.isFinite(card.estimate)).toBe(true);
          expect(card.parent === undefined || KEY_RE.test(card.parent)).toBe(true);
          expect(typeof card.rank).toBe('string');
          expect(typeof card.status).toBe('string');
          expect(card.updated).toBe(card.updated || card.created);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('reads labels from a comma-separated string as well as from a list', () => {
    expect(parseCard('x.md', '---\nkey: OP-1\nlabels: "a, #b ,c c, a"\n---\n')!.labels).toEqual(['a', 'b', 'c-c']);
    expect(parseCard('x.md', '---\nkey: OP-1\nlabels: [a, "#b", 3]\n---\n')!.labels).toEqual(['a', 'b', '3']);
  });

  it('accepts dates written as YAML timestamps and rejects impossible ones', () => {
    expect(parseCard('x.md', '---\nkey: OP-1\ndue: 2026-10-20\n---\n')!.due).toBe('2026-10-20');
    expect(parseCard('x.md', '---\nkey: OP-1\ndue: 2026-02-30\n---\n')!.due).toBeUndefined();
    expect(parseCard('x.md', '---\nkey: OP-1\ndue: 2026-10-20T08:00:00Z\n---\n')!.due).toBe('2026-10-20');
    expect(parseCard('x.md', '---\nkey: OP-1\ndue: tomorrow\n---\n')!.due).toBeUndefined();
  });

  it('uses the key as the title when the title is missing or blank, and `created` for a missing `updated`', () => {
    const card = parseCard('x.md', '---\nkey: OP-1\ntitle: "   "\ncreated: 2026-01-01T00:00:00.000Z\n---\n')!;
    expect(card.title).toBe('OP-1');
    expect(card.updated).toBe('2026-01-01T00:00:00.000Z');
  });

  it('handles CRLF notes with a BOM', () => {
    const card = parseCard('x.md', '﻿---\r\nkey: OP-3\r\ntitle: Crlf\r\n---\r\nBody text\r\n')!;
    expect(card.title).toBe('Crlf');
    expect(card.body).toContain('Body text');
  });
});

// --- helpers -----------------------------------------------------------------------------------------

describe('isValidDate', () => {
  it('accepts every real date and nothing that rolls over to another one', () => {
    fc.assert(fc.property(dateArb, (d) => isValidDate(d)));
    for (const bad of [
      '2026-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-1-1',
      '26-01-01',
      '2026-01-01T00:00',
      '',
      'tomorrow',
    ]) {
      expect(isValidDate(bad)).toBe(false);
    }
    expect(isValidDate('2028-02-29')).toBe(true); // leap year
    expect(isValidDate('2100-02-29')).toBe(false); // not a leap year
    expect(isValidDate('2000-02-29')).toBe(true);
  });

  it('agrees with the date regex for any string: valid dates always match it', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (s) => {
        expect(!isValidDate(s) || DATE_RE.test(s)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe('keyNumber', () => {
  it('extracts the number for the configured prefix only', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), (n) => {
        expect(keyNumber(`OP-${n}`, 'OP')).toBe(n);
        expect(keyNumber(`OP-${n}`, 'AB')).toBeNull();
      }),
    );
    for (const bad of ['OP-', 'OP-1x', 'op-1', 'OP_1', '1', '']) expect(keyNumber(bad, 'OP')).toBeNull();
  });
});

describe('normalizeLabels', () => {
  it('strips every leading # so a saved label reads back the same (regression: `##tag` was saved as `#tag`)', () => {
    expect(normalizeLabels(['##tag', '#', '##', '###a b'])).toEqual(['tag', 'a-b']);
    expect(normalizeLabels(normalizeLabels(['##tag']))).toEqual(['tag']);
    expect(parseCard('x.md', '---\nkey: OP-1\nlabels: ["##tag"]\n---\n')!.labels).toEqual(['tag']);
  });

  it('is idempotent, has no duplicates, whitespace or leading #, and keeps first-occurrence order', () => {
    fc.assert(
      fc.property(fc.array(labelArb, { maxLength: 8 }), (labels) => {
        const once = normalizeLabels(labels);
        expect(normalizeLabels(once)).toEqual(once);
        expect(new Set(once).size).toBe(once.length);
        for (const l of once) {
          expect(l).not.toMatch(/\s/);
          expect(l.length).toBeGreaterThan(0);
        }
        const expectedOrder = labels
          .map((l) => l.trim().replace(/^#+/, '').replace(/\s+/g, '-'))
          .filter((l, i, all) => l && all.indexOf(l) === i);
        expect(once).toEqual(expectedOrder);
      }),
      { numRuns: 300 },
    );
  });
});

describe('countChecklist', () => {
  const taskLine = fc.constantFrom(
    '- [ ] a',
    '- [x] b',
    '* [X] c',
    '+ [ ] d',
    '1. [x] e',
    '2) [ ] f',
    '   - [ ] indented',
  );
  const plainLine = fc.constantFrom(
    '',
    'text',
    '- item',
    '- [link](x)',
    '[ ] stray',
    '> - [ ] quoted',
    '- [-] custom',
    '- [ ]nospace',
  );

  it('counts tasks and done tasks outside fenced code, whatever the surrounding text', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(taskLine, plainLine), { maxLength: 14 }), (lines) => {
        const expectedTotal = lines.filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s/.test(l)).length;
        const expectedDone = lines.filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]\s/.test(l)).length;
        expect(countChecklist(lines.join('\n'))).toEqual({ total: expectedTotal, done: expectedDone });
      }),
      { numRuns: 300 },
    );
  });

  it('ignores everything inside ``` and ~~~ fences, even after an unclosed one', () => {
    const doc = [
      '- [ ] a',
      '```',
      '- [ ] hidden',
      '```',
      '- [x] b',
      '~~~',
      '- [x] hidden too',
      '~~~',
      '- [ ] c',
      '```',
      '- [ ] never counted',
    ].join('\n');
    expect(countChecklist(doc)).toEqual({ total: 3, done: 1 });
  });

  it('never reports more done tasks than tasks', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (text) => {
        const { done, total } = countChecklist(text);
        expect(done).toBeLessThanOrEqual(total);
      }),
      { numRuns: 200 },
    );
  });
});

// --- sameCard / applyPatch ---------------------------------------------------------------------------

function cardFrom(input: ValueOf<typeof cardInputArb>): Card {
  return parseCard('Cards/x.md', newCardContent(toNew(input)))!;
}

describe('sameCard', () => {
  it('is reflexive and notices a change in any compared field', () => {
    fc.assert(
      fc.property(cardInputArb, (input) => {
        const card = cardFrom(input);
        expect(sameCard(card, card)).toBe(true);
        expect(sameCard(card, { ...card })).toBe(true);
        const changes: Partial<Card>[] = [
          { title: `${card.title}!` },
          { status: `${card.status}x` },
          { type: card.type === 'bug' ? 'task' : 'bug' },
          { priority: card.priority === 'high' ? 'low' : 'high' },
          { assignee: `${card.assignee ?? ''}!` },
          { due: card.due === '2000-01-01' ? '2000-01-02' : '2000-01-01' },
          { estimate: (card.estimate ?? 0) + 1 },
          { parent: card.parent === 'OP-1' ? 'OP-2' : 'OP-1' },
          { rank: `${card.rank}V` },
          { updated: `${card.updated}x` },
          { resolved: `${card.resolved ?? ''}x` },
          { body: `${card.body}x` },
          { labels: [...card.labels, 'extra-label'] },
          { comments: [...card.comments, { id: 'zzzzz', author: 'x', at: '', text: 'x' }] },
          { path: `${card.path}x` },
          { key: 'OP-424242' },
        ];
        for (const change of changes) expect(sameCard(card, { ...card, ...change })).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('ignores the derived and informational fields: created and checklist', () => {
    const card = cardFrom({ ...fc.sample(cardInputArb, 1)[0]! });
    expect(sameCard(card, { ...card, created: 'other', checklist: { done: 9, total: 9 } })).toBe(true);
  });
});

const patchArb: fc.Arbitrary<CardPatch> = fc.record(
  {
    title: titleArb,
    status: fc.constantFrom('todo', 'doing', 'review', 'done'),
    type: fc.constantFrom(...CARD_TYPES),
    priority: fc.constantFrom(...PRIORITIES),
    assignee: fc.option(fc.constantFrom('Ana', 'Bruno', '  Ana  ', ''), { nil: null }),
    labels: fc.array(labelArb, { maxLength: 4 }),
    due: fc.option(dateArb, { nil: null }),
    estimate: fc.option(fc.integer({ min: 0, max: 50 }), { nil: null }),
    parent: fc.option(
      fc.integer({ min: 1, max: 9 }).map((n) => `op-${n}`),
      { nil: null },
    ),
    rank: rankArb,
    body: bodyArb,
  },
  { requiredKeys: [] },
);

describe('applyPatch', () => {
  it('only changes the fields in the patch, never mutates its input, and recomputes the checklist', () => {
    fc.assert(
      fc.property(cardInputArb, patchArb, (input, patch) => {
        const card = cardFrom(input);
        const snapshot = structuredClone(card);
        const next = applyPatch(card, patch);
        expect(card).toEqual(snapshot);
        for (const key of ['key', 'path', 'created', 'updated', 'resolved', 'comments'] as const)
          expect(next[key]).toEqual(card[key]);
        expect(next.body).toBe(patch.body === undefined ? card.body : patch.body);
        expect(next.checklist).toEqual(countChecklist(next.body));
        expect(next.labels).toEqual(patch.labels === undefined ? card.labels : normalizeLabels(patch.labels));
        expect(next.title).toBe(
          patch.title === undefined ? card.title : patch.title.replace(/\s+/g, ' ').trim() || card.title,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('clears optional fields on null and upper-cases the parent', () => {
    const card = cardFrom(fc.sample(cardInputArb, 1)[0]!);
    const next = applyPatch(
      { ...card, assignee: 'Ana', due: '2026-01-01', estimate: 3, parent: 'OP-1' },
      { assignee: null, due: null, estimate: null, parent: null },
    );
    expect([next.assignee, next.due, next.estimate, next.parent]).toEqual([undefined, undefined, undefined, undefined]);
    expect(applyPatch(card, { parent: 'op-9' }).parent).toBe('OP-9');
    expect(applyPatch(card, { assignee: '   ' }).assignee).toBeUndefined();
  });

  it('predicts what the service saves for the same patch (optimistic update == saved card)', async () => {
    const config = normalizeConfig({ ...DEFAULT_CONFIG, prefix: 'OP' });
    await fc.assert(
      fc.asyncProperty(patchArb, async (rawPatch) => {
        const storage = new MemoryStorage();
        let tick = 0;
        const svc = new CardService(storage, config, { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
        for (let i = 1; i <= 9; i++) await svc.create({ title: `Parent ${i}` });
        const before = await svc.create({ title: 'Subject', body: '- [ ] one', labels: ['x'], assignee: 'Zed' });
        // Only patches the service accepts: a card cannot be its own parent, and a blank title is an error.
        const patch: CardPatch = {
          ...rawPatch,
          title: rawPatch.title?.trim() ? rawPatch.title : undefined,
          parent: rawPatch.parent === `op-${before.key.split('-')[1]}` ? undefined : rawPatch.parent,
        };
        const guess = applyPatch(before, patch);
        const saved = await svc.update(before.key, patch);
        expect(saved.title).toBe(guess.title);
        expect(saved.status).toBe(guess.status);
        expect(saved.type).toBe(guess.type);
        expect(saved.priority).toBe(guess.priority);
        expect(saved.assignee).toBe(guess.assignee);
        expect(saved.labels).toEqual(guess.labels);
        expect(saved.due).toBe(guess.due);
        expect(saved.estimate).toBe(guess.estimate);
        expect(saved.parent).toBe(guess.parent);
        expect(saved.body.trim()).toBe(guess.body.trim());
        expect(saved.checklist).toEqual(guess.checklist);
      }),
      { numRuns: 80 },
    );
  });
});

describe('type guards', () => {
  it('accept exactly the known card types and priorities', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom(...CARD_TYPES, ...PRIORITIES), fc.anything()),
        (v) => {
          expect(isCardType(v)).toBe(typeof v === 'string' && (CARD_TYPES as readonly string[]).includes(v));
          expect(isPriority(v)).toBe(typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('generated ranks are valid ranks', () => {
    fc.assert(
      fc.property(rankArb, (r) => {
        expect(isValidRank(r)).toBe(true);
      }),
    );
  });
});
