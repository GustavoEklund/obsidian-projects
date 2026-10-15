// @vitest-environment jsdom
import { parseCard, type Card } from '@oprojects/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionaries, setLanguage } from '../src/i18n';
import { change, click, key, text, texts, typeInto } from './helpers/dom';
import { createSandbox, makeCard, type Sandbox } from './helpers/sandbox';

const BODY = '\n- [ ] one\n- [x] two\n\nA paragraph with `code`.\n';

function cards(): Card[] {
  return [
    makeCard('OP-1', { type: 'epic', title: 'Big epic', status: 'doing', rank: 'A' }),
    makeCard('OP-5', { type: 'epic', title: 'Another epic', status: 'doing', rank: 'B' }),
    makeCard('OP-2', {
      title: 'Fix the thing',
      type: 'bug',
      priority: 'high',
      assignee: 'Ana',
      labels: ['alpha', 'beta'],
      due: '2026-10-20',
      estimate: 3,
      parent: 'OP-1',
      body: BODY,
      checklist: { done: 1, total: 2 },
      rank: 'C',
    }),
    makeCard('OP-3', { title: 'No details', rank: 'D' }),
  ];
}

let sb: Sandbox;

beforeEach(async () => {
  sb = await createSandbox({ cards: cards() });
});
afterEach(() => sb.dispose());

const drawer = () => sb.container.querySelector<HTMLElement>('.op-drawer')!;
const open = async (k: string) => {
  sb.ui.openCard(k);
  await sb.settle();
};
/** The control of the field labelled `label`. */
const field = <T extends HTMLElement>(label: string): T => {
  const row = [...drawer().querySelectorAll('.op-field')].find(
    (r) => text(r.querySelector('.op-field-label')) === label,
  )!;
  return row.querySelector<T>('select, input.op-input, .op-labels-input')!;
};
const title = () => drawer().querySelector<HTMLTextAreaElement>('.op-title-input')!;
const labelInput = () => drawer().querySelector<HTMLInputElement>('.op-label-field')!;
const chips = () => texts(drawer(), '.op-label-edit');
const saved = (k: string) => parseCard(`Cards/${k}.md`, sb.note(k))!;

