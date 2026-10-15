// @vitest-environment jsdom
import { DEFAULT_CONFIG } from '@oprojects/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { change, click, contextMenu, dblclick, key, text, texts, typeInto } from './helpers/dom';
import { createSandbox, makeCard, type Sandbox } from './helpers/sandbox';

let sb: Sandbox;
afterEach(() => sb.dispose());

const labels = (sandbox: Sandbox) => sandbox.platform.lastMenu().map((e) => (e.separator ? '—' : e.label));

describe('opening cards', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  it('a click opens the details panel and marks the card selected', async () => {
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(true);
    click(sb.card('OP-5')!.querySelector('.op-card-title')!); // a click on any part of the card counts
    await sb.settle();
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(false);
    expect(sb.card('OP-5')!.classList.contains('op-selected')).toBe(true);
    expect(sb.container.querySelector('.op-root')!.classList.contains('op-drawer-open')).toBe(true);
    expect(sb.container.querySelector<HTMLTextAreaElement>('.op-title-input')!.value).toBe(sb.store.get('OP-5')!.title);
  });

  it('selecting another card moves the selection', async () => {
    click(sb.card('OP-5')!);
    click(sb.card('OP-6')!);
    await sb.settle();
    expect(sb.card('OP-5')!.classList.contains('op-selected')).toBe(false);
    expect(sb.card('OP-6')!.classList.contains('op-selected')).toBe(true);
    expect(sb.container.querySelectorAll('.op-selected')).toHaveLength(1);
  });

  it('ctrl/cmd-click opens the note in a new tab instead of the panel', () => {
    click(sb.card('OP-5')!, { ctrlKey: true });
    click(sb.card('OP-6')!, { metaKey: true });
    expect(sb.platform.openNote).toHaveBeenCalledTimes(2);
    expect(sb.platform.openNote).toHaveBeenNthCalledWith(1, sb.store.get('OP-5'), { newTab: true });
    expect(sb.platform.openNote).toHaveBeenNthCalledWith(2, sb.store.get('OP-6'), { newTab: true });
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(true);
  });

  it('a double click opens the note', () => {
    dblclick(sb.card('OP-5')!);
    expect(sb.platform.openNote).toHaveBeenCalledWith(sb.store.get('OP-5'), undefined);
  });

  it('clicks outside any card do nothing', () => {
    click(sb.column('todo').querySelector('.op-col-head')!);
    dblclick(sb.column('todo').querySelector('.op-col-head')!);
    expect(sb.platform.openNote).not.toHaveBeenCalled();
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(true);
  });

  it('openCard() ignores keys that are not on the board', () => {
    sb.ui.openCard('OP-999');
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(true);
  });

  it('closing the panel clears the selection and returns focus to the card', async () => {
    sb.ui.openCard('OP-5');
    await sb.settle();
    key(sb.container.querySelector('.op-root')!, 'Escape');
    await sb.settle();
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(true);
    expect(sb.card('OP-5')!.classList.contains('op-selected')).toBe(false);
    expect(document.activeElement).toBe(sb.card('OP-5'));
  });

  it('closes the panel by itself when the open card is deleted', async () => {
    sb.ui.openCard('OP-5');
    await sb.settle();
    await sb.host.remove('OP-5');
    await sb.settle();
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(true);
    expect(sb.container.querySelectorAll('.op-selected')).toHaveLength(0);
  });
});

