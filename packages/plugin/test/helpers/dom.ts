// Helpers for driving the UI under jsdom: the few browser features jsdom lacks, and event builders.
import { vi } from 'vitest';

/** Fake `DataTransfer`, enough for the drag controller. */
export interface FakeDataTransfer {
  effectAllowed: string;
  dropEffect: string;
  data: Map<string, string>;
  setData(type: string, value: string): void;
  getData(type: string): string;
}

export function fakeDataTransfer(): FakeDataTransfer {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    data,
    setData: (type, value) => void data.set(type, value),
    getData: (type) => data.get(type) ?? '',
  };
}

/** Pointer capture is not implemented by jsdom: track it per element so `hasPointerCapture` is truthful. */
const captured = new WeakMap<Element, Set<number>>();

/** Install the stubs once per test file (they are cheap and idempotent). */
export function installDomStubs(): void {
  const el = Element.prototype as unknown as Record<string, unknown>;
  el.scrollIntoView = vi.fn();
  el.setPointerCapture = function (this: Element, id: number) {
    const set = captured.get(this) ?? new Set<number>();
    set.add(id);
    captured.set(this, set);
  };
  el.hasPointerCapture = function (this: Element, id: number) {
    return captured.get(this)?.has(id) ?? false;
  };
  el.releasePointerCapture = function (this: Element, id: number) {
    captured.get(this)?.delete(id);
  };
}

type KeyInit = Pick<KeyboardEventInit, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>;

/** Dispatch a bubbling, cancelable keydown. Returns the event so tests can read `defaultPrevented`. */
export function key(target: Element | Document, k: string, init: KeyInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

export function click(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

export function dblclick(target: Element): void {
  target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
}

export function contextMenu(target: Element, x = 10, y = 20): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y });
  target.dispatchEvent(event);
  return event;
}

/** Type into a text control the way a user does: set the value, fire `input`. */
export function typeInto(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Change a select / date / number control: set the value, fire `change`. */
export function change(control: HTMLInputElement | HTMLSelectElement, value: string): void {
  control.value = value;
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

export function pointer(
  target: Element,
  kind: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: PointerEventInit = {},
): PointerEvent {
  const event = new PointerEvent(kind, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...init });
  target.dispatchEvent(event);
  return event;
}

/** Fire a native drag event (jsdom has no `DragEvent`): a plain event carrying the fields the controller reads. */
export function drag(
  target: Element,
  kind: 'dragstart' | 'dragover' | 'dragleave' | 'drop' | 'dragend',
  init: { dataTransfer?: FakeDataTransfer | null; clientY?: number; relatedTarget?: Node | null } = {},
): Event {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: init.dataTransfer === undefined ? fakeDataTransfer() : init.dataTransfer },
    clientY: { value: init.clientY ?? 0 },
    relatedTarget: { value: init.relatedTarget ?? null },
  });
  target.dispatchEvent(event);
  return event;
}

/** Give each child of `list` a vertical slot so `getBoundingClientRect` reports real geometry (jsdom has none). */
export function layoutRows(list: HTMLElement, rowHeight = 80, gap = 8): void {
  [...list.children].forEach((child, i) => {
    const top = i * (rowHeight + gap);
    vi.spyOn(child, 'getBoundingClientRect').mockReturnValue(rect({ top, height: rowHeight, width: 260 }));
  });
}

export function rect(r: Partial<DOMRect> & { top?: number; left?: number; width?: number; height?: number }): DOMRect {
  const top = r.top ?? 0;
  const left = r.left ?? 0;
  const width = r.width ?? 0;
  const height = r.height ?? 0;
  return { x: left, y: top, top, left, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) };
}

/** Make an element report a width (for the resize handle, which measures the panel and its parent). */
export function setWidth(el: Element, width: number): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect({ width, height: 600 }));
}

export const text = (el: Element | null | undefined): string => el?.textContent?.trim() ?? '';

/** Visible text of every match, in document order. */
export const texts = (root: ParentNode, selector: string): string[] =>
  [...root.querySelectorAll(selector)].map((e) => text(e));