describe('opening a card', () => {
  it('is hidden until a card is opened', () => {
    expect(drawer().hidden).toBe(true);
    expect(drawer().getAttribute('role')).toBe('complementary');
  });

  it('shows the key with a type badge, and the title', async () => {
    await open('OP-2');
    expect(text(drawer().querySelector('.op-key-btn'))).toBe('OP-2');
    expect(drawer().querySelector('.op-drawer-id .op-type-bug')).not.toBeNull();
    expect(title().value).toBe('Fix the thing');
  });

  it('fills every field from the card', async () => {
    await open('OP-2');
    expect(field<HTMLSelectElement>('Status').value).toBe('todo');
    expect(field<HTMLSelectElement>('Priority').value).toBe('high');
    expect(field<HTMLSelectElement>('Type').value).toBe('bug');
    expect(field<HTMLInputElement>('Assignee').value).toBe('Ana');
    expect(chips()).toEqual(['alpha', 'beta']);
    expect(field<HTMLInputElement>('Due date').value).toBe('2026-10-20');
    expect(field<HTMLInputElement>('Estimate').value).toBe('3');
    expect(field<HTMLSelectElement>('Epic').value).toBe('OP-1');
  });

  it('leaves optional fields empty for a bare card', async () => {
    await open('OP-3');
    expect(field<HTMLInputElement>('Assignee').value).toBe('');
    expect(chips()).toEqual([]);
    expect(field<HTMLInputElement>('Due date').value).toBe('');
    expect(field<HTMLInputElement>('Estimate').value).toBe('');
    expect(field<HTMLSelectElement>('Epic').value).toBe('');
  });

  it('offers every column, type and priority as options', async () => {
    await open('OP-2');
    expect([...field<HTMLSelectElement>('Status').options].map((o) => o.textContent)).toEqual(
      sb.config.columns.map((c) => c.name),
    );
    expect([...field<HTMLSelectElement>('Type').options].map((o) => o.textContent)).toEqual([
      'Task',
      'Story',
      'Bug',
      'Epic',
    ]);
    expect([...field<HTMLSelectElement>('Priority').options].map((o) => o.textContent)).toEqual([
      'Highest',
      'High',
      'Medium',
      'Low',
      'Lowest',
    ]);
  });

  it('offers "None" and the other epics (never the card itself) for the epic field', async () => {
    await open('OP-1');
    expect([...field<HTMLSelectElement>('Epic').options].map((o) => o.textContent)).toEqual([
      'None',
      'OP-5 · Another epic',
    ]);
    await open('OP-2');
    expect([...field<HTMLSelectElement>('Epic').options].map((o) => o.textContent)).toEqual([
      'None',
      'OP-1 · Big epic',
      'OP-5 · Another epic',
    ]);
  });

  it('keeps showing a parent that is not a known epic instead of silently dropping it', async () => {
    sb.store.apply({ ...sb.store.get('OP-3')!, parent: 'OP-77' });
    await open('OP-3');
    expect(field<HTMLSelectElement>('Epic').value).toBe('OP-77');
    expect([...field<HTMLSelectElement>('Epic').options].map((o) => o.value)).toContain('OP-77');
  });

  it('shows a card in an unknown column as being in the first column', async () => {
    sb.store.apply({ ...sb.store.get('OP-3')!, status: 'vanished' });
    await open('OP-3');
    expect(field<HTMLSelectElement>('Status').value).toBe('todo');
  });

  it('suggests team members and known labels in the autocomplete lists', async () => {
    await open('OP-2');
    const members = [...drawer().querySelectorAll('datalist')].find((d) => d.id.startsWith('op-members'))!;
    const labels = [...drawer().querySelectorAll('datalist')].find((d) => d.id.startsWith('op-labels'))!;
    expect([...members.querySelectorAll('option')].map((o) => o.value)).toEqual(['Ana', 'Bruno', 'Carla', 'Diego']);
    expect([...labels.querySelectorAll('option')].map((o) => o.value)).toEqual(['alpha', 'beta']);
    expect(field<HTMLInputElement>('Assignee').getAttribute('list')).toBe(members.id);
  });

  it('shows when the card was created and updated', async () => {
    await open('OP-2');
    expect(text(drawer().querySelector('.op-times'))).toMatch(/^Created .* · updated .*/);
  });

  it('switching cards replaces everything', async () => {
    await open('OP-2');
    await open('OP-3');
    expect(title().value).toBe('No details');
    expect(chips()).toEqual([]);
    expect(text(drawer().querySelector('.op-key-btn'))).toBe('OP-3');
  });
});