describe('context menu', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  it('opens at the pointer and swallows the browser menu', () => {
    const event = contextMenu(sb.card('OP-5')!, 33, 44);
    expect(event.defaultPrevented).toBe(true);
    expect(sb.platform.menu).toHaveBeenCalledTimes(1);
    const [at] = sb.platform.menu.mock.calls[0]!;
    expect((at as MouseEvent).clientX).toBe(33);
    expect((at as MouseEvent).clientY).toBe(44);
  });

  it('leaves the browser menu alone away from cards', () => {
    const event = contextMenu(sb.column('todo').querySelector('.op-col-head')!);
    expect(event.defaultPrevented).toBe(false);
    expect(sb.platform.menu).not.toHaveBeenCalled();
  });

  it('lists open, move to each column, priorities, assignee, copy and delete', () => {
    contextMenu(sb.card('OP-5')!); // unassigned? no: assigned to Carla
    expect(labels(sb)).toEqual([
      'Open details',
      'Open note',
      'Open note in new tab',
      '—',
      'Move to To do',
      'Move to In progress',
      'Move to In review',
      'Move to Done',
      '—',
      'Priority: Highest',
      'Priority: High',
      'Priority: Medium',
      'Priority: Low',
      'Priority: Lowest',
      '—',
      'Assign to me',
      'Unassign',
      'Copy key',
      'Copy link',
      '—',
      'Delete',
    ]);
  });

  it('checks the current column and the current priority', () => {
    contextMenu(sb.card('OP-5')!);
    const checked = sb.platform
      .lastMenu()
      .filter((e) => e.checked)
      .map((e) => e.label);
    expect(checked).toEqual(['Move to To do', 'Priority: High']);
  });

  it('flags delete as dangerous', () => {
    contextMenu(sb.card('OP-5')!);
    expect(sb.platform.lastMenu().find((e) => e.label === 'Delete')!.danger).toBe(true);
  });

  it('offers "Assign to me" only to cards not already mine, and "Unassign" only to assigned cards', () => {
    contextMenu(sb.card('OP-6')!); // Diego's
    expect(labels(sb)).toEqual(expect.arrayContaining(['Assign to me', 'Unassign']));
    contextMenu(sb.card('OP-8')!); // already Ana's
    expect(labels(sb)).not.toContain('Assign to me');
    expect(labels(sb)).toContain('Unassign');
    contextMenu(sb.card('OP-22')!); // nobody's
    expect(labels(sb)).toContain('Assign to me');
    expect(labels(sb)).not.toContain('Unassign');
  });

  it('does not offer "Assign to me" when the board has no configured user', async () => {
    sb.dispose();
    sb = await createSandbox({
      config: { ...DEFAULT_CONFIG, columns: DEFAULT_CONFIG.columns },
      cards: [makeCard('OP-1', { assignee: 'Zed' }), makeCard('OP-2')],
    });
    contextMenu(sb.card('OP-2')!);
    expect(labels(sb)).not.toContain('Assign to me');
  });

  it('"Open details", "Open note" and "Open note in new tab" do what they say', async () => {
    contextMenu(sb.card('OP-5')!);
    sb.platform.pick('Open note');
    sb.platform.pick('Open note in new tab');
    expect(sb.platform.openNote).toHaveBeenNthCalledWith(1, sb.store.get('OP-5'), undefined);
    expect(sb.platform.openNote).toHaveBeenNthCalledWith(2, sb.store.get('OP-5'), { newTab: true });
    sb.platform.pick('Open details');
    await sb.settle();
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(false);
  });

  it('"Move to" changes the column and writes only that note; the current column is a no-op', async () => {
    contextMenu(sb.card('OP-5')!);
    const before = new Map(sb.storage.files);
    sb.platform.pick('Move to To do'); // already there
    await sb.settle();
    expect(sb.storage.files).toEqual(before);
    sb.platform.pick('Move to In review');
    await sb.settle();
    expect(sb.store.get('OP-5')!.status).toBe('review');
    expect(sb.note('OP-5')).toContain('status: review');
    expect(sb.keys('review')).toContain('OP-5');
    expect(document.activeElement).toBe(sb.card('OP-5')); // focus follows the card
  });

  it('"Priority" sets it', async () => {
    contextMenu(sb.card('OP-5')!);
    sb.platform.pick('Priority: Lowest');
    await sb.settle();
    expect(sb.store.get('OP-5')!.priority).toBe('lowest');
    expect(sb.note('OP-5')).toContain('priority: lowest');
  });

  it('"Assign to me" and "Unassign" write the assignee', async () => {
    contextMenu(sb.card('OP-6')!);
    sb.platform.pick('Assign to me');
    await sb.settle();
    expect(sb.store.get('OP-6')!.assignee).toBe('Ana');
    contextMenu(sb.card('OP-6')!);
    sb.platform.pick('Unassign');
    await sb.settle();
    expect(sb.store.get('OP-6')!.assignee).toBeUndefined();
    expect(sb.note('OP-6')).not.toContain('assignee:');
  });

  it('copies the key and a wiki link, and says so', () => {
    contextMenu(sb.card('OP-5')!);
    sb.platform.pick('Copy key');
    sb.platform.pick('Copy link');
    expect(sb.platform.copy).toHaveBeenNthCalledWith(1, 'OP-5');
    expect(sb.platform.copy).toHaveBeenNthCalledWith(2, '[[OP-5]]');
    expect(sb.platform.notify).toHaveBeenNthCalledWith(1, 'Copied OP-5');
    expect(sb.platform.notify).toHaveBeenNthCalledWith(2, 'Copied [[OP-5]]');
  });

  it('delete asks first, and does nothing when declined', async () => {
    sb.platform.confirmAnswer = false;
    contextMenu(sb.card('OP-5')!);
    sb.platform.pick('Delete');
    await sb.settle();
    expect(sb.platform.confirm).toHaveBeenCalledWith('Delete OP-5? The note will be moved to the trash.', 'Delete');
    expect(sb.store.get('OP-5')).toBeDefined();
    expect(sb.storage.files.has('Cards/OP-5.md')).toBe(true);
  });

  it('delete removes the card and its note once confirmed', async () => {
    contextMenu(sb.card('OP-5')!);
    sb.platform.pick('Delete');
    await sb.settle();
    expect(sb.store.get('OP-5')).toBeUndefined();
    expect(sb.storage.files.has('Cards/OP-5.md')).toBe(false);
    expect(sb.card('OP-5')).toBeNull();
  });

  it('reports a failed delete and keeps the card', async () => {
    vi.spyOn(sb.storage, 'remove').mockRejectedValue(new Error('read-only vault'));
    contextMenu(sb.card('OP-5')!);
    sb.platform.pick('Delete');
    await sb.settle();
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: read-only vault');
    expect(sb.store.get('OP-5')).toBeDefined();
  });

  it('reports a failed menu action', async () => {
    vi.spyOn(sb.storage, 'modify').mockRejectedValue(new Error('disk full'));
    contextMenu(sb.card('OP-5')!);
    sb.platform.pick('Priority: Lowest');
    await sb.settle();
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: disk full');
    expect(sb.store.get('OP-5')!.priority).toBe('high'); // rolled back
    expect(sb.card('OP-5')!.querySelector('.op-prio')!.classList.contains('op-prio-high')).toBe(true); // ...and on screen
  });
});

