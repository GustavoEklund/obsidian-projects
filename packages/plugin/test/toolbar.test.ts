// @vitest-environment jsdom
import { DEFAULT_CONFIG } from '@oprojects/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../src/i18n';
import { NO_EPIC } from '../src/ui/state';
import { click, key, text, texts, typeInto } from './helpers/dom';
import { createSandbox, makeCard, type Sandbox } from './helpers/sandbox';

let sb: Sandbox;
afterEach(() => sb.dispose());

const PILLS = ['assignee', 'type', 'priority', 'labels', 'parent'] as const;
const pill = (name: (typeof PILLS)[number]) =>
  sb.container.querySelectorAll<HTMLButtonElement>('.op-pill')[PILLS.indexOf(name)]!;
const badge = (name: (typeof PILLS)[number]) => pill(name).querySelector<HTMLElement>('.op-pill-count')!;
const search = () => sb.container.querySelector<HTMLInputElement>('.op-search-input')!;
const clearSearch = () => sb.container.querySelector<HTMLButtonElement>('.op-search-clear')!;
const clearAll = () => sb.container.querySelector<HTMLButtonElement>('.op-link-btn')!;
const toggle = (label: string) =>
  [...sb.container.querySelectorAll<HTMLButtonElement>('.op-toggle')].find((t) => text(t) === label)!;
const rows = () => [...document.querySelectorAll<HTMLElement>('.op-pop-item')];
const rowLabels = () => texts(document, '.op-pop-label');
const pick = async (label: string) => {
  click(rows().find((r) => text(r.querySelector('.op-pop-label')) === label)!);
  await sb.settle();
};
const shown = () => [...sb.container.querySelectorAll<HTMLElement>('.op-card')].map((c) => c.dataset.key!).sort();

describe('toolbar at rest', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  it('is an accessible toolbar with a search box, five filters, three toggles and a create button', () => {
    const toolbar = sb.container.querySelector('.op-toolbar')!;
    expect(toolbar.getAttribute('role')).toBe('toolbar');
    expect(search().placeholder).toBe('Search cards…');
    expect(search().getAttribute('aria-label')).toBe('Search cards…');
    expect(texts(toolbar, '.op-pill > span:first-child')).toEqual(['Assignee', 'Type', 'Priority', 'Label', 'Epic']);
    expect(texts(toolbar, '.op-toggle')).toEqual(['Only mine', 'Epics', 'Old done']);
    expect(text(toolbar.querySelector('.op-btn-primary'))).toBe('Create');
    expect([...toolbar.querySelectorAll('.op-pill')].every((p) => p.getAttribute('aria-haspopup') === 'listbox')).toBe(
      true,
    );
  });

  it('starts with nothing active: no badges, no clear button, toggles off', () => {
    for (const name of PILLS) {
      expect(pill(name).classList.contains('is-active')).toBe(false);
      expect(badge(name).hidden).toBe(true);
    }
    expect(clearSearch().hidden).toBe(true);
    expect(clearAll().hidden).toBe(true);
    for (const label of ['Only mine', 'Epics', 'Old done']) {
      expect(toggle(label).getAttribute('aria-pressed')).toBe('false');
      expect(toggle(label).classList.contains('is-on')).toBe(false);
    }
  });

  it('explains the view toggles in their tooltips', () => {
    expect(toggle('Epics').title).toBe('Show epics as cards on the board');
    expect(toggle('Old done').title).toBe('Show done cards older than the archive limit');
    expect(toggle('Only mine').title).toBe('Only mine'); // no hint: falls back to its label
  });
});