describe('editing fields', () => {
  beforeEach(async () => {
    await open('OP-2');
  });

  it('status: moves the card to the bottom of that column', async () => {
    change(field<HTMLSelectElement>('Status'), 'review');
    await sb.settle();
    expect(sb.store.get('OP-2')!.status).toBe('review');
    expect(saved('OP-2').status).toBe('review');
    expect(sb.keys('review')).toEqual(['OP-2']);
  });

  it('type and priority: save immediately', async () => {
    change(field<HTMLSelectElement>('Type'), 'story');
    change(field<HTMLSelectElement>('Priority'), 'lowest');
    await sb.settle();
    expect(saved('OP-2')).toMatchObject({ type: 'story', priority: 'lowest' });
  });

  it('due date: sets and clears', async () => {
    change(field<HTMLInputElement>('Due date'), '2026-12-01');
    await sb.settle();
    expect(saved('OP-2').due).toBe('2026-12-01');
    change(field<HTMLInputElement>('Due date'), '');
    await sb.settle();
    expect(saved('OP-2').due).toBeUndefined();
  });

  it('estimate: sets (decimals too) and clears', async () => {
    change(field<HTMLInputElement>('Estimate'), '0.5');
    await sb.settle();
    expect(saved('OP-2').estimate).toBe(0.5);
    change(field<HTMLInputElement>('Estimate'), '0');
    await sb.settle();
    expect(saved('OP-2').estimate).toBe(0);
    change(field<HTMLInputElement>('Estimate'), '');
    await sb.settle();
    expect(saved('OP-2').estimate).toBeUndefined();
  });

  it('epic: sets and clears the parent', async () => {
    change(field<HTMLSelectElement>('Epic'), 'OP-5');
    await sb.settle();
    expect(saved('OP-2').parent).toBe('OP-5');
    change(field<HTMLSelectElement>('Epic'), '');
    await sb.settle();
    expect(saved('OP-2').parent).toBeUndefined();
  });

  it('assignee: trims, and clears when emptied', async () => {
    change(field<HTMLInputElement>('Assignee'), '  Bruno ');
    await sb.settle();
    expect(saved('OP-2').assignee).toBe('Bruno');
    change(field<HTMLInputElement>('Assignee'), '   ');
    await sb.settle();
    expect(saved('OP-2').assignee).toBeUndefined();
  });

  it('shows the saved values back on the board card', async () => {
    change(field<HTMLSelectElement>('Priority'), 'highest');
    await sb.settle();
    expect(sb.card('OP-2')!.querySelector('.op-prio')!.classList.contains('op-prio-highest')).toBe(true);
  });

  it('reports a failed save, and puts the controls back to what the card really is', async () => {
    vi.spyOn(sb.storage, 'modify').mockRejectedValueOnce(new Error('disk full'));
    change(field<HTMLSelectElement>('Priority'), 'lowest');
    await sb.settle();
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: disk full');
    expect(field<HTMLSelectElement>('Priority').value).toBe('high');
    expect(saved('OP-2').priority).toBe('high');
  });

  it('reports a failed column change too', async () => {
    vi.spyOn(sb.storage, 'modify').mockRejectedValueOnce(new Error('locked'));
    change(field<HTMLSelectElement>('Status'), 'done');
    await sb.settle();
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: locked');
    expect(sb.store.get('OP-2')!.status).toBe('todo');
  });
});

