// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawer } from '../src/ui/drawer';
import { closeActivePopover, openPopover } from '../src/ui/popover';
import { CommentsPanel } from '../src/ui/comments';
import { change, click, drag, installDomStubs, key, rect, text } from './helpers/dom';
import { createSandbox, makeCard, type Sandbox } from './helpers/sandbox';

installDomStubs();

let sb: Sandbox;
afterEach(() => {
  closeActivePopover();
  sb?.dispose();
});

const drawerEl = () => sb.container.querySelector<HTMLElement>('.op-drawer')!;

describe('a Drawer used on its own (no board around it)', () => {
  it('works without being given sizing hooks, and without a parent element to measure', async () => {
    sb = await createSandbox({ cards: [makeCard('OP-1')], mount: false });
    const onClose = vi.fn();
    const drawer = new Drawer(sb.host, onClose); // default sizing; never attached to the document
    drawer.open(sb.store.get('OP-1')!);
    expect(drawer.isOpen()).toBe(true);
    expect(drawer.openKey).toBe('OP-1');
    const handle = drawer.el.querySelector<HTMLElement>('.op-drawer-resizer')!;
    vi.spyOn(drawer.el, 'getBoundingClientRect').mockReturnValue(rect({ width: 420, height: 600 }));
    key(handle, 'ArrowLeft'); // nothing to measure the pane with: the minimum wins
    expect(drawer.el.style.getPropertyValue('--op-drawer-w')).toBe('300px');
    key(handle, 'Home');
    expect(drawer.el.style.getPropertyValue('--op-drawer-w')).toBe('');
    drawer.destroy();
  });

  it('refresh() on a closed drawer does nothing', async () => {
    sb = await createSandbox({ cards: [makeCard('OP-1')], mount: false });
    const drawer = new Drawer(sb.host, vi.fn());
    expect(() => drawer.refresh()).not.toThrow();
    expect(drawer.isOpen()).toBe(false);
    expect(drawer.openKey).toBeNull();
  });

  it('calls onClose when the card it shows disappears', async () => {
    sb = await createSandbox({ cards: [makeCard('OP-1')], mount: false });
    const onClose = vi.fn();
    const drawer = new Drawer(sb.host, onClose);
    drawer.open(sb.store.get('OP-1')!);
    sb.store.remove('OP-1');
    drawer.refresh();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(drawer.isOpen()).toBe(false);
  });

  it('gives every panel its own autocomplete list ids', async () => {
    sb = await createSandbox({ cards: [makeCard('OP-1')], mount: false });
    const a = new Drawer(sb.host, vi.fn());
    const b = new Drawer(sb.host, vi.fn());
    const ids = (d: Drawer) => [...d.el.querySelectorAll('datalist')].map((l) => l.id);
    expect(new Set([...ids(a), ...ids(b)]).size).toBe(4);
  });
});

describe('a panel whose card is gone', () => {
  it('ignores a late blur of the title box', async () => {
    sb = await createSandbox({ cards: [makeCard('OP-1')] });
    sb.ui.openCard('OP-1');
    await sb.settle();
    const title = drawerEl().querySelector<HTMLTextAreaElement>('.op-title-input')!;
    title.focus();
    title.value = 'typed, then the panel closed';
    click(drawerEl().querySelector('button[aria-label="Close"]')!);
    await sb.settle();
    const before = new Map(sb.storage.files);
    title.blur(); // the browser reports the focus loss after the panel is already closed
    await sb.settle();
    expect(sb.storage.files).toEqual(before);
  });

  it('ignores the buttons of a closed panel', async () => {
    sb = await createSandbox({ cards: [makeCard('OP-1')] });
    sb.ui.openCard('OP-1');
    await sb.settle();
    click(drawerEl().querySelector('button[aria-label="Close"]')!);
    await sb.settle();
    click(drawerEl().querySelector('button[aria-label="Delete"]')!);
    click(drawerEl().querySelector('button[aria-label="Open note"]')!);
    click(drawerEl().querySelector('.op-key-btn')!);
    await sb.settle();
    expect(sb.platform.confirm).not.toHaveBeenCalled();
    expect(sb.platform.openNote).not.toHaveBeenCalled();
    expect(sb.platform.copy).not.toHaveBeenCalled();
    expect(sb.store.get('OP-1')).toBeDefined();
  });

  it('ignores field changes made after it closed', async () => {
    sb = await createSandbox({ cards: [makeCard('OP-1')] });
    sb.ui.openCard('OP-1');
    await sb.settle();
    const select = drawerEl().querySelector<HTMLSelectElement>('.op-fields select')!;
    click(drawerEl().querySelector('button[aria-label="Close"]')!);
    await sb.settle();
    const before = new Map(sb.storage.files);
    change(select, 'doing');
    await sb.settle();
    expect(sb.storage.files).toEqual(before);
  });
});