describe('search', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  it('reports the text on every keystroke and shows the clear button', async () => {
    typeInto(search(), 'l');
    typeInto(search(), 'lo');
    expect(sb.states.map((s) => s.text)).toEqual(['l', 'lo']);
    await sb.settle();
    expect(clearSearch().hidden).toBe(false);
    expect(clearAll().hidden).toBe(false);
  });

  it('the clear button empties the box, resets the filter and puts the cursor back in it', async () => {
    typeInto(search(), 'login');
    await sb.settle();
    click(clearSearch());
    await sb.settle();
    expect(search().value).toBe('');
    expect(sb.ui.getState().text).toBe('');
    expect(clearSearch().hidden).toBe(true);
    expect(document.activeElement).toBe(search());
  });

  it('does not overwrite what you are typing, even if the state is rewritten under you', async () => {
    search().focus();
    typeInto(search(), 'abc');
    sb.ui.setState({ text: 'something else' });
    await sb.settle();
    expect(search().value).toBe('abc');
  });

  it('follows the state when the box is not focused (e.g. a restored view)', async () => {
    sb.ui.setState({ text: 'from state' });
    await sb.settle();
    expect(search().value).toBe('from state');
    expect(clearSearch().hidden).toBe(false);
  });
});

describe('assignee filter', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  it('lists the unassigned bucket first, then everyone on the team or the board, sorted', () => {
    click(pill('assignee'));
    expect(rowLabels()).toEqual(['Unassigned', 'Ana', 'Bruno', 'Carla', 'Diego']);
    expect(document.querySelectorAll('.op-pop-item .op-avatar')).toHaveLength(5);
  });

  it('includes people who have cards but are not in the team list', async () => {
    sb.store.apply({ ...sb.store.get('OP-5')!, assignee: 'Zoë' });
    click(pill('assignee'));
    expect(rowLabels()).toContain('Zoë');
    expect(rowLabels().at(-1)).toBe('Zoë');
  });

  it('picking people filters the board and shows how many are selected', async () => {
    click(pill('assignee'));
    await pick('Carla');
    expect(text(badge('assignee'))).toBe('1');
    expect(pill('assignee').classList.contains('is-active')).toBe(true);
    expect(shown().every((k) => sb.store.get(k)!.assignee === 'Carla')).toBe(true);
    await pick('Bruno');
    expect(text(badge('assignee'))).toBe('2');
    expect(shown().every((k) => ['Carla', 'Bruno'].includes(sb.store.get(k)!.assignee!))).toBe(true);
    expect(document.querySelector('.op-pop')).not.toBeNull(); // multi-select stays open
  });

  it('"Unassigned" shows only the cards nobody owns', async () => {
    click(pill('assignee'));
    await pick('Unassigned');
    expect(sb.ui.getState().assignee).toEqual(['@none']);
    expect(shown().every((k) => !sb.store.get(k)!.assignee)).toBe(true);
    expect(shown().length).toBeGreaterThan(0);
  });

  it('deselecting everything clears the badge', async () => {
    click(pill('assignee'));
    await pick('Carla');
    await pick('Carla');
    expect(badge('assignee').hidden).toBe(true);
    expect(pill('assignee').classList.contains('is-active')).toBe(false);
  });

  it('shows the current selection when reopened', async () => {
    click(pill('assignee'));
    await pick('Diego');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); // click away
    click(pill('assignee'));
    expect(
      rows()
        .filter((r) => r.classList.contains('is-on'))
        .map((r) => text(r.querySelector('.op-pop-label'))),
    ).toEqual(['Diego']);
  });

  it('has a search box only for long lists', async () => {
    click(pill('assignee'));
    expect(document.querySelector('.op-pop-search')).toBeNull(); // 4 names + unassigned
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    for (let i = 0; i < 6; i++) sb.store.apply(makeCard(`OP-9${i}`, { assignee: `Person ${i}` }));
    click(pill('assignee'));
    expect(document.querySelector('.op-pop-search')).not.toBeNull();
  });
});

