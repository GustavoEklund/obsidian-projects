// @vitest-environment jsdom
import { isArchivedDone, type Card } from '@oprojects/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_EPIC } from '../src/ui/state';
import { text, texts } from './helpers/dom';
import { createSandbox, makeCard, type Sandbox } from './helpers/sandbox';

let sb: Sandbox;
afterEach(() => sb.dispose());

const visibleSample = (s: Sandbox) =>
  s.store.all().filter((c) => c.type !== 'epic' && !isArchivedDone(c, s.config, s.now));

describe('BoardUI rendering', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  it('renders one column per configured column, in order, with its name', () => {
    const cols = [...sb.container.querySelectorAll<HTMLElement>('.op-col')];
    expect(cols.map((c) => c.dataset.col)).toEqual(sb.config.columns.map((c) => c.id));
    expect(texts(sb.container, '.op-col-name')).toEqual(sb.config.columns.map((c) => c.name));
    expect(cols.map((c) => c.getAttribute('aria-label'))).toEqual(sb.config.columns.map((c) => c.name));
  });

  it('marks done columns with a check and the is-done class', () => {
    expect(sb.column('done').classList.contains('op-col-is-done')).toBe(true);
    expect(sb.column('done').querySelector('.op-col-head svg')).not.toBeNull();
    expect(sb.column('todo').classList.contains('op-col-is-done')).toBe(false);
    expect(sb.column('todo').querySelector('.op-col-head svg')).toBeNull();
  });

  it('shows every card except epics and old done cards (hidden by default)', () => {
    const shown = [...sb.container.querySelectorAll<HTMLElement>('.op-card')].map((c) => c.dataset.key).sort();
    expect(shown).toEqual(
      visibleSample(sb)
        .map((c) => c.key)
        .sort(),
    );
    expect(shown).toHaveLength(20); // 24 sample cards - 3 epics - 1 done card resolved 40 days ago
    expect(sb.card('OP-1')).toBeNull();
    expect(sb.card('OP-20')).toBeNull();
  });

  it('puts each card in its column, ordered by rank', () => {
    for (const col of sb.config.columns) {
      const expected = visibleSample(sb)
        .filter((c) => c.status === col.id)
        .sort((a, b) => (a.rank < b.rank ? -1 : 1))
        .map((c) => c.key);
      expect(sb.keys(col.id)).toEqual(expected);
    }
  });

  it('shows a plain count in columns without a WIP limit', () => {
    expect(text(sb.column('todo').querySelector('.op-col-count'))).toBe(String(sb.keys('todo').length));
    expect(text(sb.column('done').querySelector('.op-col-count'))).toBe(String(sb.keys('done').length));
  });

  it('shows used/limit and flags a column that exceeds its WIP limit', () => {
    const doing = sb.column('doing');
    expect(sb.keys('doing').length).toBeGreaterThan(4);
    expect(text(doing.querySelector('.op-col-count'))).toBe(`${sb.keys('doing').length}/4`);
    expect(doing.querySelector('.op-col-count')!.classList.contains('is-over')).toBe(true);
    expect(doing.classList.contains('op-col-wip-over')).toBe(true);
    expect(doing.querySelector<HTMLElement>('.op-col-count')!.title).toContain('WIP limit exceeded');

    const review = sb.column('review');
    expect(text(review.querySelector('.op-col-count'))).toBe(`${sb.keys('review').length}/3`);
    expect(review.classList.contains('op-col-wip-over')).toBe(false);
    expect(review.querySelector<HTMLElement>('.op-col-count')!.title).toBe('');
  });

  it('clears the WIP warning when a card leaves the column', async () => {
    await sb.host.move('OP-10', 'todo');
    await sb.settle();
    expect(text(sb.column('doing').querySelector('.op-col-count'))).toBe('4/4');
    expect(sb.column('doing').classList.contains('op-col-wip-over')).toBe(false);
  });

  it('counts epics hidden from the board out of the WIP total, and counts shown epics in', async () => {
    const before = text(sb.column('doing').querySelector('.op-col-count'));
    sb.ui.setState({ showEpics: true });
    await sb.settle();
    expect(text(sb.column('doing').querySelector('.op-col-count'))).not.toBe(before);
    expect(sb.keys('doing')).toEqual(expect.arrayContaining(['OP-1', 'OP-3']));
  });

  it('shows an empty-state message in a column with no cards', async () => {
    for (const key of sb.keys('review')) await sb.host.move(key, 'todo');
    await sb.settle();
    const empty = sb.column('review').querySelector<HTMLElement>('.op-col-empty')!;
    expect(empty.hidden).toBe(false);
    expect(text(empty)).toBe('No cards');
    expect(sb.column('todo').querySelector<HTMLElement>('.op-col-empty')!.hidden).toBe(true);
  });

  it('says "no cards match" instead when the emptiness comes from filters', async () => {
    sb.ui.setState({ text: 'zzz-nothing-matches' });
    await sb.settle();
    for (const col of sb.config.columns) {
      const empty = sb.column(col.id).querySelector<HTMLElement>('.op-col-empty')!;
      expect(empty.hidden).toBe(false);
      expect(text(empty)).toBe('No cards match the filters');
    }
  });

  it('shows the loading hint until the first full load finishes', async () => {
    sb.dispose();
    sb = await createSandbox({ mount: false });
    sb.store.ready = false;
    sb.mount();
    expect(sb.container.querySelector<HTMLElement>('.op-loading')!.hidden).toBe(false);
    sb.store.replaceAll([...sb.store.all()]);
    await sb.settle();
    expect(sb.container.querySelector<HTMLElement>('.op-loading')!.hidden).toBe(true);
  });

  it('exposes the board as an accessible list with labelled root', () => {
    expect(sb.container.querySelector('.op-board')!.getAttribute('role')).toBe('list');
    expect(sb.container.querySelector('.op-root')!.getAttribute('aria-label')).toBe('Card board');
  });

  it('shows a card in the first column when its status matches no column', async () => {
    sb.store.apply(makeCard('OP-90', { status: 'ghost-column' }));
    await sb.settle();
    expect(sb.keys('todo')).toContain('OP-90');
  });

  it('rebuilds the columns when the board settings change, keeping the cards on screen', async () => {
    const before = sb.card('OP-5')!;
    sb.config.columns = [
      { id: 'todo', name: 'Backlog' },
      { id: 'doing', name: 'Now' },
      { id: 'review', name: 'Review' },
      { id: 'done', name: 'Shipped', done: true },
    ];
    sb.store.touch();
    await sb.settle();
    expect(texts(sb.container, '.op-col-name')).toEqual(['Backlog', 'Now', 'Review', 'Shipped']);
    expect(sb.card('OP-5')).toBe(before); // the element survives, it only moves into the new list
    expect(sb.column('doing').querySelector('.op-col-count')!.classList.contains('is-over')).toBe(false); // the WIP limit is gone
  });

  it('moves the cards of a removed column into the first column', async () => {
    sb.config.columns = sb.config.columns.filter((c) => c.id !== 'review');
    sb.store.touch();
    await sb.settle();
    expect(sb.container.querySelector('.op-col[data-col="review"]')).toBeNull();
    expect(sb.keys('todo')).toEqual(expect.arrayContaining(['OP-15', 'OP-16']));
  });
});

