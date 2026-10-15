import { CARD_TYPES, DEFAULT_CONFIG, PRIORITIES, UNASSIGNED, type BoardConfig } from '@oprojects/core';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  NO_EPIC,
  activeFilterCount,
  clearFilters,
  defaultState,
  sanitizeState,
  toFilter,
  type UiState,
} from '../src/ui/state';

const text = fc.string({ maxLength: 12 });
const stateArb: fc.Arbitrary<UiState> = fc.record({
  text,
  assignee: fc.array(text, { maxLength: 4 }),
  type: fc.subarray([...CARD_TYPES]),
  priority: fc.subarray([...PRIORITIES]),
  labels: fc.array(text, { maxLength: 4 }),
  parent: fc.option(fc.constantFrom('OP-1', 'OP-2', NO_EPIC), { nil: null }),
  mine: fc.boolean(),
  showEpics: fc.boolean(),
  showArchived: fc.boolean(),
  drawerWidth: fc.option(fc.integer({ min: 240, max: 4000 }), { nil: null }),
});

/** Raw "saved" values as hostile as a hand-edited or ancient layout file could make them. */
const rawArb = fc.oneof(
  fc.anything(),
  fc.record(
    {
      text: fc.anything(),
      assignee: fc.anything(),
      type: fc.anything(),
      priority: fc.anything(),
      labels: fc.anything(),
      parent: fc.anything(),
      mine: fc.anything(),
      showEpics: fc.anything(),
      showArchived: fc.anything(),
      drawerWidth: fc.anything(),
    },
    { requiredKeys: [] },
  ),
);

function isValid(s: UiState): boolean {
  const strings = (list: unknown[]) => list.every((x) => typeof x === 'string');
  return (
    typeof s.text === 'string' &&
    strings(s.assignee) &&
    strings(s.labels) &&
    s.type.every((x) => (CARD_TYPES as readonly string[]).includes(x)) &&
    s.priority.every((x) => (PRIORITIES as readonly string[]).includes(x)) &&
    (s.parent === null || typeof s.parent === 'string') &&
    [s.mine, s.showEpics, s.showArchived].every((flag) => typeof flag === 'boolean') &&
    (s.drawerWidth === null || (Number.isInteger(s.drawerWidth) && s.drawerWidth >= 240 && s.drawerWidth <= 4000))
  );
}

describe('sanitizeState', () => {
  it('never throws and always returns a valid state, whatever it is given', () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        expect(isValid(sanitizeState(raw))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        const once = sanitizeState(raw);
        expect(sanitizeState(once)).toEqual(once);
      }),
      { numRuns: 300 },
    );
  });

  it('returns a valid state untouched (it survives being saved as JSON and restored)', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        expect(sanitizeState(JSON.parse(JSON.stringify(state)))).toEqual(state);
      }),
      { numRuns: 300 },
    );
  });

  it('turns nothing, null and non-objects into the default state', () => {
    for (const raw of [undefined, null, 0, 'text', true, [], () => 1])
      expect(sanitizeState(raw)).toEqual(defaultState());
  });

  it('only accepts a literal true for flags (the string "true" or the number 1 are not)', () => {
    expect(sanitizeState({ mine: 'true', showEpics: 1, showArchived: true })).toMatchObject({
      mine: false,
      showEpics: false,
      showArchived: true,
    });
  });

  it('drops unknown fields instead of carrying them along', () => {
    expect(Object.keys(sanitizeState({ text: 'x', evil: 1, __proto__: { polluted: true } })).sort()).toEqual(
      Object.keys(defaultState()).sort(),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps only the strings of a mixed array', () => {
    expect(sanitizeState({ assignee: ['Ana', 3, null, 'Bo', {}], labels: 'not an array' })).toMatchObject({
      assignee: ['Ana', 'Bo'],
      labels: [],
    });
  });

  it('keeps only known types and priorities', () => {
    expect(sanitizeState({ type: ['bug', 'epic', 'saga', 4], priority: ['high', 'urgent', 'lowest'] })).toMatchObject({
      type: ['bug', 'epic'],
      priority: ['high', 'lowest'],
    });
  });

  it('accepts widths at the limits and rejects just outside them', () => {
    expect(sanitizeState({ drawerWidth: 240 }).drawerWidth).toBe(240);
    expect(sanitizeState({ drawerWidth: 4000 }).drawerWidth).toBe(4000);
    expect(sanitizeState({ drawerWidth: 239.4 }).drawerWidth).toBeNull();
    expect(sanitizeState({ drawerWidth: 4000.4 }).drawerWidth).toBeNull();
    expect(sanitizeState({ drawerWidth: 300.5 }).drawerWidth).toBe(301);
  });
});

