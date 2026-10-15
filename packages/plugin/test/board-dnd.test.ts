// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drag, layoutRows, text } from './helpers/dom';
import { createSandbox, type Sandbox } from './helpers/sandbox';

let sb: Sandbox;
beforeEach(async () => {
  sb = await createSandbox();
  for (const list of sb.container.querySelectorAll<HTMLElement>('.op-col-list')) layoutRows(list);
});
afterEach(() => sb.dispose());

const mid = (i: number) => 88 * i + 40; // card i of a column, given rows of 80px with an 8px gap
const col = (id: string) => sb.column(id);
const shownTitle = (key: string) => text(sb.card(key)?.querySelector('.op-card-title'));

/** Pick a card up and hover a column at `y`. */
async function hover(key: string, columnId: string, y: number) {
  drag(sb.card(key)!, 'dragstart');
  drag(col(columnId), 'dragover', { clientY: y });
  await sb.settle();
}

describe('dragging a card on the board', () => {
  it('dropping into another column moves the card there, at the dropped position', async () => {
    const [first, second] = sb.keys('review');
    const moving = sb.keys('todo')[0]!;
    await hover(moving, 'review', mid(1) - 1); // between the two cards of "In review"
    drag(col('review'), 'drop', { clientY: mid(1) - 1 });
    drag(sb.card(moving)!, 'dragend');
    await sb.settle();
    expect(sb.store.get(moving)!.status).toBe('review');
    expect(sb.keys('review')).toEqual([first, moving, second]);
    expect(sb.note(moving)).toContain('status: review');
  });

  it('dropping below the last card puts the card at the bottom', async () => {
    const moving = sb.keys('todo')[0]!;
    await hover(moving, 'done', 5000);
    drag(col('done'), 'drop');
    drag(sb.card(moving)!, 'dragend');
    await sb.settle();
    expect(sb.keys('done').at(-1)).toBe(moving);
  });

  it('dropping into an empty column works', async () => {
    for (const key of sb.keys('review')) await sb.host.move(key, 'todo');
    await sb.settle();
    for (const list of sb.container.querySelectorAll<HTMLElement>('.op-col-list')) layoutRows(list);
    const moving = sb.keys('todo')[0]!;
    await hover(moving, 'review', 10);
    drag(col('review'), 'drop');
    drag(sb.card(moving)!, 'dragend');
    await sb.settle();
    expect(sb.keys('review')).toEqual([moving]);
  });

  it('reordering inside a column writes only the moved note', async () => {
    const [a, b, c] = sb.keys('todo');
    const before = new Map(sb.storage.files);
    await hover(c!, 'todo', 5); // to the very top
    drag(col('todo'), 'drop');
    drag(sb.card(c!)!, 'dragend');
    await sb.settle();
    expect(sb.keys('todo').slice(0, 3)).toEqual([c, a, b]);
    const changed = [...sb.storage.files].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);
    expect(changed).toEqual([`Cards/${c}.md`]);
  });

  it('gives the dropped card the keyboard focus', async () => {
    const moving = sb.keys('todo')[0]!;
    await hover(moving, 'doing', 5);
    drag(col('doing'), 'drop');
    drag(sb.card(moving)!, 'dragend');
    await sb.settle();
    expect(document.activeElement).toBe(sb.card(moving));
  });

  it('dropping a card back where it was does not write anything', async () => {
    const [first] = sb.keys('todo');
    const before = new Map(sb.storage.files);
    await hover(first!, 'todo', 5);
    drag(col('todo'), 'drop');
    drag(sb.card(first!)!, 'dragend');
    await sb.settle();
    expect(sb.storage.files).toEqual(before);
  });

  it('a drop that fails is reported, and the card is back where it was', async () => {
    const moving = sb.keys('todo')[0]!;
    const original = sb.store.get(moving)!;
    sb.storage.modify = () => Promise.reject(new Error('disk full'));
    await hover(moving, 'doing', 5);
    drag(col('doing'), 'drop');
    drag(sb.card(moving)!, 'dragend');
    await sb.settle();
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: disk full');
    expect(sb.store.get(moving)).toBe(original);
    expect(sb.keys('todo')).toContain(moving);
  });

  it('a failure that is not an Error object is still reported', async () => {
    const moving = sb.keys('todo')[0]!;
    sb.storage.modify = () => Promise.reject('plain string failure');
    await hover(moving, 'doing', 5);
    drag(col('doing'), 'drop');
    drag(sb.card(moving)!, 'dragend');
    await sb.settle();
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: plain string failure');
  });
});

describe('the board while a drag is in progress', () => {
  it('holds back re-rendering so the dragged card is not pulled from under the pointer', async () => {
    const dragged = sb.keys('todo')[0]!;
    const other = sb.keys('todo')[1]!;
    const el = sb.card(dragged)!;
    drag(el, 'dragstart');
    sb.store.apply({ ...sb.store.get(other)!, title: 'changed during the drag' });
    sb.store.apply({ ...sb.store.get(dragged)!, title: 'also changed' });
    await sb.settle();
    expect(shownTitle(other)).not.toBe('changed during the drag');
    expect(sb.card(dragged)).toBe(el);
    expect(shownTitle(dragged)).not.toBe('also changed');
  });

  it('catches up as soon as the drag ends', async () => {
    const dragged = sb.keys('todo')[0]!;
    const other = sb.keys('todo')[1]!;
    drag(sb.card(dragged)!, 'dragstart');
    sb.store.apply({ ...sb.store.get(other)!, title: 'changed during the drag' });
    await sb.settle();
    drag(sb.card(dragged)!, 'dragend');
    await sb.settle();
    expect(shownTitle(other)).toBe('changed during the drag');
  });

  it('does not re-render needlessly when nothing changed during the drag', async () => {
    const dragged = sb.keys('todo')[0]!;
    drag(sb.card(dragged)!, 'dragstart');
    const first = sb.card(sb.keys('todo')[1]!)!.firstElementChild;
    drag(sb.card(dragged)!, 'dragend');
    await sb.settle();
    expect(sb.card(sb.keys('todo')[1]!)!.firstElementChild).toBe(first);
  });

  it('applies a drag-time change even to a card that was removed, once the drag is over', async () => {
    const dragged = sb.keys('todo')[0]!;
    const victim = sb.keys('todo')[2]!;
    drag(sb.card(dragged)!, 'dragstart');
    sb.store.remove(victim);
    await sb.settle();
    expect(sb.card(victim)).not.toBeNull(); // still on screen during the drag
    drag(sb.card(dragged)!, 'dragend');
    await sb.settle();
    expect(sb.card(victim)).toBeNull();
  });

  it('stops listening for drags when the board is destroyed', async () => {
    const dragged = sb.keys('todo')[0]!;
    const root = sb.ui.el;
    sb.ui.destroy();
    drag(root.querySelector('.op-card[data-key="' + dragged + '"]')!, 'dragstart');
    expect(root.classList.contains('op-is-dragging')).toBe(false);
  });
});