describe('keyboard on a card', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  it('Enter and Space open the panel', async () => {
    const enter = key(sb.card('OP-5')!, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    await sb.settle();
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(false);
    sb.ui.openCard('OP-6');
    const space = key(sb.card('OP-4')!, ' ');
    expect(space.defaultPrevented).toBe(true);
    await sb.settle();
    expect(sb.container.querySelector<HTMLTextAreaElement>('.op-title-input')!.value).toBe(sb.store.get('OP-4')!.title);
  });

  it('Alt+Right and Alt+Left move the card to the next / previous column, and focus follows', async () => {
    const first = sb.keys('todo')[0]!;
    const event = key(sb.card(first)!, 'ArrowRight', { altKey: true });
    expect(event.defaultPrevented).toBe(true);
    await sb.settle();
    expect(sb.store.get(first)!.status).toBe('doing');
    expect(document.activeElement).toBe(sb.card(first));
    key(sb.card(first)!, 'ArrowLeft', { altKey: true });
    await sb.settle();
    expect(sb.store.get(first)!.status).toBe('todo');
  });

  it('Alt+Left in the first column and Alt+Right in the last move nothing', async () => {
    const before = new Map(sb.storage.files);
    key(sb.card(sb.keys('todo')[0]!)!, 'ArrowLeft', { altKey: true });
    key(sb.card(sb.keys('done')[0]!)!, 'ArrowRight', { altKey: true });
    await sb.settle();
    expect(sb.storage.files).toEqual(before);
  });

  it('Alt+Up and Alt+Down reorder inside the column', async () => {
    const [a, b, c] = sb.keys('todo');
    key(sb.card(c!)!, 'ArrowUp', { altKey: true });
    await sb.settle();
    expect(sb.keys('todo').slice(0, 3)).toEqual([a, c, b]);
    key(sb.card(a!)!, 'ArrowDown', { altKey: true });
    await sb.settle();
    expect(sb.keys('todo').slice(0, 3)).toEqual([c, a, b]);
  });

  it('Alt+Up on the top card and Alt+Down on the bottom card do nothing (and are not swallowed)', async () => {
    const todo = sb.keys('todo');
    const up = key(sb.card(todo[0]!)!, 'ArrowUp', { altKey: true });
    const down = key(sb.card(todo.at(-1)!)!, 'ArrowDown', { altKey: true });
    expect(up.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);
    await sb.settle();
    expect(sb.keys('todo')).toEqual(todo);
  });

  it('plain arrows and other keys do nothing', async () => {
    const before = new Map(sb.storage.files);
    for (const k of ['ArrowRight', 'ArrowDown', 'x', 'Tab'])
      expect(key(sb.card('OP-5')!, k).defaultPrevented).toBe(false);
    await sb.settle();
    expect(sb.storage.files).toEqual(before);
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(true);
  });

  it('keys pressed elsewhere on the board are not card shortcuts', () => {
    const event = key(sb.column('todo').querySelector('.op-col-head')!, 'Enter');
    expect(event.defaultPrevented).toBe(false);
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(true);
  });

  it('reports a failed keyboard move', async () => {
    vi.spyOn(sb.storage, 'modify').mockRejectedValue(new Error('locked'));
    key(sb.card(sb.keys('todo')[0]!)!, 'ArrowRight', { altKey: true });
    await sb.settle();
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: locked');
  });
});

