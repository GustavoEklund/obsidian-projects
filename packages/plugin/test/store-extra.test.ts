import type { Card } from '@oprojects/core';
import { describe, expect, it, vi } from 'vitest';
import { CardStore } from '../src/store';
import { makeCard } from './helpers/cards';

const full = (): Card =>
  makeCard('OP-1', {
    title: 'Original',
    status: 'doing',
    type: 'bug',
    priority: 'high',
    assignee: 'Ana',
    labels: ['a', 'b'],
    due: '2026-10-20',
    estimate: 3,
    parent: 'OP-9',
    rank: 'M',
    resolved: '2026-10-11T00:00:00.000Z',
    body: '\nbody\n',
    comments: [{ id: 'c1', author: 'Bo', at: '2026-10-12T00:00:00.000Z', text: 'hi' }],
  });

describe('CardStore.apply: what counts as a change', () => {
  it.each<[string, Partial<Card>]>([
    ['title', { title: 'Other' }],
    ['status', { status: 'done' }],
    ['type', { type: 'story' }],
    ['priority', { priority: 'low' }],
    ['assignee', { assignee: 'Bo' }],
    ['due date', { due: '2026-10-21' }],
    ['estimate', { estimate: 5 }],
    ['parent', { parent: 'OP-8' }],
    ['rank', { rank: 'Z' }],
    ['updated time', { updated: '2026-10-14T00:00:00.000Z' }],
    ['resolved time', { resolved: undefined }],
    ['body', { body: '\nchanged\n' }],
    ['labels', { labels: ['a', 'c'] }],
    ['label count', { labels: ['a'] }],
    ['comment text', { comments: [{ id: 'c1', author: 'Bo', at: '2026-10-12T00:00:00.000Z', text: 'edited' }] }],
    ['comment author', { comments: [{ id: 'c1', author: 'Cy', at: '2026-10-12T00:00:00.000Z', text: 'hi' }] }],
    ['comment id', { comments: [{ id: 'c2', author: 'Bo', at: '2026-10-12T00:00:00.000Z', text: 'hi' }] }],
    ['comment count', { comments: [] }],
  ])('a different %s is applied and notified', (_what, patch) => {
    const store = new CardStore();
    store.replaceAll([full()]);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.apply({ ...full(), ...patch })).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('an equal card (even as a new object) is ignored silently', () => {
    const store = new CardStore();
    store.replaceAll([full()]);
    const before = store.get('OP-1');
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.apply(full())).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(store.get('OP-1')).toBe(before); // the stored object is kept, not swapped for an equal one
  });

  it('a new key is added and notified', () => {
    const store = new CardStore();
    store.replaceAll([]);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.apply(makeCard('OP-2'))).toBe(true);
    expect(store.get('OP-2')).toBeDefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('CardStore paths', () => {
  it('removing a card does not unmap a path another card has taken over', () => {
    const store = new CardStore();
    store.replaceAll([]);
    store.apply(makeCard('OP-1', { path: 'Cards/shared.md' }));
    store.apply(makeCard('OP-2', { path: 'Cards/shared.md' })); // a sync conflict: two notes claim one path
    expect(store.keyAt('Cards/shared.md')).toBe('OP-2');
    store.remove('OP-1');
    expect(store.keyAt('Cards/shared.md')).toBe('OP-2');
    expect(store.get('OP-2')).toBeDefined();
  });

  it('removing or removePath-ing something unknown is a quiet no-op', () => {
    const store = new CardStore();
    store.replaceAll([makeCard('OP-1')]);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.remove('OP-9')).toBe(false);
    expect(store.removePath('Cards/OP-9.md')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('replaceAll forgets the old cards and their paths', () => {
    const store = new CardStore();
    store.replaceAll([makeCard('OP-1'), makeCard('OP-2')]);
    store.replaceAll([makeCard('OP-3')]);
    expect(store.all().map((c) => c.key)).toEqual(['OP-3']);
    expect(store.keyAt('Cards/OP-1.md')).toBeUndefined();
    expect(store.keyAt('Cards/OP-3.md')).toBe('OP-3');
  });

  it('replaceAll notifies once and marks the store ready, even when empty', () => {
    const store = new CardStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.replaceAll([]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.ready).toBe(true);
  });
});

describe('CardStore notifications', () => {
  it('touch() notifies and gives out a fresh snapshot, even though no card changed', () => {
    const store = new CardStore();
    store.replaceAll([makeCard('OP-1')]);
    const before = store.all();
    const listener = vi.fn();
    store.subscribe(listener);
    store.touch();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.all()).not.toBe(before);
    expect(store.all()).toEqual(before);
  });

  it('a listener may unsubscribe itself or others while being notified, without upsetting the round', () => {
    const store = new CardStore();
    store.replaceAll([]);
    const calls: string[] = [];
    let offB = () => {};
    store.subscribe(() => {
      calls.push('a');
      offB();
    });
    offB = store.subscribe(() => calls.push('b'));
    store.subscribe(() => calls.push('c'));
    store.touch();
    expect(calls).toEqual(['a', 'b', 'c']); // everyone registered at the start of the round is called
    calls.length = 0;
    store.touch();
    expect(calls).toEqual(['a', 'c']);
  });

  it('a listener added during a notification is only called from the next one', () => {
    const store = new CardStore();
    store.replaceAll([]);
    const late = vi.fn();
    let added = false;
    store.subscribe(() => {
      if (!added) {
        added = true;
        store.subscribe(late);
      }
    });
    store.touch();
    expect(late).not.toHaveBeenCalled();
    store.touch();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('subscribing the same function twice notifies it once', () => {
    const store = new CardStore();
    store.replaceAll([]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.subscribe(listener);
    store.touch();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('CardStore.batch', () => {
  it('does not notify at all when nothing in it changed anything', () => {
    const store = new CardStore();
    store.replaceAll([makeCard('OP-1')]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.batch(() => {
      store.apply(makeCard('OP-1')); // identical: a vault echo of our own write
      store.remove('OP-9');
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies once, after the last change, with every change already applied', () => {
    const store = new CardStore();
    store.replaceAll([makeCard('OP-1')]);
    const seen: string[][] = [];
    store.subscribe(() => seen.push(store.all().map((c) => c.key)));
    store.batch(() => {
      store.apply(makeCard('OP-2'));
      store.apply(makeCard('OP-3'));
      store.remove('OP-1');
    });
    expect(seen).toEqual([['OP-2', 'OP-3']]);
  });

  it('counts touch() as a change', () => {
    const store = new CardStore();
    store.replaceAll([]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.batch(() => store.touch());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('nested batches notify once, when the outermost one ends', () => {
    const store = new CardStore();
    store.replaceAll([]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.batch(() => {
      store.apply(makeCard('OP-1'));
      store.batch(() => store.apply(makeCard('OP-2')));
      expect(listener).not.toHaveBeenCalled();
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.all()).toHaveLength(2);
  });

  it('if the function throws, the error propagates, subscribers still hear about changes already made, and the store keeps working', () => {
    const store = new CardStore();
    store.replaceAll([]);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() =>
      store.batch(() => {
        store.apply(makeCard('OP-1'));
        throw new Error('halfway');
      }),
    ).toThrow('halfway');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get('OP-1')).toBeDefined();
    store.apply(makeCard('OP-2'));
    expect(listener).toHaveBeenCalledTimes(2); // listeners were put back
  });

  it('if the function throws before changing anything, nobody is notified', () => {
    const store = new CardStore();
    store.replaceAll([]);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() =>
      store.batch(() => {
        throw new Error('early');
      }),
    ).toThrow('early');
    expect(listener).not.toHaveBeenCalled();
  });

  it('subscribers added or removed during the batch are honored afterwards', () => {
    const store = new CardStore();
    store.replaceAll([]);
    const kept = vi.fn();
    const dropped = vi.fn();
    store.subscribe(kept);
    const off = store.subscribe(dropped);
    store.batch(() => {
      off();
      store.apply(makeCard('OP-1'));
    });
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });
});
