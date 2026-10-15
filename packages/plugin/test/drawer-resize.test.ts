// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, dblclick, key, pointer, rect } from './helpers/dom';
import { createSandbox, makeCard, type Sandbox } from './helpers/sandbox';

const DEFAULT_WIDTH = 420;
const HOST_WIDTH = 1000;

let sb: Sandbox;

/** jsdom has no layout: report the panel's width from its CSS variable, and a fixed width for the pane around it. */
function layout(drawer: HTMLElement) {
  vi.spyOn(drawer, 'getBoundingClientRect').mockImplementation(() =>
    rect({ width: parseFloat(drawer.style.getPropertyValue('--op-drawer-w')) || DEFAULT_WIDTH, height: 600 }),
  );
  vi.spyOn(drawer.parentElement!, 'getBoundingClientRect').mockReturnValue(rect({ width: HOST_WIDTH, height: 600 }));
}

const drawer = () => sb.container.querySelector<HTMLElement>('.op-drawer')!;
const handle = () => drawer().querySelector<HTMLElement>('.op-drawer-resizer')!;
const root = () => sb.container.querySelector<HTMLElement>('.op-root')!;
const widthVar = () => drawer().style.getPropertyValue('--op-drawer-w');
const savedWidth = () => sb.states.at(-1)?.drawerWidth;

async function boot(state?: unknown) {
  sb = await createSandbox({ cards: [makeCard('OP-1'), makeCard('OP-2')], state });
  layout(drawer());
  sb.ui.openCard('OP-1');
  await sb.settle();
}

afterEach(() => sb.dispose());

describe('the resize handle', () => {
  beforeEach(() => boot());

  it('is an accessible, keyboard-focusable vertical separator', () => {
    expect(handle().getAttribute('role')).toBe('separator');
    expect(handle().getAttribute('aria-orientation')).toBe('vertical');
    expect(handle().getAttribute('aria-label')).toBe('Resize panel (double-click to reset)');
    expect(handle().title).toBe('Resize panel (double-click to reset)');
    expect(handle().tabIndex).toBe(0);
  });

  it('starts at the default width (no inline width at all)', () => {
    expect(widthVar()).toBe('');
    expect(savedWidth()).toBeUndefined();
  });
});

describe('dragging with the pointer', () => {
  beforeEach(() => boot());

  it('dragging left widens the panel by the distance, and saves the width when released', () => {
    pointer(handle(), 'pointerdown', { clientX: 600 });
    expect(root().classList.contains('op-resizing')).toBe(true);
    pointer(handle(), 'pointermove', { clientX: 500 });
    expect(widthVar()).toBe('520px');
    pointer(handle(), 'pointermove', { clientX: 450 });
    expect(widthVar()).toBe('570px');
    expect(savedWidth()).toBeUndefined(); // not on every pixel
    pointer(handle(), 'pointerup', { clientX: 450 });
    expect(savedWidth()).toBe(570);
    expect(root().classList.contains('op-resizing')).toBe(false);
  });

  it('dragging right narrows it', () => {
    pointer(handle(), 'pointerdown', { clientX: 600 });
    pointer(handle(), 'pointermove', { clientX: 680 });
    pointer(handle(), 'pointerup', { clientX: 680 });
    expect(widthVar()).toBe('340px');
    expect(savedWidth()).toBe(340);
  });

  it('never goes narrower than 300px', () => {
    pointer(handle(), 'pointerdown', { clientX: 600 });
    pointer(handle(), 'pointermove', { clientX: 5000 });
    pointer(handle(), 'pointerup', { clientX: 5000 });
    expect(widthVar()).toBe('300px');
  });

  it('never leaves less than 260px for the board', () => {
    pointer(handle(), 'pointerdown', { clientX: 600 });
    pointer(handle(), 'pointermove', { clientX: -5000 });
    pointer(handle(), 'pointerup', { clientX: -5000 });
    expect(widthVar()).toBe(`${HOST_WIDTH - 260}px`);
  });

  it('may cover the whole pane when the panel overlays the board (narrow panes)', () => {
    drawer().style.position = 'absolute';
    pointer(handle(), 'pointerdown', { clientX: 600 });
    pointer(handle(), 'pointermove', { clientX: -5000 });
    pointer(handle(), 'pointerup', { clientX: -5000 });
    expect(widthVar()).toBe(`${HOST_WIDTH}px`);
  });

  it('a pane narrower than the minimum still gives the panel its minimum', () => {
    vi.mocked(drawer().parentElement!.getBoundingClientRect).mockReturnValue(rect({ width: 200, height: 600 }));
    pointer(handle(), 'pointerdown', { clientX: 100 });
    pointer(handle(), 'pointermove', { clientX: 0 });
    pointer(handle(), 'pointerup', { clientX: 0 });
    expect(widthVar()).toBe('300px');
  });

  it('captures the pointer so the drag survives leaving the handle, and releases it at the end', () => {
    pointer(handle(), 'pointerdown', { clientX: 600, pointerId: 7 });
    expect(handle().hasPointerCapture(7)).toBe(true);
    pointer(handle(), 'pointerup', { pointerId: 7 });
    expect(handle().hasPointerCapture(7)).toBe(false);
  });

  it('keeps the browser from starting a text selection when you press the handle', () => {
    expect(pointer(handle(), 'pointerdown', { clientX: 600 }).defaultPrevented).toBe(true);
  });

  it('a cancelled pointer (touch interrupted) ends the drag and saves like a release', () => {
    pointer(handle(), 'pointerdown', { clientX: 600 });
    pointer(handle(), 'pointermove', { clientX: 550 });
    pointer(handle(), 'pointercancel');
    expect(savedWidth()).toBe(470);
    expect(root().classList.contains('op-resizing')).toBe(false);
    pointer(handle(), 'pointermove', { clientX: 300 }); // no longer dragging
    expect(widthVar()).toBe('470px');
  });

  it('only the primary button starts a drag', () => {
    const event = pointer(handle(), 'pointerdown', { clientX: 600, button: 2 });
    expect(event.defaultPrevented).toBe(false);
    expect(root().classList.contains('op-resizing')).toBe(false);
    pointer(handle(), 'pointermove', { clientX: 500 });
    expect(widthVar()).toBe('');
  });

  it('moving or releasing without having pressed does nothing', () => {
    pointer(handle(), 'pointermove', { clientX: 100 });
    pointer(handle(), 'pointerup', { clientX: 100 });
    expect(widthVar()).toBe('');
    expect(savedWidth()).toBeUndefined();
  });

  it('a second drag starts from the width the first one left', () => {
    pointer(handle(), 'pointerdown', { clientX: 600 });
    pointer(handle(), 'pointermove', { clientX: 500 });
    pointer(handle(), 'pointerup', { clientX: 500 });
    pointer(handle(), 'pointerdown', { clientX: 500 });
    pointer(handle(), 'pointermove', { clientX: 450 });
    pointer(handle(), 'pointerup', { clientX: 450 });
    expect(savedWidth()).toBe(570);
  });
});

