import { describe, expect, it } from 'vitest';
import { filterCards, normalizeText, sortCards, type BoardConfig, type Card, type CardFilter } from '@oprojects/core';
import { render } from '../conformance/lib';
import { generate, name } from '../conformance/query.fixture';

const file = generate();
const kind = (c: { input: unknown }) => (c.input as { fn: string }).fn;
const of = (fn: string) => file.cases.filter((c) => kind(c) === fn);

function withTimezone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

describe('the query conformance generator', () => {
  it('is called `query` and describes itself', () => {
    expect(name).toBe('query');
    expect(file.description).toContain('query.ts');
  });

  it('is deterministic: the same bytes every time', () => {
    expect(render(generate())).toBe(render(file));
  });

  it('does not depend on the time zone of the machine that runs it', () => {
    const reference = render(file);
    for (const tz of ['Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
      expect(
        withTimezone(tz, () => render(generate())),
        tz,
      ).toBe(reference);
    }
  });

  it('has unique case ids (render refuses duplicates) and every kind of case in quantity', () => {
    expect(new Set(file.cases.map((c) => c.id)).size).toBe(file.cases.length);
    const counts = Object.fromEntries(
      [
        'board',
        'normalize_text',
        'due_state',
        'is_archived_done',
        'parse_timestamp',
        'rank_for_placement',
        'local_date',
        'priority_weight',
      ].map((k) => [k, of(k).length]),
    );
    expect(counts.board).toBeGreaterThanOrEqual(150);
    expect(counts.normalize_text).toBeGreaterThanOrEqual(20);
    expect(counts.due_state).toBeGreaterThanOrEqual(40);
    expect(counts.is_archived_done).toBeGreaterThanOrEqual(15);
    expect(counts.rank_for_placement).toBeGreaterThanOrEqual(100);
    for (const k of ['parse_timestamp', 'local_date', 'priority_weight'])
      expect(counts[k], k).toBeGreaterThanOrEqual(1);
  });

  it('is not trivial: boards have cards and varied results, dates reach every state, timestamps are both valid and not', () => {
    const boards = of('board');
    const filterResults = boards.flatMap((c) => (c.expected as { filter: string[][] }).filter);
    expect(filterResults.some((keys) => keys.length === 0)).toBe(true);
    expect(filterResults.some((keys) => keys.length > 2)).toBe(true);
    const groups = boards.flatMap((c) => (c.expected as { group: { cards: string[] }[] }).group);
    expect(groups.some((g) => g.cards.length > 0)).toBe(true);

    const states = new Set(of('due_state').flatMap((c) => c.expected as (string | null)[]));
    expect(states).toEqual(new Set(['overdue', 'soon', 'later', null]));

    const archived = of('is_archived_done').flatMap((c) => c.expected as boolean[]);
    expect(archived).toContain(true);
    expect(archived).toContain(false);

    const [timestamps] = of('parse_timestamp');
    const parsed = timestamps!.expected as (number | null)[];
    expect(parsed.filter((v) => v === null).length).toBeGreaterThan(50);
    expect(parsed.filter((v) => v !== null).length).toBeGreaterThan(100);

    const moves = of('rank_for_placement').flatMap((c) => c.expected as { rank?: string; error?: string }[]);
    expect(moves.some((m) => m.rank !== undefined)).toBe(true);
    expect(moves.some((m) => m.error?.includes('is not in column'))).toBe(true);
  });

  it('records what the TypeScript functions return, which spot checks reproduce', () => {
    for (const c of of('board').slice(0, 25)) {
      const input = c.input as { config: BoardConfig; cards: Card[]; filters: CardFilter[] };
      const expected = c.expected as { filter: string[][]; sort: string[] };
      input.filters.forEach((f, i) =>
        expect(
          filterCards(input.cards, f, input.config).map((card) => card.key),
          `${c.id}[${i}]`,
        ).toEqual(expected.filter[i]),
      );
      expect(
        sortCards(input.cards, input.config).map((card) => card.key),
        c.id,
      ).toEqual(expected.sort);
    }
    const [samples] = of('normalize_text');
    const texts = (samples!.input as { texts: string[] }).texts;
    expect(texts.map(normalizeText)).toEqual(samples!.expected);
  });

  it('only contains text the Rust side can read: no lone surrogates', () => {
    const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    expect(loneSurrogate.test(render(file))).toBe(false);
    expect(() => JSON.parse(render(file))).not.toThrow();
  });
});
