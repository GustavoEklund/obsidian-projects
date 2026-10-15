// @vitest-environment jsdom
import { DEFAULT_CONFIG, type BoardConfig, type Card } from '@oprojects/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dictionaries, setLanguage } from '../src/i18n';
import {
  avatar,
  cardSignature,
  createCardEl,
  epicHue,
  fillCardEl,
  formatDue,
  personHue,
  priorityMark,
  setColorUniverse,
  typeBadge,
  type CardCtx,
} from '../src/ui/card-view';
import { hueOf } from '../src/ui/dom';
import { text } from './helpers/dom';
import { makeCard } from './helpers/cards';

const NOW = new Date(2026, 9, 15, 12, 0, 0);
const config: BoardConfig = { ...DEFAULT_CONFIG };
const ctxFor = (...cards: Card[]): CardCtx => ({ config, byKey: new Map(cards.map((c) => [c.key, c])), now: NOW });
const render = (card: Card, ctx = ctxFor(card)) => {
  const el = createCardEl(card.key);
  fillCardEl(el, card, ctx);
  return el;
};
const sig = (card: Card, ctx = ctxFor(card)) => cardSignature(card, ctx);

beforeEach(() => setColorUniverse([], []));
afterEach(() => setLanguage('en'));

describe('formatDue', () => {
  it('shows day and month, without the year, for the current year', () => {
    expect(formatDue('2026-10-20', NOW)).toBe('Oct 20');
    expect(formatDue('2026-01-02', NOW)).toBe('Jan 2');
  });

  it('adds the year for any other year', () => {
    expect(formatDue('2027-03-04', NOW)).toBe('Mar 4, 2027');
    expect(formatDue('2025-12-31', NOW)).toBe('Dec 31, 2025');
  });

  it('formats in the active language', () => {
    const english = formatDue('2026-10-20', NOW);
    setLanguage('pt');
    expect(formatDue('2026-10-20', NOW)).not.toBe(english);
    expect(formatDue('2026-10-20', NOW)).toContain('20');
  });
});

describe('colors', () => {
  it('derives a color per person and per epic from the whole board, case-insensitively', () => {
    setColorUniverse(['Ana', 'bruno'], ['OP-1', 'OP-2']);
    expect(personHue('ANA')).toBe(personHue('ana'));
    expect(personHue('Bruno')).toBe(personHue('bruno'));
    expect(personHue('ana')).not.toBe(personHue('bruno'));
    expect(epicHue('OP-1')).not.toBe(epicHue('OP-2'));
  });

  it('falls back to the plain hash hue for someone the board has not seen yet', () => {
    setColorUniverse([], []);
    expect(personHue('Zed')).toBe(hueOf('zed'));
    expect(epicHue('OP-9')).toBe(hueOf('OP-9'));
  });

  it('gives everyone on the board a different color', () => {
    const people = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elena', 'Fabio'];
    setColorUniverse(people, []);
    expect(new Set(people.map(personHue)).size).toBe(people.length);
  });

  it("replaces the previous board's colors when the universe changes", () => {
    setColorUniverse(['ana', 'aaa', 'ab', 'ac', 'ad', 'ae'], []);
    const crowded = personHue('ana');
    setColorUniverse([], []);
    expect(personHue('ana')).toBe(hueOf('ana')); // back to the plain hash hue
    expect(typeof crowded).toBe('number');
  });
});

