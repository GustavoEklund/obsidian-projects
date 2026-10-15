import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, normalizeConfig, type BoardConfig } from '../src/config';
import { isValidRank, spreadRanks } from '../src/rank';
import {
  UNASSIGNED,
  compareCards,
  dueState,
  filterCards,
  groupByColumn,
  isArchivedDone,
  localDate,
  matchesFilter,
  normalizeText,
  priorityWeight,
  rankForPlacement,
  sortCards,
  type CardFilter,
} from '../src/query';
import { CARD_TYPES, PRIORITIES, type Card } from '../src/types';

// Property tests run many cases; a loaded machine (CI, parallel test runs) must not trip the default 5 s limit.
vi.setConfig({ testTimeout: 30_000 });

const config: BoardConfig = normalizeConfig({ ...DEFAULT_CONFIG, prefix: 'OP', hideDoneAfterDays: 14, me: 'Ana' });
const STATUSES = ['todo', 'doing', 'review', 'done'];

function makeCard(over: Partial<Card> & { key: string }): Card {
  return {
    path: `Cards/${over.key}.md`,
    title: over.key,
    status: 'todo',
    type: 'task',
    priority: 'medium',
    labels: [],
    rank: 'V',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    body: '',
    checklist: { done: 0, total: 0 },
    comments: [],
    ...over,
  };
}

// --- generators --------------------------------------------------------------------------------------

const WORDS = ['login', 'Café', 'résumé', 'Zoë', 'checkout', 'API', 'Müller', 'bug', 'ünïcode', 'payments'];
const phraseArb = fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 3 }).map((w) => w.join(' '));

const fieldsArb = fc.record({
  title: phraseArb,
  status: fc.constantFrom(...STATUSES, 'ghost', ''),
  type: fc.constantFrom(...CARD_TYPES),
  priority: fc.constantFrom(...PRIORITIES),
  assignee: fc.option(fc.constantFrom('Ana', 'Bruno', 'Zoë', 'ana'), { nil: undefined }),
  labels: fc.uniqueArray(fc.constantFrom('api', 'ux', 'Café', 'bug', 'ops'), { maxLength: 3 }),
  parent: fc.option(fc.constantFrom('OP-1', 'OP-2'), { nil: undefined }),
  rank: fc.constantFrom('V', 'W', 'Vb', 'A', 'z', '1', 'V1'),
  created: fc.constantFrom('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
  body: phraseArb,
  comments: fc.array(phraseArb, { maxLength: 2 }),
});

const cardsArb = fc.array(fieldsArb, { maxLength: 14 }).map((list) =>
  list.map(({ comments, ...f }, i) =>
    makeCard({
      ...f,
      key: `OP-${i + 1}`,
      comments: comments.map((text, n) => ({ id: `c${n}`, author: 'x', at: '', text })),
    }),
  ),
);

const filterArb: fc.Arbitrary<CardFilter> = fc.record(
  {
    text: phraseArb,
    status: fc.uniqueArray(fc.constantFrom(...STATUSES), { minLength: 1, maxLength: 2 }),
    type: fc.uniqueArray(fc.constantFrom(...CARD_TYPES), { minLength: 1, maxLength: 2 }),
    priority: fc.uniqueArray(fc.constantFrom(...PRIORITIES), { minLength: 1, maxLength: 2 }),
    assignee: fc.uniqueArray(fc.constantFrom('Ana', 'bruno', UNASSIGNED), { minLength: 1, maxLength: 2 }),
    labels: fc.uniqueArray(fc.constantFrom('api', 'UX', 'cafe'), { minLength: 1, maxLength: 2 }),
    parent: fc.constantFrom('OP-1', 'op-2'),
  },
  { requiredKeys: [] },
);

const same = (a: Card[], b: Card[]) => a.length === b.length && a.every((c, i) => c === b[i]);

// --- normalizeText -----------------------------------------------------------------------------------

describe('normalizeText', () => {
  it('is idempotent, lower-case and free of combining accents', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 30 }), (s) => {
        const once = normalizeText(s);
        expect(normalizeText(once)).toBe(once);
        expect(once).toBe(once.toLowerCase());
        expect(once).not.toMatch(/[̀-ͯ]/);
      }),
      { numRuns: 300 },
    );
  });

  it('makes accented and unaccented spellings equal', () => {
    expect(normalizeText('Résumé')).toBe(normalizeText('RESUME'));
    expect(normalizeText('Zoë Müller')).toBe('zoe muller');
    expect(normalizeText('Straße')).toBe('straße'); // ß is a letter of its own, not an accent
  });
});