describe('BoardUI incremental rendering', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  it('keeps every other card element untouched when one card changes', async () => {
    const firstChildren = new Map(
      [...sb.container.querySelectorAll<HTMLElement>('.op-card')].map((c) => [c.dataset.key!, c.firstElementChild]),
    );
    sb.store.apply({ ...sb.store.get('OP-5')!, title: 'A brand new title' });
    await sb.settle();
    expect(text(sb.card('OP-5')!.querySelector('.op-card-title'))).toBe('A brand new title');
    expect(sb.card('OP-5')!.firstElementChild).not.toBe(firstChildren.get('OP-5')); // re-filled
    const untouched = [...firstChildren.keys()].filter((k) => k !== 'OP-5');
    expect(untouched.map((k) => sb.card(k)!.firstElementChild)).toEqual(untouched.map((k) => firstChildren.get(k))); // not even re-filled
    expect(untouched.every((k) => sb.card(k)!.firstElementChild === firstChildren.get(k))).toBe(true);
  });

  it('reuses the element of a card that only moves to another column', async () => {
    const el = sb.card('OP-5')!;
    await sb.host.move('OP-5', 'review');
    await sb.settle();
    expect(sb.card('OP-5')).toBe(el);
    expect(sb.keys('review')).toContain('OP-5');
    expect(sb.keys('todo')).not.toContain('OP-5');
  });

  it('reorders by moving elements, not rebuilding them', async () => {
    const [first, second] = sb.keys('todo');
    const firstEl = sb.card(first!)!;
    const secondEl = sb.card(second!)!;
    await sb.host.move(first!, 'todo', { after: second! });
    await sb.settle();
    expect(sb.keys('todo').slice(0, 2)).toEqual([second, first]);
    expect(sb.card(first!)).toBe(firstEl);
    expect(sb.card(second!)).toBe(secondEl);
  });

  it('adds an element for a new card and removes the one of a deleted card', async () => {
    const created = await sb.host.create({ title: 'Brand new', status: 'review' });
    await sb.settle();
    expect(sb.keys('review')).toContain(created.key);
    await sb.host.remove(created.key);
    await sb.settle();
    expect(sb.card(created.key)).toBeNull();
    expect(sb.container.querySelectorAll('.op-card[data-key="OP-25"]')).toHaveLength(0);
  });

  it('coalesces several store changes within a frame into one render', async () => {
    const cards = vi.spyOn(sb.host, 'cards');
    cards.mockClear();
    const keys = sb.keys('todo').slice(0, 3);
    for (const key of keys) sb.store.apply({ ...sb.store.get(key)!, title: `x ${key}` });
    expect(cards).not.toHaveBeenCalled(); // nothing rendered yet: a frame is pending
    await sb.settle();
    expect(cards).toHaveBeenCalledTimes(1);
    expect(texts(sb.column('todo'), '.op-card-title').slice(0, 3)).toEqual(keys.map((k) => `x ${k}`));
  });

  it('keeps the element of a card that is only filtered out, so clearing the search re-attaches it', async () => {
    const el = sb.card('OP-5')!;
    sb.ui.setState({ text: 'checkout' });
    await sb.settle();
    expect(sb.card('OP-5')).toBeNull();
    sb.ui.setState({ text: '' });
    await sb.settle();
    expect(sb.card('OP-5')).toBe(el);
  });

  it('does not render while destroyed: later store changes leave the DOM alone', async () => {
    const ui = sb.ui;
    const el = ui.el;
    ui.destroy();
    expect(el.isConnected).toBe(false);
    sb.store.apply({ ...sb.store.get('OP-5')!, title: 'changed after destroy' });
    await sb.settle();
    expect(el.querySelector('.op-card[data-key="OP-5"] .op-card-title')?.textContent).not.toBe('changed after destroy');
  });

  it('renders again right away with renderNow()', () => {
    sb.store.apply({ ...sb.store.get('OP-5')!, title: 'Right now' });
    sb.ui.renderNow();
    expect(text(sb.card('OP-5')!.querySelector('.op-card-title'))).toBe('Right now');
  });
});