describe('type, priority and label filters', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  it('type: offers the four types with their badges, and filters', async () => {
    click(pill('type'));
    expect(rowLabels()).toEqual(['Task', 'Story', 'Bug', 'Epic']);
    expect(document.querySelectorAll('.op-pop-item .op-type')).toHaveLength(4);
    await pick('Bug');
    expect(text(badge('type'))).toBe('1');
    expect(shown().every((k) => sb.store.get(k)!.type === 'bug')).toBe(true);
    await pick('Task');
    expect(shown().every((k) => ['bug', 'task'].includes(sb.store.get(k)!.type))).toBe(true);
  });

  it('priority: offers the five priorities with their marks, highest first, and filters', async () => {
    click(pill('priority'));
    expect(rowLabels()).toEqual(['Highest', 'High', 'Medium', 'Low', 'Lowest']);
    expect(document.querySelectorAll('.op-pop-item .op-prio')).toHaveLength(5);
    await pick('Highest');
    expect(shown().every((k) => sb.store.get(k)!.priority === 'highest')).toBe(true);
    expect(sb.ui.getState().priority).toEqual(['highest']);
  });

  it('label: lists every label on the board once, sorted, and filters', async () => {
    const all = [...new Set(sb.store.all().flatMap((c) => c.labels))].sort((a, b) => a.localeCompare(b));
    click(pill('labels'));
    expect(rowLabels()).toEqual(all);
    await pick('security');
    expect(shown().every((k) => sb.store.get(k)!.labels.includes('security'))).toBe(true);
    expect(text(badge('labels'))).toBe('1');
  });

  it('label: a long list gets a search box that filters it', () => {
    click(pill('labels'));
    const box = document.querySelector<HTMLInputElement>('.op-pop-search')!;
    expect(box).not.toBeNull();
    typeInto(box, 'secur');
    expect(rowLabels()).toEqual(['security']);
  });

  it('label: shows a dash when no card has labels', async () => {
    sb.dispose();
    sb = await createSandbox({ cards: [makeCard('OP-1'), makeCard('OP-2')] });
    click(pill('labels'));
    expect(rows()).toHaveLength(0);
    expect(text(document.querySelector('.op-pop-empty'))).toBe('—');
  });

  it('keeps several filters at once and counts each dimension', async () => {
    click(pill('type'));
    await pick('Bug');
    click(pill('priority'));
    await pick('High');
    expect(text(badge('type'))).toBe('1');
    expect(text(badge('priority'))).toBe('1');
    expect(shown().every((k) => sb.store.get(k)!.type === 'bug' && sb.store.get(k)!.priority === 'high')).toBe(true);
  });
});

describe('epic filter', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  it('offers "No epic" and every epic by key and title', () => {
    click(pill('parent'));
    expect(rowLabels()).toEqual([
      'No epic',
      'OP-1 · Checkout redesign',
      'OP-2 · Onboarding for new users',
      'OP-3 · Platform reliability',
    ]);
  });

  it('picking an epic shows its cards and closes the popover (single choice)', async () => {
    click(pill('parent'));
    await pick('OP-1 · Checkout redesign');
    expect(document.querySelector('.op-pop')).toBeNull();
    expect(sb.ui.getState().parent).toBe('OP-1');
    expect(shown().every((k) => sb.store.get(k)!.parent === 'OP-1')).toBe(true);
    expect(text(badge('parent'))).toBe('1');
  });

  it('picking the active epic again turns the filter off', async () => {
    click(pill('parent'));
    await pick('OP-1 · Checkout redesign');
    click(pill('parent'));
    expect(
      rows()
        .filter((r) => r.classList.contains('is-on'))
        .map((r) => text(r.querySelector('.op-pop-label'))),
    ).toEqual(['OP-1 · Checkout redesign']);
    await pick('OP-1 · Checkout redesign');
    expect(sb.ui.getState().parent).toBeNull();
    expect(badge('parent').hidden).toBe(true);
  });

  it('"No epic" shows the cards that belong to none', async () => {
    click(pill('parent'));
    await pick('No epic');
    expect(sb.ui.getState().parent).toBe(NO_EPIC);
    expect(shown().every((k) => !sb.store.get(k)!.parent)).toBe(true);
    expect(shown().length).toBeGreaterThan(0);
  });

  it('switching from one epic to another replaces the choice', async () => {
    click(pill('parent'));
    await pick('OP-1 · Checkout redesign');
    click(pill('parent'));
    await pick('OP-2 · Onboarding for new users');
    expect(sb.ui.getState().parent).toBe('OP-2');
  });
});