describe('global shortcuts', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });
  const root = () => sb.container.querySelector<HTMLElement>('.op-root')!;
  const search = () => sb.container.querySelector<HTMLInputElement>('.op-search-input')!;

  it('"/" focuses and selects the search box', () => {
    search().value = 'previous';
    const event = key(root(), '/');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search());
  });

  it('"c" opens the composer in the first column', () => {
    const event = key(root(), 'c');
    expect(event.defaultPrevented).toBe(true);
    expect(sb.column('todo').querySelector('.op-composer')).not.toBeNull();
    expect(document.activeElement).toBe(sb.column('todo').querySelector('.op-composer-input'));
  });

  it('does not steal "/" or "c" while you are typing in a field', () => {
    search().focus();
    expect(key(search(), 'c').defaultPrevented).toBe(false);
    expect(key(search(), '/').defaultPrevented).toBe(false);
    expect(sb.container.querySelector('.op-composer')).toBeNull();
  });

  it('ignores shortcuts combined with ctrl, cmd or alt', () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(key(root(), 'c', init).defaultPrevented).toBe(false);
      expect(key(root(), '/', init).defaultPrevented).toBe(false);
    }
    expect(sb.container.querySelector('.op-composer')).toBeNull();
  });

  it('Escape clears a non-empty search box', async () => {
    typeInto(search(), 'login');
    await sb.settle();
    expect(sb.ui.getState().text).toBe('login');
    key(search(), 'Escape');
    await sb.settle();
    expect(search().value).toBe('');
    expect(sb.ui.getState().text).toBe('');
  });

  it('Escape in an empty search box does nothing', () => {
    const before = sb.states.length;
    key(search(), 'Escape');
    expect(sb.states.length).toBe(before);
  });

  it('Escape closes the panel, but not while you are typing in it', async () => {
    sb.ui.openCard('OP-5');
    await sb.settle();
    const title = sb.container.querySelector<HTMLTextAreaElement>('.op-title-input')!;
    title.focus();
    key(title, 'Escape'); // reverts and blurs the title; the panel stays
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(false);
    key(root(), 'Escape');
    await sb.settle();
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(true);
  });
});