describe('BoardUI filters and view toggles (through setState)', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  const shown = (): string[] =>
    [...sb.container.querySelectorAll<HTMLElement>('.op-card')].map((c) => c.dataset.key!).sort();
  const keysWhere = (fn: (c: Card) => boolean) =>
    visibleSample(sb)
      .filter(fn)
      .map((c) => c.key)
      .sort();

  it('starts from the default state', () => {
    expect(sb.ui.getState()).toMatchObject({
      text: '',
      assignee: [],
      type: [],
      priority: [],
      labels: [],
      parent: null,
      mine: false,
      showEpics: false,
      showArchived: false,
      drawerWidth: null,
    });
  });

  it('filters by text', async () => {
    sb.ui.setState({ text: 'login' });
    await sb.settle();
    expect(shown()).toEqual(keysWhere((c) => /login/i.test(c.title) || /login/i.test(c.body)));
    expect(shown().length).toBeGreaterThan(0);
  });

  it('filters by assignee, including the unassigned bucket', async () => {
    sb.ui.setState({ assignee: ['Carla'] });
    await sb.settle();
    expect(shown()).toEqual(keysWhere((c) => c.assignee === 'Carla'));
    sb.ui.setState({ assignee: ['@none'] });
    await sb.settle();
    expect(shown()).toEqual(keysWhere((c) => !c.assignee));
  });

  it('"only mine" uses the configured user', async () => {
    sb.ui.setState({ mine: true });
    await sb.settle();
    expect(shown()).toEqual(keysWhere((c) => c.assignee === 'Ana'));
  });

  it('filters by type, priority and label', async () => {
    sb.ui.setState({ type: ['bug'] });
    await sb.settle();
    expect(shown()).toEqual(keysWhere((c) => c.type === 'bug'));
    sb.ui.setState({ type: [], priority: ['highest', 'high'] });
    await sb.settle();
    expect(shown()).toEqual(keysWhere((c) => c.priority === 'highest' || c.priority === 'high'));
    sb.ui.setState({ priority: [], labels: ['security'] });
    await sb.settle();
    expect(shown()).toEqual(keysWhere((c) => c.labels.includes('security')));
  });

  it('filters by epic, and by "no epic"', async () => {
    sb.ui.setState({ parent: 'OP-1' });
    await sb.settle();
    expect(shown()).toEqual(keysWhere((c) => c.parent === 'OP-1'));
    sb.ui.setState({ parent: NO_EPIC });
    await sb.settle();
    expect(shown()).toEqual(keysWhere((c) => !c.parent));
  });

  it('combines filters', async () => {
    sb.ui.setState({ type: ['bug'], assignee: ['Ana'] });
    await sb.settle();
    expect(shown()).toEqual(keysWhere((c) => c.type === 'bug' && c.assignee === 'Ana'));
  });

  it('shows epics as cards when asked, and old done cards when asked', async () => {
    sb.ui.setState({ showEpics: true });
    await sb.settle();
    expect(shown()).toEqual(expect.arrayContaining(['OP-1', 'OP-2', 'OP-3']));
    sb.ui.setState({ showArchived: true });
    await sb.settle();
    expect(shown()).toContain('OP-20');
  });

  it('reports every state change through onState, merged with what was there', () => {
    sb.ui.setState({ text: 'a' });
    sb.ui.setState({ mine: true });
    expect(sb.states.at(-1)).toMatchObject({ text: 'a', mine: true });
    expect(sb.ui.getState()).toBe(sb.states.at(-1));
  });

  it('restores a saved state, sanitizing garbage', async () => {
    sb.dispose();
    sb = await createSandbox({
      state: { text: 'login', type: ['bug', 'nonsense', 7], mine: 'yes', drawerWidth: 'wide' },
    });
    expect(sb.ui.getState()).toMatchObject({ text: 'login', type: ['bug'], mine: false, drawerWidth: null });
    expect(sb.container.querySelector<HTMLInputElement>('.op-search-input')!.value).toBe('login');
  });
});
