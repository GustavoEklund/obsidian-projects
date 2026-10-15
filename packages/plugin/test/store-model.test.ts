import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { CardStore } from '../src/store';
import { makeCard } from './helpers/cards';

const KEYS = ['OP-1', 'OP-2', 'OP-3', 'OP-4'];
const FOLDERS = ['Cards', 'Cards/Archive'];

type Op =
  | { kind: 'apply'; key: string; title: string; folder: string }
  | { kind: 'remove'; key: string }
  | { kind: 'removePath'; key: string; folder: string }
  | { kind: 'touch' };

const pathOf = (key: string, folder: string) => `${folder}/${key}.md`;

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('apply' as const),
    key: fc.constantFrom(...KEYS),
    title: fc.constantFrom('a', 'b', 'c'),
    folder: fc.constantFrom(...FOLDERS),
  }),
  fc.record({ kind: fc.constant('remove' as const), key: fc.constantFrom(...KEYS) }),
  fc.record({
    kind: fc.constant('removePath' as const),
    key: fc.constantFrom(...KEYS),
    folder: fc.constantFrom(...FOLDERS),
  }),
  fc.constant({ kind: 'touch' as const }),
);

/** Run an op on the store; returns whether the store reported a change. */
function run(store: CardStore, op: Op): boolean {
  switch (op.kind) {
    case 'apply':
      return store.apply(makeCard(op.key, { title: op.title, path: pathOf(op.key, op.folder) }));
    case 'remove':
      return store.remove(op.key);
    case 'removePath':
      return store.removePath(pathOf(op.key, op.folder));
    case 'touch':
      store.touch();
      return true;
  }
}

/** The same thing, stated as plainly as possible. */
function model(ops: Op[]): Map<string, { title: string; path: string }> {
  const cards = new Map<string, { title: string; path: string }>();
  for (const op of ops) {
    if (op.kind === 'apply') cards.set(op.key, { title: op.title, path: pathOf(op.key, op.folder) });
    else if (op.kind === 'remove') cards.delete(op.key);
    else if (op.kind === 'removePath') {
      const path = pathOf(op.key, op.folder);
      const owner = [...cards].find(([, c]) => c.path === path);
      if (owner) cards.delete(owner[0]);
    }
  }
  return cards;
}

describe('CardStore against a plain-Map model', () => {
  it('holds exactly the cards the model says after any sequence of operations', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const store = new CardStore();
        store.replaceAll([]);
        for (const op of ops) run(store, op);
        const expected = model(ops);
        expect(
          store
            .all()
            .map((c) => [c.key, c.title, c.path])
            .sort(),
        ).toEqual([...expected].map(([k, v]) => [k, v.title, v.path]).sort());
      }),
      { numRuns: 200 },
    );
  });

  it('keeps the path index consistent with the cards (no stale path points at a card)', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const store = new CardStore();
        store.replaceAll([]);
        for (const op of ops) run(store, op);
        for (const key of KEYS) {
          for (const folder of FOLDERS) {
            const owner = store.keyAt(pathOf(key, folder));
            const card = owner ? store.get(owner) : undefined;
            expect(owner === undefined || card?.path === pathOf(key, folder)).toBe(true);
          }
        }
        for (const card of store.all()) expect(store.keyAt(card.path)).toBe(card.key);
      }),
      { numRuns: 200 },
    );
  });

  it('notifies once per effective change, and never for operations that report no change', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const store = new CardStore();
        store.replaceAll([]);
        const listener = vi.fn();
        store.subscribe(listener);
        let changes = 0;
        for (const op of ops) if (run(store, op)) changes++;
        expect(listener).toHaveBeenCalledTimes(changes);
      }),
      { numRuns: 200 },
    );
  });

  it('a batch notifies at most once, and not at all when nothing in it changed anything', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const store = new CardStore();
        store.replaceAll([]);
        const listener = vi.fn();
        store.subscribe(listener);
        let changes = 0;
        store.batch(() => {
          for (const op of ops) if (run(store, op)) changes++;
        });
        expect(listener).toHaveBeenCalledTimes(changes === 0 ? 0 : 1);
        expect(store.all().length).toBe(model(ops).size);
      }),
      { numRuns: 200 },
    );
  });

  it('all() is stable between changes and fresh after one', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 20 }), (ops) => {
        const store = new CardStore();
        store.replaceAll([]);
        for (const op of ops) {
          const before = store.all();
          expect(store.all()).toBe(before);
          const changed = run(store, op);
          expect(store.all() === before).toBe(!changed);
        }
      }),
      { numRuns: 100 },
    );
  });
});
