// @vitest-environment jsdom
import type { Placement } from '@oprojects/core';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DragController, type DragHooks } from '../src/ui/dnd';
import { drag, fakeDataTransfer, installDomStubs, layoutRows, rect } from './helpers/dom';

installDomStubs();

/** Rows are 80px tall with an 8px gap: card i spans [88i, 88i+80], midpoint 88i+40. */
const mid = (i: number) => 88 * i + 40;

let root: HTMLElement;
let controller: DragController;
let hooks: { [K in keyof DragHooks]: Mock<DragHooks[K]> };

function board(columns: Record<string, string[]>): void {
  root = document.createElement('div');
  for (const [id, keys] of Object.entries(columns)) {
    const col = document.createElement('section');
    col.className = 'op-col';
    col.dataset.col = id;
    const list = document.createElement('div');
    list.className = 'op-col-list';
    for (const key of keys) {
      const card = document.createElement('div');
      card.className = 'op-card';
      card.dataset.key = key;
      card.append(Object.assign(document.createElement('span'), { className: 'op-card-title' }));
      list.append(card);
    }
    const line = document.createElement('div');
    line.className = 'op-drop-line';
    line.hidden = true;
    col.append(list, line);
    root.append(col);
    layoutRows(list);
  }
  document.body.append(root);
}

const card = (key: string) => root.querySelector<HTMLElement>(`.op-card[data-key="${key}"]`)!;
const col = (id: string) => root.querySelector<HTMLElement>(`.op-col[data-col="${id}"]`)!;
const frame = () => vi.advanceTimersByTimeAsync(20);

/** Pick a card up, hover a column at `y`, let the frame run, and (optionally) drop. */
async function dragTo(key: string, columnId: string, y: number, opts: { drop?: boolean } = {}): Promise<void> {
  drag(card(key), 'dragstart');
  drag(col(columnId), 'dragover', { clientY: y });
  await frame();
  if (opts.drop !== false) drag(col(columnId), 'drop', { clientY: y });
}

beforeEach(() => {
  vi.useFakeTimers();
  hooks = {
    onStart: vi.fn<DragHooks['onStart']>(),
    onEnd: vi.fn<DragHooks['onEnd']>(),
    onDrop: vi.fn<DragHooks['onDrop']>(),
  };
  board({ todo: ['a', 'b', 'c'], doing: ['d'], empty: [] });
  controller = new DragController(root, hooks);
});