describe('cardSignature', () => {
  const base = makeCard('OP-1', {
    title: 'Base',
    assignee: 'Ana',
    labels: ['x'],
    due: '2026-10-20',
    estimate: 3,
    parent: 'OP-9',
    body: '- [ ] a\n- [x] b',
    checklist: { done: 1, total: 2 },
  });
  const epic = makeCard('OP-9', { type: 'epic', title: 'Epic nine' });

  it('is stable for the same card', () => {
    expect(sig(base, ctxFor(base, epic))).toBe(sig({ ...base }, ctxFor(base, epic)));
  });

  it.each<[string, Partial<Card>]>([
    ['title', { title: 'Other' }],
    ['type', { type: 'bug' }],
    ['priority', { priority: 'highest' }],
    ['assignee', { assignee: 'Bo' }],
    ['labels', { labels: ['x', 'y'] }],
    ['due date', { due: '2026-10-21' }],
    ['estimate', { estimate: 5 }],
    ['checklist progress', { checklist: { done: 2, total: 2 } }],
    ['checklist size', { checklist: { done: 1, total: 3 } }],
    ['comment count', { comments: [{ id: 'a', author: 'Ana', at: '', text: 'hi' }] }],
    ['parent', { parent: 'OP-8' }],
    ['status into a done column', { status: 'done' }],
  ])('changes when the %s changes', (_what, patch) => {
    const ctx = ctxFor(base, epic);
    expect(sig({ ...base, ...patch }, ctx)).not.toBe(sig(base, ctx));
  });

  it.each<[string, Partial<Card>]>([
    ['rank', { rank: 'Z' }],
    ['updated time', { updated: '2026-10-14T00:00:00.000Z' }],
    ['body text that keeps the same checklist', { body: 'something else entirely' }],
    ['path', { path: 'Cards/Archive/OP-1.md' }],
    ['status inside the open columns', { status: 'doing' }],
  ])('does not change when only the %s changes (the card looks the same)', (_what, patch) => {
    const ctx = ctxFor(base, epic);
    expect(sig({ ...base, ...patch }, ctx)).toBe(sig(base, ctx));
  });

  it('changes when the parent epic is renamed, because the card shows the epic title', () => {
    const before = sig(base, ctxFor(base, epic));
    expect(sig(base, ctxFor(base, { ...epic, title: 'Renamed epic' }))).not.toBe(before);
  });

  it('changes when the due date crosses into "overdue" without any edit to the card', () => {
    const card = makeCard('OP-2', { due: '2026-10-15' });
    const today = sig(card, { config, byKey: new Map(), now: new Date(2026, 9, 15, 9) });
    const tomorrow = sig(card, { config, byKey: new Map(), now: new Date(2026, 9, 16, 9) });
    expect(today).not.toBe(tomorrow);
  });

  it('changes when the person color changes because the board grew', () => {
    setColorUniverse(['ana'], []);
    const before = sig(base, ctxFor(base, epic));
    setColorUniverse(['ana', 'aaa', 'ab', 'ac', 'ad'], []);
    expect(sig(base, ctxFor(base, epic))).not.toBe(before);
  });
});