describe('activeFilterCount and clearFilters', () => {
  it('counts one per active filter dimension (blank text does not count)', () => {
    expect(activeFilterCount(defaultState())).toBe(0);
    expect(activeFilterCount({ ...defaultState(), text: '   ' })).toBe(0);
    expect(
      activeFilterCount({
        ...defaultState(),
        text: 'x',
        assignee: ['a', 'b'],
        type: ['bug'],
        priority: ['low'],
        labels: ['l'],
        parent: 'OP-1',
        mine: true,
      }),
    ).toBe(7);
    expect(activeFilterCount({ ...defaultState(), showEpics: true, showArchived: true, drawerWidth: 500 })).toBe(0); // view options are not filters
  });

  it('clearing leaves no active filter and keeps how the view is arranged', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const cleared = clearFilters(state);
        expect(activeFilterCount(cleared)).toBe(0);
        expect(cleared).toMatchObject({
          showEpics: state.showEpics,
          showArchived: state.showArchived,
          drawerWidth: state.drawerWidth,
        });
        expect(clearFilters(cleared)).toEqual(cleared);
      }),
      { numRuns: 200 },
    );
  });

  it('never counts more than seven', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        expect(activeFilterCount(state)).toBeLessThanOrEqual(7);
      }),
      { numRuns: 200 },
    );
  });
});

describe('toFilter', () => {
  const config = (me: string): BoardConfig => ({ ...DEFAULT_CONFIG, me });

  it('is empty for the default state', () => {
    expect(toFilter(defaultState(), config('Ana'))).toEqual({});
  });

  it('adds "me" to the assignees only when "only mine" is on and the board knows who you are', () => {
    expect(toFilter({ ...defaultState(), mine: true }, config('Ana'))).toEqual({ assignee: ['Ana'] });
    expect(toFilter({ ...defaultState(), mine: true, assignee: ['Bo'] }, config('Ana'))).toEqual({
      assignee: ['Bo', 'Ana'],
    });
    expect(toFilter({ ...defaultState(), mine: true }, config(''))).toEqual({});
    expect(toFilter({ ...defaultState(), assignee: [UNASSIGNED] }, config('Ana'))).toEqual({ assignee: [UNASSIGNED] });
  });

  it('trims search text for the emptiness check but passes it through unchanged', () => {
    expect(toFilter({ ...defaultState(), text: '  ' }, config(''))).toEqual({});
    expect(toFilter({ ...defaultState(), text: ' login ' }, config(''))).toEqual({ text: ' login ' });
  });

  it('leaves "no epic" out (the board applies it itself) and passes a real epic through', () => {
    expect(toFilter({ ...defaultState(), parent: NO_EPIC }, config(''))).toEqual({});
    expect(toFilter({ ...defaultState(), parent: 'OP-3' }, config(''))).toEqual({ parent: 'OP-3' });
  });

  it("only includes dimensions that have something selected, and does not alias the state's arrays", () => {
    fc.assert(
      fc.property(stateArb, fc.string({ maxLength: 6 }), (state, me) => {
        const f = toFilter(state, config(me));
        expect('type' in f).toBe(state.type.length > 0);
        expect('priority' in f).toBe(state.priority.length > 0);
        expect('labels' in f).toBe(state.labels.length > 0);
        expect('assignee' in f).toBe(state.assignee.length > 0 || (state.mine && me !== ''));
        expect('text' in f).toBe(state.text.trim() !== '');
        expect(f.assignee === undefined || f.assignee !== state.assignee).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