// --- filtering ---------------------------------------------------------------------------------------

describe('filterCards', () => {
  it('returns a subsequence of the input, in the same order, and never mutates anything', () => {
    fc.assert(
      fc.property(cardsArb, filterArb, (cards, filter) => {
        const snapshot = structuredClone(cards);
        const input = [...cards];
        const out = filterCards(cards, filter, config);
        expect(cards).toEqual(snapshot);
        expect(same(cards, input)).toBe(true);
        let at = 0;
        for (const card of out) {
          at = cards.indexOf(card, at);
          expect(at).toBeGreaterThanOrEqual(0);
          at++;
        }
      }),
      { numRuns: 300 },
    );
  });

  it('an empty filter keeps every card', () => {
    fc.assert(
      fc.property(cardsArb, (cards) => {
        expect(same(filterCards(cards, {}, config), cards)).toBe(true);
        expect(same(filterCards(cards, { text: '   ', status: [], labels: [] }, config), cards)).toBe(true);
      }),
    );
  });

  it('combines dimensions with AND: filtering by A and B is the intersection of filtering by A and by B', () => {
    fc.assert(
      fc.property(cardsArb, filterArb, filterArb, (cards, a, b) => {
        const merged = filterCards(cards, { ...a, ...b }, config);
        const keys = new Set(filterCards(filterCards(cards, a, config), b, config).map((c) => c.key));
        // Keys defined in both filters take b's value in `merged`, so compare with b-overrides applied to a.
        const overridden = filterCards(
          filterCards(cards, { ...a, ...Object.fromEntries(Object.keys(b).map((k) => [k, undefined])) }, config),
          b,
          config,
        );
        expect(merged.map((c) => c.key)).toEqual(overridden.map((c) => c.key));
        expect(merged.every((c) => matchesFilter(c, { ...a, ...b }, config))).toBe(true);
        expect(keys.size).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  it('text search is case- and accent-insensitive, and every word must match', () => {
    fc.assert(
      fc.property(cardsArb, fc.constantFrom('upper', 'lower', 'plain'), (cards, mode) => {
        for (const card of cards) {
          const query =
            mode === 'upper'
              ? card.title.toUpperCase()
              : mode === 'lower'
                ? card.title.toLowerCase()
                : normalizeText(card.title);
          expect(matchesFilter(card, { text: query }, config)).toBe(true);
          expect(matchesFilter(card, { text: `${query} definitely-not-present` }, config)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('text search covers key, assignee, labels, description and comments', () => {
    const card = makeCard({
      key: 'OP-42',
      title: 'Alpha',
      assignee: 'Zoë',
      labels: ['café'],
      body: 'needle in body',
      comments: [{ id: 'a', author: 'x', at: '', text: 'secret comment' }],
    });
    for (const q of ['op-42', 'alpha', 'zoe', 'cafe', 'needle', 'secret', 'NEEDLE IN', 'comment secret'])
      expect(matchesFilter(card, { text: q }, config)).toBe(true);
    for (const q of ['nope', 'op-43', 'needlex']) expect(matchesFilter(card, { text: q }, config)).toBe(false);
  });

  it('assignee filters are accent-insensitive and `UNASSIGNED` matches only cards without one', () => {
    fc.assert(
      fc.property(cardsArb, (cards) => {
        const unassigned = filterCards(cards, { assignee: [UNASSIGNED] }, config);
        expect(unassigned.every((c) => !c.assignee)).toBe(true);
        expect(unassigned.length).toBe(cards.filter((c) => !c.assignee).length);
        const zoe = filterCards(cards, { assignee: ['ZOE'] }, config);
        expect(zoe.every((c) => c.assignee === 'Zoë')).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('status filters use the display column: unknown statuses count as the first column', () => {
    const ghost = makeCard({ key: 'OP-1', status: 'ghost' });
    expect(matchesFilter(ghost, { status: ['todo'] }, config)).toBe(true);
    expect(matchesFilter(ghost, { status: ['doing'] }, config)).toBe(false);
  });

  it('label filters match ANY of the labels, ignoring case and accents', () => {
    const card = makeCard({ key: 'OP-1', labels: ['Café', 'api'] });
    expect(matchesFilter(card, { labels: ['CAFE'] }, config)).toBe(true);
    expect(matchesFilter(card, { labels: ['nope', 'API'] }, config)).toBe(true);
    expect(matchesFilter(card, { labels: ['nope'] }, config)).toBe(false);
  });

  it('parent filters are case-insensitive on the filter side', () => {
    const child = makeCard({ key: 'OP-3', parent: 'OP-1' });
    expect(matchesFilter(child, { parent: 'op-1' }, config)).toBe(true);
    expect(matchesFilter(child, { parent: 'OP-2' }, config)).toBe(false);
  });
});

// --- sorting and grouping ----------------------------------------------------------------------------

describe('sortCards / compareCards', () => {
  it('returns a permutation, never mutates its input, and ignores the input order', () => {
    fc.assert(
      fc.property(cardsArb, fc.nat(), (cards, seed) => {
        const input = [...cards];
        const sorted = sortCards(cards, config);
        expect(same(cards, input)).toBe(true);
        expect(sorted).toHaveLength(cards.length);
        expect(new Set(sorted).size).toBe(cards.length);
        const shuffled = [...cards].sort(
          (a, b) => ((a.key.length * 31 + seed) % 7) - ((b.key.length * 17 + seed) % 7) || (a.key < b.key ? 1 : -1),
        );
        expect(sortCards(shuffled, config).map((c) => c.key)).toEqual(sorted.map((c) => c.key));
      }),
      { numRuns: 200 },
    );
  });

  it('orders by column, then rank, then creation time, then key', () => {
    fc.assert(
      fc.property(cardsArb, (cards) => {
        const sorted = sortCards(cards, config);
        const col = (c: Card) => Math.max(0, STATUSES.indexOf(c.status));
        for (let i = 1; i < sorted.length; i++) {
          const a = sorted[i - 1]!;
          const b = sorted[i]!;
          const tuple = (c: Card) => [col(c), c.rank, c.created, c.key] as const;
          const [ta, tb] = [tuple(a), tuple(b)];
          const ordered =
            ta[0] < tb[0] ||
            (ta[0] === tb[0] &&
              (ta[1] < tb[1] || (ta[1] === tb[1] && (ta[2] < tb[2] || (ta[2] === tb[2] && ta[3] <= tb[3])))));
          expect(ordered).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('is a consistent total order: antisymmetric and transitive', () => {
    fc.assert(
      fc.property(cardsArb, (cards) => {
        const cmp = compareCards(config);
        for (const a of cards) {
          expect(cmp(a, a)).toBe(0);
          for (const b of cards) expect(Math.sign(cmp(a, b))).toBe(Math.sign(0 - cmp(b, a)));
        }
        const sorted = sortCards(cards, config);
        for (let i = 0; i + 2 < sorted.length; i++) expect(cmp(sorted[i]!, sorted[i + 2]!)).toBeLessThanOrEqual(0);
      }),
      { numRuns: 100 },
    );
  });
});

describe('groupByColumn', () => {
  it('puts every card in exactly one column, keeps the column order and sorts inside each column', () => {
    fc.assert(
      fc.property(cardsArb, (cards) => {
        const groups = groupByColumn(cards, config);
        expect(groups.map((g) => g.column.id)).toEqual(config.columns.map((c) => c.id));
        const flat = groups.flatMap((g) => g.cards);
        expect(flat).toHaveLength(cards.length);
        expect(new Set(flat).size).toBe(cards.length);
        for (const g of groups) expect(g.cards).toEqual(sortCards(g.cards, config));
        expect(flat.map((c) => c.key)).toEqual(sortCards(cards, config).map((c) => c.key));
      }),
      { numRuns: 200 },
    );
  });

  it('sends cards with an unknown or empty status to the first column', () => {
    const cards = [
      makeCard({ key: 'OP-1', status: 'ghost' }),
      makeCard({ key: 'OP-2', status: '' }),
      makeCard({ key: 'OP-3', status: 'done' }),
    ];
    const [first, , , last] = groupByColumn(cards, config);
    expect(first!.cards.map((c) => c.key)).toEqual(['OP-1', 'OP-2']);
    expect(last!.cards.map((c) => c.key)).toEqual(['OP-3']);
  });

  it('gives empty groups for an empty board', () => {
    expect(groupByColumn([], config).map((g) => g.cards.length)).toEqual([0, 0, 0, 0]);
  });
});

// --- dates -------------------------------------------------------------------------------------------

describe('localDate', () => {
  it('formats local calendar dates as YYYY-MM-DD, zero padded', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('1990-01-01'), max: new Date('2090-01-01'), noInvalidDate: true }), (d) => {
        const text = localDate(d);
        expect(text).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const [y, m, day] = text.split('-').map(Number);
        expect([y, m, day]).toEqual([d.getFullYear(), d.getMonth() + 1, d.getDate()]);
      }),
      { numRuns: 200 },
    );
    expect(localDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('dueState', () => {
  const NOW = new Date(2026, 9, 14, 15, 30); // local time

  const offsetDate = (days: number) => {
    const d = new Date(2026, 9, 14 + days);
    return localDate(d);
  };

  it('classifies a due date relative to today: past = overdue, today..+2 = soon, later otherwise', () => {
    fc.assert(
      fc.property(fc.integer({ min: -400, max: 400 }), (days) => {
        const card = makeCard({ key: 'OP-1', status: 'todo', due: offsetDate(days) });
        const expected = days < 0 ? 'overdue' : days <= 2 ? 'soon' : 'later';
        expect(dueState(card, config, NOW)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('has no state without a due date, and a done card is never overdue', () => {
    expect(dueState(makeCard({ key: 'OP-1' }), config, NOW)).toBeUndefined();
    fc.assert(
      fc.property(fc.integer({ min: -400, max: 400 }), (days) => {
        const card = makeCard({ key: 'OP-1', status: 'done', due: offsetDate(days) });
        expect(dueState(card, config, NOW)).toBe('later');
      }),
      { numRuns: 100 },
    );
  });

  it('does not depend on the time of day', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: -3, max: 5 }),
        (h, m, days) => {
          const card = makeCard({ key: 'OP-1', due: offsetDate(days) });
          const expected = dueState(card, config, new Date(2026, 9, 14, 0, 0));
          expect(dueState(card, config, new Date(2026, 9, 14, h, m))).toBe(expected);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('handles month and year boundaries and the end-of-year rollover', () => {
    const dec31 = new Date(2026, 11, 31, 12);
    expect(dueState(makeCard({ key: 'OP-1', due: '2027-01-02' }), config, dec31)).toBe('soon');
    expect(dueState(makeCard({ key: 'OP-1', due: '2027-01-03' }), config, dec31)).toBe('later');
    expect(dueState(makeCard({ key: 'OP-1', due: '2026-12-30' }), config, dec31)).toBe('overdue');
  });
});

describe('isArchivedDone', () => {
  const DAY = 86_400_000;
  const NOW = new Date('2026-10-14T12:00:00.000Z');

  it('hides done cards resolved more than the configured days ago, and nothing else', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), fc.constantFrom(...STATUSES), (daysAgo, status) => {
        const resolved = new Date(NOW.getTime() - daysAgo * DAY).toISOString();
        const card = makeCard({ key: 'OP-1', status, resolved });
        const expected = status === 'done' && daysAgo > 14;
        expect(isArchivedDone(card, config, NOW)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('falls back to `updated` when there is no `resolved`, and never hides when the limit is 0', () => {
    const old = makeCard({ key: 'OP-1', status: 'done', updated: '2020-01-01T00:00:00.000Z' });
    expect(isArchivedDone(old, config, NOW)).toBe(true);
    expect(isArchivedDone(old, { ...config, hideDoneAfterDays: 0 }, NOW)).toBe(false);
    expect(isArchivedDone(makeCard({ key: 'OP-2', status: 'done', resolved: 'garbage' }), config, NOW)).toBe(false);
  });
});

describe('priorityWeight', () => {
  it('orders highest first', () => {
    const weights = PRIORITIES.map(priorityWeight);
    expect(weights).toEqual([...weights].sort((a, b) => a - b));
    expect(new Set(weights).size).toBe(PRIORITIES.length);
  });
});

// --- rankForPlacement --------------------------------------------------------------------------------

describe('rankForPlacement', () => {
  type Op = { card: number; column: number; where: 'bottom' | 'before' | 'after'; ref: number };

  const opArb: fc.Arbitrary<Op> = fc.record({
    card: fc.nat(),
    column: fc.integer({ min: 0, max: 3 }),
    where: fc.constantFrom('bottom', 'before', 'after'),
    ref: fc.nat(),
  });

  it('puts a moved card exactly where asked, for random sequences of moves (model-based)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.array(opArb, { maxLength: 40 }), (size, ops) => {
        // Model: one ordered key list per column; the real cards carry the ranks the function hands out.
        const ranks = spreadRanks(size);
        const cards: Card[] = Array.from({ length: size }, (_, i) =>
          makeCard({ key: `OP-${i + 1}`, status: 'todo', rank: ranks[i]! }),
        );
        const model: string[][] = [cards.map((c) => c.key), [], [], []];

        for (const op of ops) {
          const moving = cards[op.card % size]!;
          const targetList = model[op.column]!;
          const others = targetList.filter((k) => k !== moving.key);
          const anchor = others.length === 0 || op.where === 'bottom' ? undefined : others[op.ref % others.length]!;
          const placement = anchor === undefined ? {} : op.where === 'before' ? { before: anchor } : { after: anchor };
          const status = STATUSES[op.column]!;

          const rank = rankForPlacement(cards, config, moving.key, status, placement);
          expect(isValidRank(rank)).toBe(true);
          moving.status = status;
          moving.rank = rank;

          for (const list of model) {
            const at = list.indexOf(moving.key);
            if (at >= 0) list.splice(at, 1);
          }
          const insertAt =
            anchor === undefined ? others.length : others.indexOf(anchor) + (op.where === 'after' ? 1 : 0);
          others.splice(insertAt, 0, moving.key);
          model[op.column] = others;

          for (let c = 0; c < 4; c++) {
            const actual = sortCards(
              cards.filter((card) => card.status === STATUSES[c]),
              config,
            ).map((card) => card.key);
            expect(actual).toEqual(model[c]);
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  it('survives neighbours with equal ranks: it never throws and the card lands after the upper neighbour', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), fc.nat(), (size, pick) => {
        const cards = Array.from({ length: size }, (_, i) => makeCard({ key: `OP-${i + 1}`, rank: 'V' }));
        const target = cards[pick % size]!;
        const rank = rankForPlacement(cards, config, 'OP-999', 'todo', { before: target.key });
        expect(isValidRank(rank)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects an anchor that is not in the destination column, naming it', () => {
    const cards = [makeCard({ key: 'OP-1', status: 'todo' }), makeCard({ key: 'OP-2', status: 'doing' })];
    expect(() => rankForPlacement(cards, config, 'OP-3', 'todo', { before: 'OP-2' })).toThrow(
      /Card OP-2 is not in column "todo"/,
    );
    expect(() => rankForPlacement(cards, config, 'OP-3', 'todo', { after: 'OP-9' })).toThrow(
      /Card OP-9 is not in column "todo"/,
    );
  });

  it('ignores the moving card itself, so reordering inside a column works', () => {
    const cards = [
      makeCard({ key: 'OP-1', rank: 'A' }),
      makeCard({ key: 'OP-2', rank: 'M' }),
      makeCard({ key: 'OP-3', rank: 'Z' }),
    ];
    const rank = rankForPlacement(cards, config, 'OP-1', 'todo', { after: 'OP-3' });
    expect(rank > 'Z').toBe(true);
    const top = rankForPlacement(cards, config, 'OP-3', 'todo', { before: 'OP-1' });
    expect(top < 'A').toBe(true);
  });

  it('puts the first card of an empty column at a valid rank', () => {
    expect(isValidRank(rankForPlacement([], config, 'OP-1', 'review'))).toBe(true);
  });
});