describe('fillCardEl', () => {
  it('labels the card for assistive tech and shows its title', () => {
    const el = render(makeCard('OP-7', { title: 'Fix it' }));
    expect(el.getAttribute('aria-label')).toBe('OP-7: Fix it');
    expect(text(el.querySelector('.op-card-title'))).toBe('Fix it');
    expect(text(el.querySelector('.op-key'))).toBe('OP-7');
  });

  it('createCardEl makes a focusable, draggable button keyed by the card', () => {
    const el = createCardEl('OP-7');
    expect(el.dataset.key).toBe('OP-7');
    expect(el.getAttribute('draggable')).toBe('true');
    expect(el.getAttribute('role')).toBe('button');
    expect(el.tabIndex).toBe(0);
    expect(el.classList.contains('op-card')).toBe(true);
  });

  it('can be filled again and replaces what was there (no leftovers)', () => {
    const el = createCardEl('OP-7');
    fillCardEl(el, makeCard('OP-7', { title: 'One', labels: ['a'], assignee: 'Ana' }), ctxFor());
    fillCardEl(el, makeCard('OP-7', { title: 'Two' }), ctxFor());
    expect(el.querySelectorAll('.op-card-title')).toHaveLength(1);
    expect(text(el.querySelector('.op-card-title'))).toBe('Two');
    expect(el.querySelector('.op-label')).toBeNull();
    expect(el.querySelector('.op-avatar')).toBeNull();
  });

  it('shows the type badge and priority mark', () => {
    const el = render(makeCard('OP-7', { type: 'bug', priority: 'highest' }));
    expect(el.querySelector('.op-type-bug')).not.toBeNull();
    expect(el.querySelector('.op-prio-highest')).not.toBeNull();
  });

  it('shows at most three labels and counts the rest, with their names in the tooltip', () => {
    const el = render(makeCard('OP-7', { labels: ['a', 'b', 'c', 'd', 'e'] }));
    expect([...el.querySelectorAll('.op-label:not(.op-label-more)')].map(text)).toEqual(['a', 'b', 'c']);
    const more = el.querySelector<HTMLElement>('.op-label-more')!;
    expect(text(more)).toBe('+2');
    expect(more.title).toBe('d, e');
  });

  it('shows exactly three labels without a "+0"', () => {
    const el = render(makeCard('OP-7', { labels: ['a', 'b', 'c'] }));
    expect(el.querySelectorAll('.op-label')).toHaveLength(3);
    expect(el.querySelector('.op-label-more')).toBeNull();
  });

  it('shows no meta row for a card with no epic and no labels', () => {
    expect(render(makeCard('OP-7')).querySelector('.op-card-meta')).toBeNull();
  });

  it('shows the parent epic by its title, with key and title in the tooltip', () => {
    const epic = makeCard('OP-9', { type: 'epic', title: 'Checkout' });
    const child = makeCard('OP-7', { parent: 'OP-9' });
    const chip = render(child, ctxFor(child, epic)).querySelector<HTMLElement>('.op-epic')!;
    expect(text(chip)).toBe('Checkout');
    expect(chip.title).toBe('OP-9: Checkout');
    expect(chip.style.getPropertyValue('--op-hue')).toBe(String(epicHue('OP-9')));
  });

  it('falls back to the epic key when the epic is not on the board', () => {
    const child = makeCard('OP-7', { parent: 'OP-9' });
    const chip = render(child).querySelector<HTMLElement>('.op-epic')!;
    expect(text(chip)).toBe('OP-9');
    expect(chip.title).toBe('OP-9');
  });

  it('shows the comment count with a singular or plural tooltip', () => {
    const one = render(
      makeCard('OP-7', { comments: [{ id: 'a', author: 'A', at: '', text: 'x' }] }),
    ).querySelector<HTMLElement>('.op-chip-comments')!;
    expect(text(one)).toBe('1');
    expect(one.title).toBe('1 comment');
    const comments = ['a', 'b', 'c'].map((id) => ({ id, author: 'A', at: '', text: 'x' }));
    const three = render(makeCard('OP-7', { comments })).querySelector<HTMLElement>('.op-chip-comments')!;
    expect(text(three)).toBe('3');
    expect(three.title).toBe('3 comments');
    expect(render(makeCard('OP-7')).querySelector('.op-chip-comments')).toBeNull();
  });

  it('shows checklist progress, and marks it complete when everything is done', () => {
    const partial = render(makeCard('OP-7', { checklist: { done: 1, total: 3 } })).querySelector<HTMLElement>(
      '.op-chip-check',
    )!;
    expect(text(partial)).toBe('1/3');
    expect(partial.classList.contains('op-chip-ok')).toBe(false);
    expect(partial.title).toBe('1 of 3 checklist items done');
    expect(
      render(makeCard('OP-7', { checklist: { done: 3, total: 3 } }))
        .querySelector('.op-chip-check')!
        .classList.contains('op-chip-ok'),
    ).toBe(true);
    expect(render(makeCard('OP-7')).querySelector('.op-chip-check')).toBeNull();
  });

  it.each([
    ['2026-10-10', 'overdue', 'Overdue'],
    ['2026-10-15', 'soon', 'Due soon'],
    ['2026-10-17', 'soon', 'Due soon'],
    ['2026-10-18', 'later', ''],
  ])('a card due %s is "%s"', (due, state, label) => {
    const chip = render(makeCard('OP-7', { due })).querySelector<HTMLElement>('.op-due')!;
    expect(chip.classList.contains(`op-due-${state}`)).toBe(true);
    expect(chip.title).toBe(label ? `${label}: ${due}` : due);
    expect(text(chip)).toBe(formatDue(due, NOW));
  });

  it('never calls a done card overdue', () => {
    const el = render(makeCard('OP-7', { due: '2026-10-01', status: 'done' }));
    expect(el.classList.contains('op-done')).toBe(true);
    expect(el.querySelector('.op-due')!.classList.contains('op-due-later')).toBe(true);
  });

  it('only marks cards in done columns as done', () => {
    expect(render(makeCard('OP-7', { status: 'doing' })).classList.contains('op-done')).toBe(false);
    expect(render(makeCard('OP-7', { status: 'done' })).classList.contains('op-done')).toBe(true);
  });

  it('removes the done mark when the card is refilled in an open column', () => {
    const el = createCardEl('OP-7');
    fillCardEl(el, makeCard('OP-7', { status: 'done' }), ctxFor());
    fillCardEl(el, makeCard('OP-7', { status: 'todo' }), ctxFor());
    expect(el.classList.contains('op-done')).toBe(false);
  });

  it('shows an estimate of zero (it is a value, not an absence)', () => {
    expect(text(render(makeCard('OP-7', { estimate: 0 })).querySelector('.op-estimate'))).toBe('0');
    expect(text(render(makeCard('OP-7', { estimate: 2.5 })).querySelector('.op-estimate'))).toBe('2.5');
    expect(render(makeCard('OP-7')).querySelector('.op-estimate')).toBeNull();
  });

  it('shows the assignee as an avatar with initials and full name', () => {
    const avatarEl = render(makeCard('OP-7', { assignee: 'Ana Maria Souza' })).querySelector<HTMLElement>(
      '.op-avatar',
    )!;
    expect(text(avatarEl)).toBe('AS');
    expect(avatarEl.title).toBe('Ana Maria Souza');
  });

  it('puts the key and badge on the left and the chips on the right', () => {
    const el = render(makeCard('OP-7', { assignee: 'Ana', due: '2026-10-20' }));
    expect(el.querySelector('.op-foot-left .op-key')).not.toBeNull();
    expect(el.querySelector('.op-foot-left .op-type')).not.toBeNull();
    expect(el.querySelector('.op-foot-right .op-due')).not.toBeNull();
    expect(el.querySelector('.op-foot-right .op-avatar')).not.toBeNull();
  });

  it('writes the card text as text, never as HTML', () => {
    const el = render(
      makeCard('OP-7', { title: '<img src=x onerror=alert(1)>', labels: ['<b>x</b>'], assignee: '<i>me</i>' }),
    );
    expect(el.querySelector('img, b, i')).toBeNull();
    expect(text(el.querySelector('.op-card-title'))).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('badges', () => {
  it('typeBadge carries the type class, a localized tooltip and the requested size', () => {
    const badge = typeBadge('story', 20);
    expect(badge.className).toContain('op-type-story');
    expect(badge.title).toBe('Story');
    expect(badge.style.getPropertyValue('--op-size')).toBe('20px');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(typeBadge('epic').style.getPropertyValue('--op-size')).toBe('16px');
  });

  it('priorityMark carries the priority class and a localized tooltip', () => {
    const mark = priorityMark('lowest');
    expect(mark.className).toContain('op-prio-lowest');
    expect(mark.title).toBe('Lowest');
  });

  it("avatar shows initials, the name, the person's hue and the requested size", () => {
    setColorUniverse(['ana'], []);
    const el = avatar('Ana', 30);
    expect(text(el)).toBe('AN');
    expect(el.title).toBe('Ana');
    expect(el.style.getPropertyValue('--op-hue')).toBe(String(personHue('Ana')));
    expect(el.style.getPropertyValue('--op-size')).toBe('30px');
    expect(avatar('Ana').style.getPropertyValue('--op-size')).toBe('22px');
  });

  it('badges follow the interface language', () => {
    setLanguage('pt');
    expect(typeBadge('story').title).not.toBe(dictionaries.en!['type.story']);
    expect(priorityMark('high').title).not.toBe(dictionaries.en!['priority.high']);
  });
});