describe('title', () => {
  beforeEach(async () => {
    await open('OP-2');
    title().focus();
  });

  it('saves on Enter, collapsing whitespace', async () => {
    typeInto(title(), '  A   new\ttitle ');
    const event = key(title(), 'Enter');
    expect(event.defaultPrevented).toBe(true);
    await sb.settle();
    expect(saved('OP-2').title).toBe('A new title');
  });

  it('saves when it loses focus', async () => {
    typeInto(title(), 'Renamed');
    title().blur();
    await sb.settle();
    expect(saved('OP-2').title).toBe('Renamed');
  });

  it('Shift+Enter is a newline, not a save', () => {
    typeInto(title(), 'Two\nlines');
    const event = key(title(), 'Enter', { shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(saved('OP-2').title).toBe('Fix the thing');
  });

  it('Escape puts the old title back and leaves the box without saving', async () => {
    typeInto(title(), 'Oops, wrong box');
    const outer = vi.fn();
    sb.container.addEventListener('keydown', outer);
    key(title(), 'Escape');
    await sb.settle();
    expect(title().value).toBe('Fix the thing');
    expect(saved('OP-2').title).toBe('Fix the thing');
    expect(outer).not.toHaveBeenCalled(); // does not also close the panel
    expect(drawer().hidden).toBe(false);
  });

  it('an emptied title is restored instead of saved', async () => {
    typeInto(title(), '   ');
    title().blur();
    await sb.settle();
    expect(title().value).toBe('Fix the thing');
    expect(saved('OP-2').title).toBe('Fix the thing');
  });

  it('an unchanged title writes nothing', async () => {
    const before = new Map(sb.storage.files);
    title().blur();
    await sb.settle();
    expect(sb.storage.files).toEqual(before);
  });

  it('grows with its content', () => {
    Object.defineProperty(title(), 'scrollHeight', { value: 72, configurable: true });
    typeInto(title(), 'a very long title that wraps');
    expect(title().style.height).toBe('72px');
  });
});

describe('labels', () => {
  beforeEach(async () => {
    await open('OP-2');
    labelInput().focus();
  });

  it('Enter adds the typed label', async () => {
    typeInto(labelInput(), 'gamma');
    const event = key(labelInput(), 'Enter');
    expect(event.defaultPrevented).toBe(true);
    await sb.settle();
    expect(saved('OP-2').labels).toEqual(['alpha', 'beta', 'gamma']);
    expect(chips()).toEqual(['alpha', 'beta', 'gamma']);
    expect(labelInput().value).toBe('');
  });

  it('a comma adds several at once, tidied up (no #, no duplicates, spaces become dashes)', async () => {
    typeInto(labelInput(), '#delta, two words, alpha');
    key(labelInput(), ',');
    await sb.settle();
    expect(saved('OP-2').labels).toEqual(['alpha', 'beta', 'delta', 'two-words']);
  });

  it('blurring the box adds what is pending', async () => {
    typeInto(labelInput(), 'pending');
    labelInput().blur();
    await sb.settle();
    expect(saved('OP-2').labels).toContain('pending');
  });

  it('adding nothing writes nothing', async () => {
    const before = new Map(sb.storage.files);
    key(labelInput(), 'Enter');
    typeInto(labelInput(), '   ');
    key(labelInput(), 'Enter');
    await sb.settle();
    expect(sb.storage.files).toEqual(before);
  });

  it('Backspace on an empty box removes the last label', async () => {
    key(labelInput(), 'Backspace');
    await sb.settle();
    expect(saved('OP-2').labels).toEqual(['alpha']);
  });

  it('Backspace with text in the box edits the text, not the labels', async () => {
    typeInto(labelInput(), 'x');
    key(labelInput(), 'Backspace');
    await sb.settle();
    expect(saved('OP-2').labels).toEqual(['alpha', 'beta']);
  });

  it('Backspace with no labels does nothing', async () => {
    await open('OP-3');
    const before = new Map(sb.storage.files);
    key(labelInput(), 'Backspace');
    await sb.settle();
    expect(sb.storage.files).toEqual(before);
  });

  it('the x on a chip removes that label', async () => {
    click(drawer().querySelectorAll<HTMLElement>('.op-label-x')[0]!);
    await sb.settle();
    expect(saved('OP-2').labels).toEqual(['beta']);
    expect(drawer().querySelector('.op-label-x')!.getAttribute('aria-label')).toBe('Remove label: beta');
  });

  it('clicking the empty part of the labels box focuses the input', () => {
    drawer()
      .querySelector<HTMLInputElement>('.op-labels-input')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.activeElement).toBe(labelInput());
  });
});

describe('header actions', () => {
  beforeEach(async () => {
    await open('OP-2');
  });

  const buttonFor = (label: string) =>
    drawer().querySelector<HTMLButtonElement>(`.op-drawer-head button[aria-label="${label}"]`)!;

  it('clicking the key copies it and says so', () => {
    click(drawer().querySelector('.op-key-btn')!);
    expect(sb.platform.copy).toHaveBeenCalledWith('OP-2');
    expect(sb.platform.notify).toHaveBeenCalledWith('Copied OP-2');
  });

  it('"Open note" opens the note, in a new tab with ctrl or cmd', () => {
    click(buttonFor('Open note'));
    click(buttonFor('Open note'), { ctrlKey: true });
    click(buttonFor('Open note'), { metaKey: true });
    expect(sb.platform.openNote.mock.calls.map((c) => c[1])).toEqual([
      { newTab: false },
      { newTab: true },
      { newTab: true },
    ]);
    expect(sb.platform.openNote.mock.calls[0]![0].key).toBe('OP-2');
  });

  it('"Close" closes the panel', async () => {
    click(buttonFor('Close'));
    await sb.settle();
    expect(drawer().hidden).toBe(true);
    expect(sb.container.querySelector('.op-root')!.classList.contains('op-drawer-open')).toBe(false);
  });

  it('"Delete" asks first, and closes the panel once the card is gone', async () => {
    click(buttonFor('Delete'));
    await sb.settle();
    expect(sb.platform.confirm).toHaveBeenCalledWith('Delete OP-2? The note will be moved to the trash.', 'Delete');
    expect(sb.store.get('OP-2')).toBeUndefined();
    expect(drawer().hidden).toBe(true);
  });

  it('"Delete" declined keeps the card and the panel', async () => {
    sb.platform.confirmAnswer = false;
    click(buttonFor('Delete'));
    await sb.settle();
    expect(sb.store.get('OP-2')).toBeDefined();
    expect(drawer().hidden).toBe(false);
  });

  it('a failed delete is reported and keeps everything', async () => {
    vi.spyOn(sb.storage, 'remove').mockRejectedValueOnce(new Error('read-only'));
    click(buttonFor('Delete'));
    await sb.settle();
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: read-only');
    expect(sb.store.get('OP-2')).toBeDefined();
    expect(drawer().hidden).toBe(false);
  });
});

describe('staying in sync', () => {
  beforeEach(async () => {
    await open('OP-2');
  });

  it('follows changes made elsewhere (the CLI, a sync, another pane)', async () => {
    sb.store.apply({
      ...sb.store.get('OP-2')!,
      priority: 'lowest',
      assignee: 'Carla',
      labels: ['gamma'],
      title: 'Renamed elsewhere',
    });
    await sb.settle();
    expect(field<HTMLSelectElement>('Priority').value).toBe('lowest');
    expect(field<HTMLInputElement>('Assignee').value).toBe('Carla');
    expect(chips()).toEqual(['gamma']);
    expect(title().value).toBe('Renamed elsewhere');
  });

  it('never overwrites the field you are typing in', async () => {
    title().focus();
    typeInto(title(), 'Half-typed sent');
    sb.store.apply({ ...sb.store.get('OP-2')!, title: 'Changed elsewhere', priority: 'lowest' });
    await sb.settle();
    expect(title().value).toBe('Half-typed sent');
    expect(field<HTMLSelectElement>('Priority').value).toBe('lowest'); // other fields still update
  });

  it('closes by itself when the open card is deleted elsewhere', async () => {
    sb.store.remove('OP-2');
    await sb.settle();
    expect(drawer().hidden).toBe(true);
  });

  it('does not rebuild the option lists on every update (an open select would lose its place)', async () => {
    const options = field<HTMLSelectElement>('Status').firstElementChild;
    sb.store.apply({ ...sb.store.get('OP-2')!, title: 'x' });
    await sb.settle();
    expect(field<HTMLSelectElement>('Status').firstElementChild).toBe(options);
  });

  it('rebuilds the option lists when the columns or the epics change', async () => {
    sb.config.columns = [...sb.config.columns, { id: 'extra', name: 'Extra' }];
    sb.store.touch();
    await sb.settle();
    expect([...field<HTMLSelectElement>('Status').options].map((o) => o.textContent)).toContain('Extra');
    sb.store.apply(makeCard('OP-9', { type: 'epic', title: 'Fresh epic' }));
    await sb.settle();
    expect([...field<HTMLSelectElement>('Epic').options].map((o) => o.textContent)).toContain('OP-9 · Fresh epic');
  });
});

describe('language', () => {
  it('labels the panel in the interface language', async () => {
    sb.dispose();
    setLanguage('pt');
    sb = await createSandbox({ cards: cards() });
    await open('OP-2');
    const english = dictionaries.en!;
    expect(title().placeholder).not.toBe(english['field.title']);
    expect(texts(drawer(), '.op-field-label')).not.toContain(english['field.priority']);
    expect(text(drawer().querySelector('.op-section-title'))).not.toBe(english['field.description']);
  });
});