describe('resizing with the keyboard', () => {
  beforeEach(() => boot());

  it('ArrowLeft widens by 16px and ArrowRight narrows by 16px, saving each time', () => {
    key(handle(), 'ArrowLeft');
    expect(widthVar()).toBe('436px');
    expect(savedWidth()).toBe(436);
    key(handle(), 'ArrowRight');
    key(handle(), 'ArrowRight');
    expect(widthVar()).toBe('404px');
    expect(savedWidth()).toBe(404);
  });

  it('Shift makes the step three times bigger', () => {
    key(handle(), 'ArrowLeft', { shiftKey: true });
    expect(widthVar()).toBe('468px');
    key(handle(), 'ArrowRight', { shiftKey: true });
    key(handle(), 'ArrowRight', { shiftKey: true });
    expect(widthVar()).toBe('372px');
  });

  it('stops at the limits', () => {
    for (let i = 0; i < 20; i++) key(handle(), 'ArrowRight', { shiftKey: true });
    expect(widthVar()).toBe('300px');
    for (let i = 0; i < 40; i++) key(handle(), 'ArrowLeft', { shiftKey: true });
    expect(widthVar()).toBe(`${HOST_WIDTH - 260}px`);
  });

  it('handles the keys itself so the board does not also react', () => {
    const outer = vi.fn();
    sb.container.addEventListener('keydown', outer);
    const event = key(handle(), 'ArrowLeft');
    expect(event.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
  });

  it('Home and Escape go back to the default width, and Escape does not close the panel', () => {
    key(handle(), 'ArrowLeft');
    const outer = vi.fn();
    sb.container.addEventListener('keydown', outer);
    key(handle(), 'Home');
    expect(widthVar()).toBe('');
    expect(savedWidth()).toBeNull();
    key(handle(), 'ArrowLeft');
    key(handle(), 'Escape');
    expect(widthVar()).toBe('');
    expect(savedWidth()).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect(drawer().hidden).toBe(false);
  });

  it('leaves other keys alone', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'a', 'Enter', 'Tab'])
      expect(key(handle(), k).defaultPrevented).toBe(false);
    expect(widthVar()).toBe('');
  });
});

describe('double click and persistence', () => {
  it('double-clicking the handle restores the default width', async () => {
    await boot();
    key(handle(), 'ArrowLeft', { shiftKey: true });
    dblclick(handle());
    expect(widthVar()).toBe('');
    expect(savedWidth()).toBeNull();
  });

  it('a double click never also counts as a drag or a click on the card behind it', async () => {
    await boot();
    pointer(handle(), 'pointerdown', { clientX: 500 });
    pointer(handle(), 'pointerup', { clientX: 500 });
    dblclick(handle());
    expect(sb.platform.openNote).not.toHaveBeenCalled();
  });

  it('restores the width saved with the view', async () => {
    await boot({ drawerWidth: 512 });
    expect(widthVar()).toBe('512px');
    expect(sb.ui.getState().drawerWidth).toBe(512);
  });

  it('ignores a nonsense saved width and uses the default', async () => {
    await boot({ drawerWidth: 12 });
    expect(widthVar()).toBe('');
  });

  it('applies a width set through the board state and clears it again', async () => {
    await boot();
    sb.ui.setState({ drawerWidth: 480 });
    expect(widthVar()).toBe('480px');
    sb.ui.setState({ drawerWidth: null });
    expect(widthVar()).toBe('');
  });

  it('keeps the width when the panel is closed and another card is opened', async () => {
    await boot();
    key(handle(), 'ArrowLeft', { shiftKey: true });
    key(sb.container.querySelector('.op-root')!, 'Escape');
    await sb.settle();
    sb.ui.openCard('OP-2');
    await sb.settle();
    expect(widthVar()).toBe('468px');
  });

  it('the saved width survives remounting the board with its saved state', async () => {
    await boot();
    key(handle(), 'ArrowLeft', { shiftKey: true });
    const state = sb.ui.getState();
    sb.mount(state);
    expect(widthVar()).toBe('468px');
  });

  it('clicking the handle does not open or close anything', async () => {
    await boot();
    click(handle());
    expect(drawer().hidden).toBe(false);
  });
});
