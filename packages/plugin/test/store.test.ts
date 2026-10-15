import { parseCard, type Card } from '@oprojects/core';
import { describe, expect, it, vi } from 'vitest';
import { CardStore } from '../src/store';

const card = (key: string, extra = ''): Card => parseCard(`Cards/${key}.md`, `---\nkey: ${key}\ntitle: T ${key}\nstatus: todo\n${extra}---\n`)!;

describe('CardStore', () => {
  it('is not ready until the first full load', () => {
    const s = new CardStore();
    expect(s.ready).toBe(false);
    s.replaceAll([card('OP-1')]);
    expect(s.ready).toBe(true);
    expect(s.all().map((c) => c.key)).toEqual(['OP-1']);
  });

  it('notifies on real changes only', () => {
    const s = new CardStore();
    s.replaceAll([card('OP-1')]);
    const spy = vi.fn();
    s.subscribe(spy);
    expect(s.apply(card('OP-1'))).toBe(false); // identical: a vault echo of our own write
    expect(spy).not.toHaveBeenCalled();
    expect(s.apply(card('OP-1', 'priority: high\n'))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('batch() produces a single notification', () => {
    const s = new CardStore();
    s.replaceAll([]);
    const spy = vi.fn();
    s.subscribe(spy);
    s.batch(() => {
      s.apply(card('OP-1'));
      s.apply(card('OP-2'));
      s.remove('OP-1');
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(s.all().map((c) => c.key)).toEqual(['OP-2']);
  });

  it('tracks paths: removePath and renames keep the card', () => {
    const s = new CardStore();
    s.replaceAll([card('OP-1')]);
    const moved = { ...card('OP-1'), path: 'Cards/Archive/OP-1.md' };
    s.apply(moved);
    expect(s.keyAt('Cards/OP-1.md')).toBeUndefined();
    expect(s.removePath('Cards/OP-1.md')).toBe(false); // old path no longer maps to the card
    expect(s.get('OP-1')?.path).toBe('Cards/Archive/OP-1.md');
    expect(s.removePath('Cards/Archive/OP-1.md')).toBe(true);
    expect(s.get('OP-1')).toBeUndefined();
  });

  it('returns a stable array until something changes (cheap for render loops)', () => {
    const s = new CardStore();
    s.replaceAll([card('OP-1')]);
    expect(s.all()).toBe(s.all());
    const before = s.all();
    s.apply(card('OP-2'));
    expect(s.all()).not.toBe(before);
  });

  it('unsubscribe stops notifications', () => {
    const s = new CardStore();
    const spy = vi.fn();
    const off = s.subscribe(spy);
    off();
    s.replaceAll([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