afterEach(() => {
  controller.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const dropped = (): [string, string, Placement] => hooks.onDrop.mock.calls.at(-1)!;

describe('starting a drag', () => {
  it('records the card in the data transfer, allows moving, and tells the board', () => {
    const dt = fakeDataTransfer();
    drag(card('b').querySelector('.op-card-title')!, 'dragstart', { dataTransfer: dt }); // grabbing the title counts
    expect(dt.effectAllowed).toBe('move');
    expect(dt.getData('text/plain')).toBe('b');
    expect(root.classList.contains('op-is-dragging')).toBe(true);
    expect(hooks.onStart).toHaveBeenCalledTimes(1);
  });

  it('dims the dragged card only after the browser has taken the drag image (next frame)', async () => {
    drag(card('b'), 'dragstart');
    expect(card('b').classList.contains('op-dragging')).toBe(false);
    await frame();
    expect(card('b').classList.contains('op-dragging')).toBe(true);
  });

  it('ignores drags that start outside a card or without a data transfer', () => {
    drag(col('todo'), 'dragstart');
    drag(card('a'), 'dragstart', { dataTransfer: null });
    expect(hooks.onStart).not.toHaveBeenCalled();
    expect(root.classList.contains('op-is-dragging')).toBe(false);
  });

  it('does not react to dragover or drop when no card of ours is being dragged', async () => {
    const over = drag(col('todo'), 'dragover', { clientY: 10 });
    const drop = drag(col('todo'), 'drop', { clientY: 10 });
    await frame();
    expect(over.defaultPrevented).toBe(false); // e.g. a file dragged in from the desktop is not ours to accept
    expect(drop.defaultPrevented).toBe(false);
    expect(hooks.onDrop).not.toHaveBeenCalled();
  });
});

describe('hovering', () => {
  it('accepts the drop over a column and signals a move', () => {
    drag(card('a'), 'dragstart');
    const dt = fakeDataTransfer();
    const event = drag(col('doing'), 'dragover', { clientY: 10, dataTransfer: dt });
    expect(event.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe('move');
  });

  it('shows the drop line and highlights the column, after the frame', async () => {
    drag(card('a'), 'dragstart');
    drag(col('doing'), 'dragover', { clientY: 10 });
    expect(col('doing').querySelector<HTMLElement>('.op-drop-line')!.hidden).toBe(true); // nothing is written before the frame
    await frame();
    expect(col('doing').querySelector<HTMLElement>('.op-drop-line')!.hidden).toBe(false);
    expect(col('doing').classList.contains('op-col-over')).toBe(true);
  });

  it('moves the highlight and hides the old line when the pointer changes column', async () => {
    drag(card('a'), 'dragstart');
    drag(col('doing'), 'dragover', { clientY: 10 });
    await frame();
    drag(col('empty'), 'dragover', { clientY: 10 });
    await frame();
    expect(col('doing').classList.contains('op-col-over')).toBe(false);
    expect(col('doing').querySelector<HTMLElement>('.op-drop-line')!.hidden).toBe(true);
    expect(col('empty').classList.contains('op-col-over')).toBe(true);
    expect(col('empty').querySelector<HTMLElement>('.op-drop-line')!.hidden).toBe(false);
  });

  it('measures at most once per frame however many dragover events arrive', async () => {
    drag(card('a'), 'dragstart');
    const measure = card('b').getBoundingClientRect as ReturnType<typeof vi.fn>;
    for (let i = 0; i < 25; i++) drag(col('todo'), 'dragover', { clientY: i * 10 });
    await frame();
    expect(measure).toHaveBeenCalledTimes(1);
    drag(col('todo'), 'dragover', { clientY: 5 });
    await frame();
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('uses the latest pointer position of the frame', async () => {
    drag(card('a'), 'dragstart');
    drag(col('doing'), 'dragover', { clientY: 1 });
    drag(col('doing'), 'dragover', { clientY: 500 }); // far below the only card
    await frame();
    drag(col('doing'), 'drop', { clientY: 500 });
    expect(dropped()).toEqual(['a', 'doing', { after: 'd' }]);
  });

  it('places the line above the card it will land before, and below the last card at the end', async () => {
    for (const list of root.querySelectorAll<HTMLElement>('.op-col-list')) {
      list.style.rowGap = '8px';
      [...list.children].forEach((c, i) => {
        Object.defineProperty(c, 'offsetTop', { value: 88 * i, configurable: true });
        Object.defineProperty(c, 'offsetHeight', { value: 80, configurable: true });
      });
    }
    drag(card('a'), 'dragstart');
    const line = () => col('todo').querySelector<HTMLElement>('.op-drop-line')!;
    drag(col('todo'), 'dragover', { clientY: mid(2) - 10 }); // lands before c (a is excluded, so the cards are b and c)
    await frame();
    expect(line().style.transform).toBe('translateY(172px)'); // c.offsetTop (176) minus half the gap (4)
    drag(col('todo'), 'dragover', { clientY: 900 }); // below everything: after c
    await frame();
    expect(line().style.transform).toBe('translateY(260px)'); // c.offsetTop + c.offsetHeight + half the gap
  });

  it('keeps the line from going above the top of an empty column', async () => {
    drag(card('a'), 'dragstart');
    drag(col('empty'), 'dragover', { clientY: 10 });
    await frame();
    expect(col('empty').querySelector<HTMLElement>('.op-drop-line')!.style.transform).toBe('translateY(0px)');
  });
});

describe('where the card lands', () => {
  it.each<[string, string, number, Placement]>([
    ['above the first card of another column', 'doing', 5, { before: 'd' }],
    ['below the last card of another column', 'doing', 400, { after: 'd' }],
    ['into an empty column', 'empty', 40, {}],
  ])('dropping %s', async (_what, columnId, y, placement) => {
    await dragTo('a', columnId, y);
    expect(hooks.onDrop).toHaveBeenCalledTimes(1);
    expect(dropped()).toEqual(['a', columnId, placement]);
  });

  it("lands between two cards by the pointer's position against their midpoints", async () => {
    await dragTo('d', 'todo', mid(1) - 1); // just above b's midpoint
    expect(dropped()).toEqual(['d', 'todo', { before: 'b' }]);
    hooks.onDrop.mockClear();
    drag(card('d'), 'dragend');
    await dragTo('d', 'todo', mid(1) + 1); // just below it
    expect(dropped()).toEqual(['d', 'todo', { before: 'c' }]);
  });

  it('reordering ignores the dragged card itself when measuring', async () => {
    await dragTo('a', 'todo', mid(2) + 1); // below c's midpoint: the end
    expect(dropped()).toEqual(['a', 'todo', { after: 'c' }]);
  });

  it('moving a card up or down inside its column reports the neighbor', async () => {
    await dragTo('c', 'todo', 5);
    expect(dropped()).toEqual(['c', 'todo', { before: 'a' }]);
    hooks.onDrop.mockClear();
    drag(card('c'), 'dragend');
    await dragTo('a', 'todo', 500);
    expect(dropped()).toEqual(['a', 'todo', { after: 'c' }]);
  });

  it.each([
    ['b', mid(1) + 20, 'its own slot (just before the card that follows it)'],
    ['c', 600, 'the bottom of the column when it is already last'],
    ['a', 5, 'the top of the column when it is already first'],
  ])('dropping %s back where it was (%#) changes nothing', async (key, y, _what) => {
    await dragTo(key, 'todo', y);
    expect(hooks.onDrop).not.toHaveBeenCalled();
  });

  it('dropping the only card of a column onto its own column is a no-op', async () => {
    await dragTo('d', 'doing', 10);
    expect(hooks.onDrop).not.toHaveBeenCalled();
  });

  it('a drop with no preceding dragover has no target and does nothing, but is still accepted', () => {
    drag(card('a'), 'dragstart');
    const event = drag(col('doing'), 'drop', { clientY: 10 });
    expect(event.defaultPrevented).toBe(true);
    expect(hooks.onDrop).not.toHaveBeenCalled();
  });

  it('computes the target at drop time when the frame has not run yet', () => {
    drag(card('a'), 'dragstart');
    drag(col('doing'), 'dragover', { clientY: 5 }); // the rAF is still pending
    drag(col('doing'), 'drop');
    expect(dropped()).toEqual(['a', 'doing', { before: 'd' }]);
  });

  it('a pending frame does not run again after the drop', async () => {
    drag(card('a'), 'dragstart');
    drag(col('doing'), 'dragover', { clientY: 5 });
    drag(col('doing'), 'drop');
    const measure = card('d').getBoundingClientRect as ReturnType<typeof vi.fn>;
    const measuredAtDrop = measure.mock.calls.length; // the drop itself measures once, to get the final position
    await frame();
    expect(measure.mock.calls.length).toBe(measuredAtDrop);
  });
});

describe('leaving and ending', () => {
  it('leaving the column clears the highlight, the line, and the target', async () => {
    drag(card('a'), 'dragstart');
    drag(col('doing'), 'dragover', { clientY: 5 });
    await frame();
    drag(col('doing'), 'dragleave', { relatedTarget: document.body });
    expect(col('doing').classList.contains('op-col-over')).toBe(false);
    expect(col('doing').querySelector<HTMLElement>('.op-drop-line')!.hidden).toBe(true);
    drag(card('a'), 'dragend'); // released in the gap between columns: the browser sends no drop, only the end
    expect(hooks.onDrop).not.toHaveBeenCalled();
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  });

  it('moving onto a child of the same column is not leaving it', async () => {
    drag(card('a'), 'dragstart');
    drag(col('doing'), 'dragover', { clientY: 5 });
    await frame();
    drag(col('doing'), 'dragleave', { relatedTarget: card('d') });
    expect(col('doing').classList.contains('op-col-over')).toBe(true);
    expect(col('doing').querySelector<HTMLElement>('.op-drop-line')!.hidden).toBe(false);
  });

  it('leaving to nowhere (the pointer left the window) also clears it', async () => {
    drag(card('a'), 'dragstart');
    drag(col('doing'), 'dragover', { clientY: 5 });
    await frame();
    drag(col('doing'), 'dragleave', { relatedTarget: null });
    expect(col('doing').classList.contains('op-col-over')).toBe(false);
  });

  it('leaving when nothing is highlighted is harmless', () => {
    expect(() => drag(col('doing'), 'dragleave', { relatedTarget: null })).not.toThrow();
  });

  it('ending the drag restores everything and tells the board', async () => {
    drag(card('a'), 'dragstart');
    await frame();
    drag(col('doing'), 'dragover', { clientY: 5 });
    await frame();
    drag(card('a'), 'dragend');
    expect(card('a').classList.contains('op-dragging')).toBe(false);
    expect(root.classList.contains('op-is-dragging')).toBe(false);
    expect(col('doing').classList.contains('op-col-over')).toBe(false);
    expect([...root.querySelectorAll('.op-drop-line')].every((l) => l.hasAttribute('hidden'))).toBe(true);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  });

  it('after the drag ends, hovering is ignored until the next one starts', async () => {
    drag(card('a'), 'dragstart');
    drag(card('a'), 'dragend');
    const event = drag(col('doing'), 'dragover', { clientY: 5 });
    await frame();
    expect(event.defaultPrevented).toBe(false);
    expect(col('doing').classList.contains('op-col-over')).toBe(false);
  });

  it('a drag that ends without a drop (Escape) cancels a pending frame', async () => {
    drag(card('a'), 'dragstart');
    drag(col('doing'), 'dragover', { clientY: 5 });
    const measure = card('d').getBoundingClientRect as ReturnType<typeof vi.fn>;
    drag(card('a'), 'dragend');
    await frame();
    expect(measure).not.toHaveBeenCalled();
    expect(hooks.onDrop).not.toHaveBeenCalled();
  });

  it('supports several drags in a row', async () => {
    await dragTo('a', 'doing', 5);
    drag(card('a'), 'dragend');
    await dragTo('b', 'empty', 5);
    drag(card('b'), 'dragend');
    expect(hooks.onDrop.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['a', 'doing'],
      ['b', 'empty'],
    ]);
    expect(hooks.onStart).toHaveBeenCalledTimes(2);
    expect(hooks.onEnd).toHaveBeenCalledTimes(2);
  });
});

describe('destroy', () => {
  it('stops listening to every drag event', async () => {
    controller.destroy();
    drag(card('a'), 'dragstart');
    drag(col('doing'), 'dragover', { clientY: 5 });
    drag(col('doing'), 'drop');
    drag(card('a'), 'dragend');
    await frame();
    expect(hooks.onStart).not.toHaveBeenCalled();
    expect(hooks.onDrop).not.toHaveBeenCalled();
    expect(hooks.onEnd).not.toHaveBeenCalled();
  });

  it('cancels a pending frame', async () => {
    drag(card('a'), 'dragstart');
    drag(col('doing'), 'dragover', { clientY: 5 });
    controller.destroy();
    await frame();
    expect(col('doing').classList.contains('op-col-over')).toBe(false);
  });
});

describe('geometry helpers used by the tests', () => {
  it('rect() builds a complete DOMRect-like value', () => {
    expect(rect({ top: 10, left: 5, width: 20, height: 30 })).toMatchObject({ x: 5, y: 10, right: 25, bottom: 40 });
  });
});