describe('creating cards from the board', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });
  const composerIn = (col: string) => sb.column(col).querySelector<HTMLElement>('.op-composer');
  const input = (col: string) => sb.column(col).querySelector<HTMLTextAreaElement>('.op-composer-input')!;
  const enter = (col: string) => key(input(col), 'Enter');

  it('the "Create" button of a column opens the composer there and hides itself', () => {
    click(sb.column('doing').querySelector('.op-add')!);
    expect(composerIn('doing')).not.toBeNull();
    expect(sb.column('doing').querySelector<HTMLElement>('.op-add')!.hidden).toBe(true);
    expect(document.activeElement).toBe(input('doing'));
  });

  it('the toolbar button opens the composer in the first column', () => {
    click(sb.container.querySelector('.op-toolbar .op-btn-primary')!);
    expect(composerIn('todo')).not.toBeNull();
  });

  it('only one composer is open at a time', () => {
    sb.ui.openComposer('review');
    sb.ui.openComposer('doing');
    expect(composerIn('review')).toBeNull();
    expect(composerIn('doing')).not.toBeNull();
    expect(sb.column('review').querySelector<HTMLElement>('.op-add')!.hidden).toBe(false);
  });

  it('an unknown column falls back to the first one', () => {
    sb.ui.openComposer('nope');
    expect(composerIn('todo')).not.toBeNull();
  });

  it('opening the same composer twice keeps one form', () => {
    sb.ui.openComposer('doing');
    sb.ui.openComposer('doing');
    expect(sb.column('doing').querySelectorAll('.op-composer')).toHaveLength(1);
  });

  it('Enter creates the card at the bottom of that column and keeps the form open for the next one', async () => {
    sb.ui.openComposer('doing');
    typeInto(input('doing'), 'Write the docs');
    enter('doing');
    await sb.settle();
    expect(sb.keys('doing').at(-1)).toBe('OP-25');
    expect(sb.store.get('OP-25')).toMatchObject({ title: 'Write the docs', status: 'doing', type: 'task' });
    expect(sb.storage.files.has('Cards/OP-25.md')).toBe(true);
    expect(composerIn('doing')).not.toBeNull();
    expect(input('doing').value).toBe('');
    expect(document.activeElement).toBe(input('doing'));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled(); // the new card is brought into view
  });

  it('the first line is the title and the rest the description', async () => {
    sb.ui.openComposer('todo');
    typeInto(input('todo'), 'Title line\nsecond line\n\n- [ ] third');
    enter('todo');
    await sb.settle();
    const card = sb.store.get('OP-25')!;
    expect(card.title).toBe('Title line');
    expect(card.body.trim()).toBe('second line\n\n- [ ] third');
    expect(card.checklist.total).toBe(1);
  });

  it('remembers the chosen type for the next composer', async () => {
    sb.ui.openComposer('todo');
    const select = sb.column('todo').querySelector<HTMLSelectElement>('.op-composer-type')!;
    change(select, 'bug');
    typeInto(input('todo'), 'A bug');
    enter('todo');
    await sb.settle();
    expect(sb.store.get('OP-25')!.type).toBe('bug');
    sb.ui.openComposer('review');
    expect(sb.column('review').querySelector<HTMLSelectElement>('.op-composer-type')!.value).toBe('bug');
  });

  it('Escape closes the form and brings the "Create" button back', () => {
    sb.ui.openComposer('doing');
    key(input('doing'), 'Escape');
    expect(composerIn('doing')).toBeNull();
    expect(sb.column('doing').querySelector<HTMLElement>('.op-add')!.hidden).toBe(false);
  });

  it('an empty title creates nothing', async () => {
    sb.ui.openComposer('todo');
    typeInto(input('todo'), '   \nbody only');
    enter('todo');
    await sb.settle();
    expect(sb.store.get('OP-25')).toBeUndefined();
  });

  it('a failed creation is reported, keeps what you typed, and leaves the form usable', async () => {
    const create = vi.spyOn(sb.storage, 'create').mockRejectedValueOnce(new Error('quota exceeded'));
    sb.ui.openComposer('todo');
    typeInto(input('todo'), 'Precious text');
    enter('todo');
    await sb.settle();
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: quota exceeded');
    expect(input('todo').value).toBe('Precious text');
    enter('todo'); // try again: the mock now lets it through
    await sb.settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(sb.store.get('OP-25')!.title).toBe('Precious text');
    expect(input('todo').value).toBe('');
  });
});

describe('destroy()', () => {
  beforeEach(async () => {
    sb = await createSandbox();
  });

  it('removes the board and stops listening to the store', async () => {
    const el = sb.ui.el;
    const cards = vi.spyOn(sb.host, 'cards');
    sb.ui.destroy();
    expect(el.isConnected).toBe(false);
    cards.mockClear();
    sb.store.touch();
    await sb.settle();
    expect(cards).not.toHaveBeenCalled();
  });

  it('closes an open popover and cancels a pending render', async () => {
    click(sb.container.querySelector('.op-pill')!);
    expect(document.querySelector('.op-pop')).not.toBeNull();
    sb.store.touch(); // a render is now scheduled
    sb.ui.destroy();
    expect(document.querySelector('.op-pop')).toBeNull();
    await sb.settle();
    expect(texts(sb.container, '.op-card-title')).toEqual([]);
  });

  it('can be mounted again afterwards with the saved state', async () => {
    sb.ui.setState({ text: 'checkout' });
    const saved = sb.ui.getState();
    sb.mount(saved);
    await sb.settle();
    expect(sb.ui.getState().text).toBe('checkout');
    expect(text(sb.container.querySelector('.op-col-name'))).toBe('To do');
    expect(sb.container.querySelectorAll('.op-root')).toHaveLength(1);
  });
});