describe('errors that are not Error objects', () => {
  it('are reported with their text, by the details panel', async () => {
    sb = await createSandbox({ cards: [makeCard('OP-1')] });
    sb.ui.openCard('OP-1');
    await sb.settle();
    sb.storage.modify = () => Promise.reject('a plain string');
    change(drawerEl().querySelectorAll<HTMLSelectElement>('.op-fields select')[1]!, 'lowest');
    await sb.settle();
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: a plain string');
  });

  it('are reported with their text, by the comments panel', async () => {
    sb = await createSandbox({
      cards: [makeCard('OP-1', { comments: [{ id: 'c', author: 'Bo', at: '', text: '- [ ] task' }] })],
    });
    sb.ui.openCard('OP-1');
    await sb.settle();
    sb.storage.modify = () => Promise.reject({ toString: () => 'odd failure' });
    click(drawerEl().querySelector('.op-comment-body input[type="checkbox"]')!);
    await sb.settle();
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: odd failure');
  });

  it('are reported with their text, by the menu actions of the board', async () => {
    sb = await createSandbox({ cards: [makeCard('OP-1')] });
    sb.storage.modify = () => Promise.reject(404);
    sb.card('OP-1')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    sb.platform.pick('Priority: Highest');
    await sb.settle();
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: 404');
  });
});

describe('comment thread edge cases', () => {
  it('a click on the comment text (not on a checkbox) does nothing', async () => {
    sb = await createSandbox({
      cards: [makeCard('OP-1', { comments: [{ id: 'c', author: 'Bo', at: '', text: 'plain words' }] })],
    });
    sb.ui.openCard('OP-1');
    await sb.settle();
    const before = new Map(sb.storage.files);
    const event = click(drawerEl().querySelector('.op-comment-body p')!);
    await sb.settle();
    expect(event.defaultPrevented).toBe(false);
    expect(sb.storage.files).toEqual(before);
  });

  it('can be used on its own: bind(), reset() and release()', async () => {
    sb = await createSandbox({ cards: [makeCard('OP-1')], mount: false });
    const panel = new CommentsPanel(sb.host);
    document.body.append(panel.el);
    panel.bind(sb.store.get('OP-1')!);
    expect(text(panel.el.querySelector('.op-comments-empty'))).toBe('No comments yet');
    panel.reset();
    panel.release();
    expect(sb.platform.releaseMarkdown).toHaveBeenCalledWith(panel.el.querySelector('.op-comment-list'));
  });
});

describe('popover in a very narrow window', () => {
  it('keeps the list inside the left margin even when the window is narrower than the list', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect({ top: 10, left: 120, width: 40, height: 20 }));
    Object.defineProperty(window, 'innerWidth', { value: 150, configurable: true });
    try {
      openPopover({ anchor, options: [{ value: 'a', label: 'A' }], selected: [], multi: true, onChange: vi.fn() });
      expect(document.querySelector<HTMLElement>('.op-pop')!.style.left).toBe('8px');
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
      anchor.remove();
    }
  });
});

describe('drags that start or end somewhere unexpected', () => {
  it('a drag hovering outside every column is not accepted as a drop target', async () => {
    sb = await createSandbox();
    drag(sb.card(sb.keys('todo')[0]!)!, 'dragstart');
    const event = drag(sb.container.querySelector('.op-board')!, 'dragover', { clientY: 10 });
    expect(event.defaultPrevented).toBe(false);
  });
});