describe('toggles and clearing', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  it('"Only mine" filters to the configured user and shows as pressed', async () => {
    click(toggle('Only mine'));
    await sb.settle();
    expect(toggle('Only mine').getAttribute('aria-pressed')).toBe('true');
    expect(toggle('Only mine').classList.contains('is-on')).toBe(true);
    expect(shown().every((k) => sb.store.get(k)!.assignee === 'Ana')).toBe(true);
    click(toggle('Only mine'));
    await sb.settle();
    expect(toggle('Only mine').getAttribute('aria-pressed')).toBe('false');
    expect(shown().length).toBeGreaterThan(5);
  });

  it('"Only mine" is hidden when the board does not know who you are', async () => {
    sb.dispose();
    sb = await createSandbox({ config: { ...DEFAULT_CONFIG, me: '' }, cards: [makeCard('OP-1')] });
    expect(toggle('Only mine').hidden).toBe(true);
  });

  it('shows or hides the toggle when "my name" is set later in the settings', async () => {
    sb.config.me = '';
    sb.store.touch();
    await sb.settle();
    expect(toggle('Only mine').hidden).toBe(true);
    sb.config.me = 'Ana';
    sb.store.touch();
    await sb.settle();
    expect(toggle('Only mine').hidden).toBe(false);
  });

  it('"Epics" and "Old done" show the hidden cards and press in', async () => {
    click(toggle('Epics'));
    click(toggle('Old done'));
    await sb.settle();
    expect(shown()).toEqual(expect.arrayContaining(['OP-1', 'OP-20']));
    expect(toggle('Epics').getAttribute('aria-pressed')).toBe('true');
    expect(toggle('Old done').getAttribute('aria-pressed')).toBe('true');
    expect(clearAll().hidden).toBe(true); // view options are not filters
  });

  it('"Clear" appears with any filter and resets them all, keeping the view options', async () => {
    click(toggle('Epics'));
    typeInto(search(), 'login');
    click(toggle('Only mine'));
    click(pill('type'));
    await pick('Bug');
    await sb.settle();
    expect(clearAll().hidden).toBe(false);
    click(clearAll());
    await sb.settle();
    expect(sb.ui.getState()).toMatchObject({
      text: '',
      assignee: [],
      type: [],
      priority: [],
      labels: [],
      parent: null,
      mine: false,
      showEpics: true,
    });
    expect(search().value).toBe('');
    expect(clearAll().hidden).toBe(true);
    expect(badge('type').hidden).toBe(true);
    expect(toggle('Epics').getAttribute('aria-pressed')).toBe('true');
  });

  it('the create button opens the composer in the first column', () => {
    click(sb.container.querySelector('.op-toolbar .op-btn-primary')!);
    expect(sb.column('todo').querySelector('.op-composer')).not.toBeNull();
  });
});

describe('restoring a saved view', () => {
  it('shows the saved filters in the controls', async () => {
    sb = await createSandbox({
      state: { text: 'checkout', type: ['bug', 'story'], labels: ['checkout'], mine: true, showEpics: true },
    });
    expect(search().value).toBe('checkout');
    expect(text(badge('type'))).toBe('2');
    expect(text(badge('labels'))).toBe('1');
    expect(pill('type').classList.contains('is-active')).toBe(true);
    expect(toggle('Only mine').getAttribute('aria-pressed')).toBe('true');
    expect(toggle('Epics').getAttribute('aria-pressed')).toBe('true');
    expect(clearAll().hidden).toBe(false);
  });
});

describe('language', () => {
  it('shows the controls in the interface language', async () => {
    setLanguage('pt');
    sb = await createSandbox();
    expect(search().placeholder).not.toBe('Search cards…');
    expect(text(sb.container.querySelector('.op-pill > span:first-child'))).not.toBe('Assignee');
  });
});

describe('keyboard', () => {
  it('Escape inside the popover closes it without clearing the search', async () => {
    sb = await createSandbox();
    typeInto(search(), 'login');
    await sb.settle();
    click(pill('type'));
    key(rows()[0]!, 'Escape');
    expect(document.querySelector('.op-pop')).toBeNull();
    expect(sb.ui.getState().text).toBe('login');
  });
});
